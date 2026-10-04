import type { ReadableStreamReadResult } from 'node:stream/web';

export interface StreamSource<T> extends Disposable {
  readonly stream: ReadableStream<T>;
  /** Last producer signal or consumer cancellation; closed chunks may still drain. */
  readonly state: 'open' | 'closed' | 'errored' | 'cancelled';
  enqueue(chunk: T): void;
  close(): void;
  error(reason: unknown): void;
}

export type StreamResult<T> =
  | { status: 'completed'; chunks: T[] }
  | { status: 'errored'; chunks: T[]; error: unknown };

export interface StreamReader<T> extends AsyncDisposable {
  read(): Promise<ReadableStreamReadResult<T>>;
  /** Collects the remaining chunks, preserving those read before a failure. */
  collectUntilError(): Promise<StreamResult<T>>;
}

export class StreamHarness {
  /** Creates an externally controlled producer. Disposal closes it if still open. */
  source<T>(): StreamSource<T> {
    let controller!: ReadableStreamDefaultController<T>;
    let state: StreamSource<T>['state'] = 'open';
    const stream = new ReadableStream<T>({
      start(value) {
        controller = value;
      },
      cancel() {
        state = 'cancelled';
      },
    });

    return {
      stream,
      get state() {
        return state;
      },
      enqueue(chunk) {
        controller.enqueue(chunk);
      },
      close() {
        controller.close();
        state = 'closed';
      },
      error(reason) {
        controller.error(reason);
        // Native error() can also discard chunks queued before close().
        if (controller.desiredSize === null) state = 'errored';
      },
      [Symbol.dispose]() {
        if (state === 'open') this.close();
      },
    };
  }

  /** Locks a stream without draining it. Disposal cancels and releases the lock. */
  reader<T>(stream: ReadableStream<T>): StreamReader<T> {
    const reader = stream.getReader();
    const closed = reader.closed.then(
      () => true,
      () => false,
    );
    const cleanup = new AsyncDisposableStack();
    cleanup.defer(() => reader.releaseLock());
    cleanup.defer(async () => {
      try {
        await reader.cancel();
      } catch (error) {
        // An already-errored stream rejects cancel(). Its error belongs to read();
        // a failing cancellation hook closes the stream and must still surface.
        if (await closed) throw error;
      }
    });

    return {
      read: () => reader.read(),
      async collectUntilError() {
        const chunks: T[] = [];
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) return { status: 'completed', chunks };
            chunks.push(value);
          }
        } catch (error) {
          return { status: 'errored', chunks, error };
        }
      },
      [Symbol.asyncDispose]: () => cleanup.disposeAsync(),
    };
  }
}
