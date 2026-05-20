import { createUIMessageStream } from 'ai';

import {
  type PersistedWriterOptions,
  persistedWriter,
} from '../stream-buffer.ts';
import type { StreamChange, StreamChangeSource } from './change-source.ts';
import type {
  ListStreamIdsOptions,
  StreamData,
  StreamStatus,
  StreamStore,
} from './stream-store.ts';
import type { StreamPart } from './types.ts';

function isTerminal(status: StreamStatus) {
  return status !== 'queued' && status !== 'running';
}

export interface PersistStreamOptions extends Pick<
  PersistedWriterOptions,
  'strategy' | 'flushSize'
> {
  onCancelDetected?: (info: {
    streamId: string;
    latencyMs: number | null;
  }) => void | Promise<void>;
}

export type StreamWatchTelemetryEvent =
  | {
      type: 'watch:chunks';
      streamId: string;
      delivered: number;
      lastSeq: number;
    }
  | {
      type: 'watch:closed';
      streamId: string;
      reason: 'terminal' | 'missing' | 'source-ended';
    }
  | {
      type: 'watch:error-emitted';
      streamId: string;
      errorTextLength: number;
    }
  | {
      type: 'persist:cancel-detected';
      streamId: string;
      latencyMs: number | null;
    };

export interface StreamManagerOptions {
  store: StreamStore;
  changeSource: StreamChangeSource;
  chunkPageSize?: number;
  onWatchEvent?: (event: StreamWatchTelemetryEvent) => void;
}

const DEFAULT_CHUNK_PAGE_SIZE = 128;

export class StreamManager {
  #store: StreamStore;
  #changeSource: StreamChangeSource;
  #chunkPageSize: number;
  #onWatchEvent?: (event: StreamWatchTelemetryEvent) => void;

  constructor(options: StreamManagerOptions) {
    this.#store = options.store;
    this.#changeSource = options.changeSource;
    this.#chunkPageSize = options.chunkPageSize ?? DEFAULT_CHUNK_PAGE_SIZE;
    this.#onWatchEvent = options.onWatchEvent;
  }

  get store(): StreamStore {
    return this.#store;
  }

