import { createUIMessageStream } from 'ai';

import {
  type PersistedWriterOptions,
  persistedWriter,
} from '../stream-buffer.ts';
import type { StreamChange, StreamChangeSource } from './change-source.ts';
import {
  DEFAULT_CANCEL_POLLING,
  createAdaptivePollingState,
  nextAdaptivePollingDelay,
  resetAdaptivePolling,
} from './polling-policy.ts';
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
    let detected = false;
    const detect = async () => {
      if (detected) return;
      detected = true;
      ac.abort();
      await this.#notifyCancellation(streamId, options);
    };
    const retryState = createAdaptivePollingState(DEFAULT_CANCEL_POLLING);
    const listeners =
      this.#localCancellationListeners.get(streamId) ?? new Set();
    listeners.add(detect);
    this.#localCancellationListeners.set(streamId, listeners);
    try {
      while (!ac.signal.aborted && !detected) {
        try {
          const initialStatus = await this.#store.getStreamStatus(streamId);
          if (initialStatus === undefined) {
            ac.abort();
            return;
          }
          if (initialStatus === 'cancelled') {
            await detect();
            return;
          }
          if (isTerminal(initialStatus)) return;

          const subscribedAt = Date.now();
          let subscriptionStabilized = false;
          for await (const change of this.#changeSource.subscribe(
            streamId,
            ac.signal,
          )) {
            if (
              !subscriptionStabilized &&
              Date.now() - subscribedAt >= DEFAULT_CANCEL_POLLING.maxMs
            ) {
              resetAdaptivePolling(retryState);
              subscriptionStabilized = true;
            }
            if (change.kind === 'chunks') continue;
            const status = await this.#store.getStreamStatus(streamId);
            if (status === undefined) {
              ac.abort();
              return;
            }
            if (status === 'cancelled') {
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
        // bounded adaptive policy so a storage outage cannot create one fixed-
        // rate retry loop per active stream.
        if (
          !(await waitForDelay(nextAdaptivePollingDelay(retryState), ac.signal))
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
    } catch {
      // Latency is telemetry only; a read failure must never suppress abort.
    }
    const latencyMs =
      current?.cancelRequestedAt != null
        ? Math.max(0, Date.now() - current.cancelRequestedAt)
        : null;
    this.#emit({ type: 'persist:cancel-detected', streamId, latencyMs });
    if (!options?.onCancelDetected) return;
    try {
      await options.onCancelDetected({ streamId, latencyMs });
    } catch {
      /* best-effort — never block cancellation */
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

function waitForDelay(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timeout = globalThis.setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    const onAbort = () => {
      globalThis.clearTimeout(timeout);
      resolve(false);
    };
    signal.addEventListener('abort', onAbort, { once: true });
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
