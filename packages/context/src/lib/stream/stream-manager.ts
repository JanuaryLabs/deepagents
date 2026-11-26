import { Backoff } from '@zukhruf/async';
import { createUIMessageStream } from 'ai';
import { setTimeout as delay } from 'node:timers/promises';

import { persistedWriter } from '../stream-buffer.ts';
import type { StreamChange, StreamChangeSource } from './change-source.ts';
import type {
  ListStreamIdsOptions,
  StreamData,
  StreamStatus,
  StreamStore,
} from './stream-store.ts';
import type { StreamPart } from './types.ts';

const CANCEL_WATCHER_RETRY_MAX_MS = 500;
const CANCEL_WATCHER_RETRY = new Backoff({
  initial: 50,
  multiplier: 2,
  max: CANCEL_WATCHER_RETRY_MAX_MS,
  jitter: { kind: 'ratio', ratio: 0.15 },
});

/** Reading when cancellation was requested failed; cancellation goes on without its latency. */
class CancelLatencyReadWarning extends Error {
  readonly code = 'DEEPAGENTS_CONTEXT_CANCEL_LATENCY_READ_FAILED';
  readonly detail: string;

  constructor(failure: unknown, streamId: string) {
    super(
      `Reading when cancellation was requested failed, and cancellation goes on without its latency: ${Error.isError(failure) ? failure.message : String(failure)}`,
      { cause: failure },
    );
    this.name = 'CancelLatencyReadWarning';
    this.detail = `stream: ${streamId}`;
  }
}

/** The onCancelDetected callback failed; cancellation goes on. */
class CancelDetectedCallbackWarning extends Error {
  readonly code = 'DEEPAGENTS_CONTEXT_CANCEL_DETECTED_CALLBACK_FAILED';
  readonly detail: string;

  constructor(failure: unknown, streamId: string) {
    super(
      `The onCancelDetected callback failed, and cancellation goes on: ${Error.isError(failure) ? failure.message : String(failure)}`,
      { cause: failure },
    );
    this.name = 'CancelDetectedCallbackWarning';
    this.detail = `stream: ${streamId}`;
  }
}

/** Ending the change subscription of a cancelled watch failed; the watch ends anyway. */
class WatchUnsubscribeWarning extends Error {
  readonly code = 'DEEPAGENTS_CONTEXT_WATCH_UNSUBSCRIBE_FAILED';
  readonly detail: string;

  constructor(failure: unknown, streamId: string) {
    super(
      `Ending the change subscription of a cancelled watch failed, and the watch ends anyway: ${Error.isError(failure) ? failure.message : String(failure)}`,
      { cause: failure },
    );
    this.name = 'WatchUnsubscribeWarning';
    this.detail = `stream: ${streamId}`;
  }
}

/** The onWatchEvent observer failed; the observed stream operation goes on. */
class WatchTelemetryWarning extends Error {
  readonly code = 'DEEPAGENTS_CONTEXT_WATCH_TELEMETRY_FAILED';
  readonly detail: string;

  constructor(failure: unknown, event: StreamWatchTelemetryEvent) {
    super(
      `The onWatchEvent observer failed, and the observed stream operation goes on: ${Error.isError(failure) ? failure.message : String(failure)}`,
      { cause: failure },
    );
    this.name = 'WatchTelemetryWarning';
    this.detail = `stream: ${event.streamId}, event: ${event.type}`;
  }
}

function isTerminal(status: StreamStatus) {
  return status !== 'queued' && status !== 'running';
}