  async register(
    streamId: string,
  ): Promise<{ stream: StreamData; created: boolean }> {
    return this.#store.upsertStream({
      id: streamId,
      status: 'queued',
      createdAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      cancelRequestedAt: null,
      error: null,
    });
  }

  async cancel(streamId: string): Promise<void> {
    await this.#store.updateStreamStatus(streamId, 'cancelled');
  }

  async listStreamIds(options?: ListStreamIdsOptions): Promise<string[]> {
    return this.#store.listStreamIds(options);
  }

  async persist(
    stream: ReadableStream,
    streamId: string,
    options?: PersistStreamOptions,
  ): Promise<{ streamId: string }> {
    const existing = await this.#store.getStream(streamId);
    if (existing && isTerminal(existing.status)) {
      return { streamId };
    }

    await this.#store.updateStreamStatus(streamId, 'running');

    const ac = new AbortController();
    const cancelWatcher = this.#runCancelWatcher(streamId, ac, options);

    let pw!: Awaited<ReturnType<typeof persistedWriter>>;

    const sink = createUIMessageStream({
      execute: async ({ writer }) => {
        pw = await persistedWriter({
          writer,
          store: this.#store,
          streamId,
          strategy: options?.strategy,
          flushSize: options?.flushSize,
        });
        pw.writer.merge(stream);
      },
    });

    try {
      await drain(sink, ac.signal);

      if (ac.signal.aborted) {
        if (pw) await pw.flush();
      } else {
        await pw.complete();
      }
    } catch (err) {
      if (ac.signal.aborted) {
        if (isAbortError(err)) {
          if (pw) await pw.flush();
        } else {
          throw err;
        }
      } else {
        const message = err instanceof Error ? err.message : String(err);
        if (pw) {
          await pw.fail(message);
        } else {
          await this.#store.updateStreamStatus(streamId, 'failed', {
            error: message,
          });
        }
        throw err;
      }
    } finally {
      if (!ac.signal.aborted) ac.abort();
      await cancelWatcher;
    }

    return { streamId: pw?.streamId ?? streamId };
  }

  async #runCancelWatcher(
    streamId: string,
    ac: AbortController,
    options: PersistStreamOptions | undefined,
  ): Promise<void> {
    try {
      for await (const change of this.#changeSource.subscribe(
        streamId,
        ac.signal,
      )) {
        if (change.kind === 'chunks') continue;
        const status = await this.#store.getStreamStatus(streamId);
        if (status === undefined) {
          ac.abort();
          return;
        }
        if (status === 'cancelled') {
          const current = await this.#store.getStream(streamId);
          const latencyMs =
            current?.cancelRequestedAt != null
              ? Math.max(0, Date.now() - current.cancelRequestedAt)
              : null;
          this.#emit({
            type: 'persist:cancel-detected',
            streamId,
            latencyMs,
          });
          if (options?.onCancelDetected) {
            try {
              await options.onCancelDetected({ streamId, latencyMs });
            } catch {
              /* best-effort — never block cancellation */
            }
          }
          ac.abort();
          return;
        }
      }
    } catch {
      /* cancel watcher failed unexpectedly — persist continues without cancel-detection */
    }
  }

  watch(streamId: string): ReadableStream<StreamPart> {
    const store = this.#store;
    const changeSource = this.#changeSource;
    const pageSize = this.#chunkPageSize;
    const emit = this.#emit.bind(this);
    const ac = new AbortController();
    const lastSeqRef = { value: -1 };
    let iterator: AsyncIterator<StreamChange> | undefined;

    const emitPage = (delivered: number, lastSeq: number): void => {
      emit({ type: 'watch:chunks', streamId, delivered, lastSeq });
    };

    const finalize = async (
      controller: ReadableStreamDefaultController<StreamPart>,
      reason: 'terminal' | 'missing' | 'source-ended',
      knownStatus?: StreamStatus,
    ): Promise<void> => {
      await drainAvailable(
        controller,
        store,
        streamId,
        lastSeqRef,
        pageSize,
        emitPage,
      );
      const finalStatus =
        knownStatus ?? (await store.getStreamStatus(streamId));
      if (finalStatus === 'failed') {
        const stream = await store.getStream(streamId);
        if (stream) {
          const errorText = stream.error || 'Stream failed';
          emit({
            type: 'watch:error-emitted',
            streamId,
            errorTextLength: errorText.length,
          });
          controller.enqueue({ type: 'error', errorText });
        }
      }
      emit({ type: 'watch:closed', streamId, reason });
      controller.close();
      ac.abort();
    };

    return new ReadableStream<StreamPart>({
      start: () => {
        iterator = changeSource
          .subscribe(streamId, ac.signal)
          [Symbol.asyncIterator]();
      },
      pull: async (controller) => {
        if (!iterator) return;
        while (!ac.signal.aborted) {
          let result: IteratorResult<StreamChange>;
          try {
            result = await iterator.next();
          } catch (error) {
            // ignore — iterator already terminated by an upstream throw
            iterator.return?.().catch(() => undefined);
            if (isAbortError(error)) return;
            throw error;
          }

          if (result.done) {
            await finalize(controller, 'source-ended');
            return;
          }

          const change = result.value;

          let delivered = 0;
          if (change.kind !== 'status') {
            delivered = await drainAvailable(
              controller,
              store,
              streamId,
              lastSeqRef,
              pageSize,
              emitPage,
            );
          }

          if (change.kind !== 'chunks') {
            const status = await store.getStreamStatus(streamId);
            if (status === undefined) {
              await finalize(controller, 'missing');
              return;
            }
            if (isTerminal(status)) {
              await finalize(controller, 'terminal', status);
              return;
            }
          }

          if (delivered > 0) return;
        }
      },
      cancel: () => {
        ac.abort();
        return iterator?.return?.().then(
          () => undefined,
          () => undefined,
        );
      },
    });
  }

  async reopen(
    streamId: string,
  ): Promise<{ stream: StreamData; created: boolean }> {
    const stream = await this.#store.reopenStream(streamId);
    return { stream, created: true };
  }

  async cleanup(streamId: string): Promise<void> {
    await this.#store.deleteStream(streamId);
  }

  #emit(event: StreamWatchTelemetryEvent): void {
    if (!this.#onWatchEvent) return;
    try {
      this.#onWatchEvent(event);
    } catch {
      // swallow telemetry errors — watch must not be coupled to observer faults
    }
  }
}

async function drainAvailable(
  controller: ReadableStreamDefaultController<StreamPart>,
  store: StreamStore,
  streamId: string,
  lastSeqRef: { value: number },
  pageSize: number,
  onPage?: (delivered: number, lastSeq: number) => void,
): Promise<number> {
  let total = 0;
  while (true) {
    const chunks = await store.getChunks(
      streamId,
      lastSeqRef.value + 1,
      pageSize,
    );
    if (chunks.length === 0) break;
    for (const chunk of chunks) {
      controller.enqueue(chunk.data as StreamPart);
      lastSeqRef.value = chunk.seq;
    }
    total += chunks.length;
    onPage?.(chunks.length, lastSeqRef.value);
    if (chunks.length < pageSize) break;
  }
  return total;
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'AbortError' || /aborted/i.test(error.message))
  );
}

async function drain(
  stream: ReadableStream,
  signal?: AbortSignal,
): Promise<void> {
  const reader = stream.getReader();
  const onAbort = () => reader.cancel();

  if (signal) {
    signal.addEventListener('abort', onAbort, { once: true });
  }

  try {
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
}