export interface PersistStreamOptions {
  /** @internal The caller already won the queued-to-running transition. */
  preclaimed?: boolean;
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
  readonly #localCancellationListeners = new Map<
    string,
    Set<() => Promise<void>>
  >();

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
    const now = Date.now();
    const { updated } = await this.#store.updateStream(
      streamId,
      ({ status }) =>
        status === 'queued' || status === 'running'
          ? {
              status: 'cancelled',
              cancelRequestedAt: now,
              finishedAt: now,
            }
          : undefined,
    );
    if (updated) {
      await this.#signalLocalCancellation(streamId);
    }
  }

  async claim(streamId: string): Promise<boolean> {
    const { updated } = await this.#store.updateStream(
      streamId,
      ({ status }) =>
        status === 'queued'
          ? { status: 'running', startedAt: Date.now() }
          : undefined,
    );
    return updated;
  }

  monitorCancellation(
    streamId: string,
    onCancelDetected: NonNullable<PersistStreamOptions['onCancelDetected']>,
  ): AsyncDisposable {
    const controller = new AbortController();
    const watching = this.#runCancelWatcher(streamId, controller, {
      onCancelDetected,
    });
    return {
      [Symbol.asyncDispose]: async () => {
        controller.abort();
        await watching;
      },
    };
  }

  async listStreamIds(options?: ListStreamIdsOptions): Promise<string[]> {
    return this.#store.listStreamIds(options);
  }

  async persist(
    stream: ReadableStream,
    streamId: string,
    options?: PersistStreamOptions,
  ): Promise<{ streamId: string }> {
    const claimed = options?.preclaimed
      ? (await this.#store.getStreamStatus(streamId)) === 'running'
      : await this.claim(streamId);
    if (!claimed) {
      if (
        options?.preclaimed &&
        (await this.#store.getStreamStatus(streamId)) === 'cancelled'
      ) {
        await this.#notifyCancellation(streamId, options);
      }
      return { streamId };
    }

    const ac = new AbortController();
    const cancelWatcher = this.#runCancelWatcher(streamId, ac, options);
    // The watcher stops before persist writes the stream's terminal status,
    // so it never reads persist's own 'cancelled' back as a cancel.
    const stopCancelWatcher = async () => {
      ac.abort();
      await cancelWatcher;
    };
    const source = settlementTracked(stream);

    let pw!: Awaited<ReturnType<typeof persistedWriter>>;

    const sink = createUIMessageStream({
      execute: async ({ writer }) => {
        pw = await persistedWriter({
          writer,
          store: this.#store,
          streamId,
        });
        pw.writer.merge(source.stream);
      },
    });

    let cancelled: boolean | undefined;
    try {
      await drain(sink, ac.signal);
      cancelled = ac.signal.aborted;
      await stopCancelWatcher();

      if (cancelled) {
        if (pw) await pw.flush();
      } else if (!source.failure) {
        await pw.complete();
      } else if (
        Error.isError(source.failure.error) &&
        source.failure.error.name === 'AbortError'
      ) {
        // The source was aborted: chat() raises its abort signal's reason
        // after the abort chunk, once its end callback has saved the answer.
        // By name only: a store error that says "aborted" is a failure.
        await pw.flush();
        await this.#store.updateStreamStatus(streamId, 'cancelled');
      } else {
        throw source.failure.error;
      }
    } catch (err) {
      cancelled ??= ac.signal.aborted;
      if (cancelled) {
        if (isAbortError(err)) {
          if (pw) await pw.flush();
        } else {
          throw err;
        }
      } else {
        const message = Error.isError(err) ? err.message : String(err);
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
      await stopCancelWatcher();
      await source.settled;
    }

    return { streamId: pw?.streamId ?? streamId };
  }

  async #runCancelWatcher(
    streamId: string,
    ac: AbortController,
    options: PersistStreamOptions | undefined,
  ): Promise<void> {
    let detected = false;
    const detect = async () => {
      if (detected || ac.signal.aborted) return;
      detected = true;
      ac.abort();
      await this.#notifyCancellation(streamId, options);
    };
    let retries = 0;
    const listeners =
      this.#localCancellationListeners.get(streamId) ?? new Set();
    listeners.add(detect);
    this.#localCancellationListeners.set(streamId, listeners);
    try {
      while (!ac.signal.aborted && !detected) {
        try {
          const initialStatus = await this.#store.getStreamStatus(streamId);
          // A stream deleted under its producer is cancelled too: only the
          // host can abort the producer, so it has to hear of it.
          if (initialStatus === undefined || initialStatus === 'cancelled') {
            await detect();
            return;
          }
          if (isTerminal(initialStatus)) return;

          const subscribedAt = performance.now();
          let subscriptionStabilized = false;
          for await (const change of this.#changeSource.subscribe(
            streamId,
            ac.signal,
          )) {
            if (
              !subscriptionStabilized &&
              performance.now() - subscribedAt >= CANCEL_WATCHER_RETRY_MAX_MS
            ) {
              retries = 0;
              subscriptionStabilized = true;
            }
            if (change.kind === 'chunks') continue;
            const status = await this.#store.getStreamStatus(streamId);
            if (status === undefined || status === 'cancelled') {
              await detect();
              return;
            }
            if (isTerminal(status)) return;
          }
        } catch {
          if (ac.signal.aborted || detected) return;
        }

        // A notification source can fail or end during a reconnect. Keep the
        // cancellation watcher alive for the lifetime of persist(). Reuse the
        // capped back-off so a storage outage cannot create one fixed-rate
        // retry loop per active stream.
        if (
          !(await waitForDelay(
            CANCEL_WATCHER_RETRY.duration(retries++),
            ac.signal,
          ))
        ) {
          return;
        }
      }
    } finally {
      listeners.delete(detect);
      if (listeners.size === 0) {
        this.#localCancellationListeners.delete(streamId);
      }
    }
  }

  async #signalLocalCancellation(streamId: string): Promise<void> {
    const listeners = this.#localCancellationListeners.get(streamId);
    if (!listeners) return;
    await Promise.all([...listeners].map((listener) => listener()));
  }

  async #notifyCancellation(
    streamId: string,
    options: PersistStreamOptions | undefined,
  ): Promise<void> {
    let current: StreamData | undefined;
    try {
      current = await this.#store.getStream(streamId);
    } catch (error) {
      // Latency is telemetry only; a read failure must never suppress abort.
      process.emitWarning(new CancelLatencyReadWarning(error, streamId));
    }
    const latencyMs =
      current?.cancelRequestedAt != null
        ? Math.max(0, Date.now() - current.cancelRequestedAt)
        : null;
    this.#emit({ type: 'persist:cancel-detected', streamId, latencyMs });
    if (!options?.onCancelDetected) return;
    try {
      await options.onCancelDetected({ streamId, latencyMs });
    } catch (error) {
      process.emitWarning(new CancelDetectedCallbackWarning(error, streamId));
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
          (error: unknown) => {
            process.emitWarning(new WatchUnsubscribeWarning(error, streamId));
          },
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
    } catch (error) {
      process.emitWarning(new WatchTelemetryWarning(error, event));
    }
  }
}

function waitForDelay(ms: number, signal: AbortSignal): Promise<boolean> {
  return delay(ms, true, { signal }).catch((err: unknown) => {
    if (signal.aborted) return false;
    throw err;
  });
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
      controller.enqueue(chunk.data);
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
    Error.isError(error) &&
    (error.name === 'AbortError' || /aborted/i.test(error.message))
  );
}

/**
 * Forwards `stream` and reports when it has settled: it ended, errored, or
 * finished its `cancel`. A `pipeThrough` between the sink and the stream (the
 * AI SDK's UI message stream and `persistedWriter.merge` each add one) cancels
 * it without awaiting that cancel, so the sink settling says nothing about it.
 * It also keeps the error `stream` failed with: the UI message stream's merge
 * turns that error into an `error` chunk, which it writes past
 * `persistedWriter`, and the sink then ends normally.
 */
function settlementTracked(stream: ReadableStream): {
  stream: ReadableStream;
  settled: Promise<void>;
  readonly failure: { error: unknown } | undefined;
} {
  const reader = stream.getReader();
  const { promise: settled, resolve } = Promise.withResolvers<void>();
  let cancelled = false;
  let failure: { error: unknown } | undefined;
  return {
    settled,
    get failure() {
      return failure;
    },
    stream: new ReadableStream(
      {
        async pull(controller) {
          try {
            const { done, value } = await reader.read();
            if (cancelled) return;
            if (done) {
              controller.close();
              resolve();
            } else {
              controller.enqueue(value);
            }
          } catch (error) {
            failure = { error };
            resolve();
            throw error;
          }
        },
        async cancel(reason) {
          cancelled = true;
          try {
            await reader.cancel(reason);
          } finally {
            resolve();
          }
        },
      },
      { highWaterMark: 0 },
    ),
  };
}

/**
 * Reads the stream to its end, discarding chunks. An abort cancels the stream
 * and rejects with the signal's reason once the cancellation has settled.
 */
async function drain(
  stream: ReadableStream,
  signal?: AbortSignal,
): Promise<void> {
  await stream.pipeTo(new WritableStream(), { signal });
}
