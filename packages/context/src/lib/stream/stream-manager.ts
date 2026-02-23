import { createUIMessageStream } from 'ai';
import { setTimeout } from 'node:timers/promises';

import type { StreamPart } from '../guardrail.ts';
import {
  type PersistedWriterOptions,
  persistedWriter,
} from '../stream-buffer.ts';
import {
  type CancelPollingConfig,
  DEFAULT_CANCEL_POLLING,
  DEFAULT_WATCH_POLLING,
  type WatchPollingConfig,
  createAdaptivePollingState,
  nextAdaptivePollingDelay,
  normalizeCancelPolling,
  normalizeWatchPolling,
  resetAdaptivePolling,
} from './polling-policy.ts';
import type {
  StreamChunkData,
  StreamData,
  StreamStatus,
  StreamStore,
} from './stream-store.ts';

function isTerminal(status: StreamStatus) {
  return status !== 'queued' && status !== 'running';
}

export type WatchStreamOptions = Partial<WatchPollingConfig>;
export type PersistCancelPollingOptions = Partial<CancelPollingConfig>;

export interface PersistStreamOptions extends Pick<
  PersistedWriterOptions,
  'strategy' | 'flushSize'
> {
  cancelPolling?: PersistCancelPollingOptions;
}

export type StreamPollingTelemetryEvent =
  | {
      type: 'watch:poll';
      streamId: string;
      fromSeq: number;
      chunkCount: number;
      statusChecked: boolean;
    }
  | {
      type: 'watch:empty';
      streamId: string;
      fromSeq: number;
      delayMs: number;
    }
  | {
      type: 'watch:chunks';
      streamId: string;
      delivered: number;
      lastSeq: number;
    }
  | {
      type: 'watch:closed';
      streamId: string;
      reason: 'terminal' | 'missing';
    }
  | {
      type: 'persist:cancel-poll';
      streamId: string;
      delayMs: number;
      status: StreamStatus | 'missing';
    }
  | {
      type: 'persist:cancel-detected';
      streamId: string;
      latencyMs: number | null;
    };

export interface StreamManagerOptions {
  store: StreamStore;
  watchPolling?: WatchStreamOptions;
  cancelPolling?: PersistCancelPollingOptions;
  onPollingEvent?: (event: StreamPollingTelemetryEvent) => void;
}

export class StreamManager {
  #store: StreamStore;
  #watchPollingDefaults: WatchPollingConfig;
  #cancelPollingDefaults: CancelPollingConfig;
  #onPollingEvent?: (event: StreamPollingTelemetryEvent) => void;

  constructor(options: StreamManagerOptions) {
    this.#store = options.store;
    this.#watchPollingDefaults = normalizeWatchPolling(
      options.watchPolling,
      DEFAULT_WATCH_POLLING,
    );
    this.#cancelPollingDefaults = normalizeCancelPolling(
      options.cancelPolling,
      DEFAULT_CANCEL_POLLING,
    );
    this.#onPollingEvent = options.onPollingEvent;
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
    const cancelPolling = normalizeCancelPolling(
      options?.cancelPolling,
      this.#cancelPollingDefaults,
    );
    const pollState = createAdaptivePollingState(cancelPolling);

    const pollCancel = (async () => {
      while (!ac.signal.aborted) {
        const delayMs = nextAdaptivePollingDelay(pollState);
        const continued = await waitForDelay(delayMs, ac.signal);
        if (!continued || ac.signal.aborted) break;

        const status = await this.#store.getStreamStatus(streamId);
        this.#emitPolling({
          type: 'persist:cancel-poll',
          streamId,
          delayMs,
          status: status ?? 'missing',
        });

        if (status === undefined) {
          ac.abort();
          break;
        }

        if (status === 'cancelled') {
          const current = await this.#store.getStream(streamId);
          const latencyMs =
            current?.cancelRequestedAt != null
              ? Math.max(0, Date.now() - current.cancelRequestedAt)
              : null;
          this.#emitPolling({
            type: 'persist:cancel-detected',
            streamId,
            latencyMs,
          });
          ac.abort();
          break;
        }
      }
    })();

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
      await pollCancel;
    }

    return { streamId: pw?.streamId ?? streamId };
  }

  watch(
    streamId: string,
    options?: WatchStreamOptions,
  ): ReadableStream<StreamPart> {
    const store = this.#store;
    const polling = normalizeWatchPolling(options, this.#watchPollingDefaults);
    const delayState = createAdaptivePollingState(polling);
    const ac = new AbortController();
    const lastSeqRef = { value: -1 };
    let chunkPollsSinceStatus = 0;

    const emitChunks = (
      controller: ReadableStreamDefaultController<StreamPart>,
      chunks: StreamChunkData[],
    ): number => {
      for (const chunk of chunks) {
        controller.enqueue(chunk.data as StreamPart);
        lastSeqRef.value = chunk.seq;
      }
      return chunks.length;
    };

    return new ReadableStream<StreamPart>({
      async start() {
        const stream = await store.getStream(streamId);
        if (!stream) {
          throw new Error(`Stream "${streamId}" not found`);
        }
      },
      pull: async (controller) => {
        while (!ac.signal.aborted) {
          const fromSeq = lastSeqRef.value + 1;
          const chunks = await store.getChunks(
            streamId,
            fromSeq,
            polling.chunkPageSize,
          );

          let statusChecked = false;
          let currentStatus: StreamStatus | undefined;
          if (chunks.length === 0) {
            chunkPollsSinceStatus = polling.statusCheckEvery;
          } else {
            chunkPollsSinceStatus += 1;
          }
          if (chunkPollsSinceStatus >= polling.statusCheckEvery) {
            statusChecked = true;
            chunkPollsSinceStatus = 0;
            currentStatus = await store.getStreamStatus(streamId);
          }

          this.#emitPolling({
            type: 'watch:poll',
            streamId,
            fromSeq,
            chunkCount: chunks.length,
            statusChecked,
          });

          if (chunks.length > 0) {
            const delivered = emitChunks(controller, chunks);
            this.#emitPolling({
              type: 'watch:chunks',
              streamId,
              delivered,
              lastSeq: lastSeqRef.value,
            });
            resetAdaptivePolling(delayState);
            if (chunks.length >= polling.chunkPageSize) {
              continue;
            }
            return;
          }

          if (statusChecked) {
            if (currentStatus === undefined) {
              this.#emitPolling({
                type: 'watch:closed',
                streamId,
                reason: 'missing',
              });
              controller.close();
              ac.abort();
              return;
            }

            if (isTerminal(currentStatus)) {
              const drained = await drainRemainingChunks({
                controller,
                store,
                streamId,
                fromSeq: lastSeqRef.value + 1,
                chunkPageSize: polling.chunkPageSize,
                onChunk: (seq) => {
                  lastSeqRef.value = seq;
                },
              });
              if (drained > 0) {
                this.#emitPolling({
                  type: 'watch:chunks',
                  streamId,
                  delivered: drained,
                  lastSeq: lastSeqRef.value,
                });
              }
              this.#emitPolling({
                type: 'watch:closed',
                streamId,
                reason: 'terminal',
              });
              controller.close();
              ac.abort();
              return;
            }
          }

          const delayMs = nextAdaptivePollingDelay(delayState);
          this.#emitPolling({
            type: 'watch:empty',
            streamId,
            fromSeq: lastSeqRef.value + 1,
            delayMs,
          });
          const continued = await waitForDelay(delayMs, ac.signal);
          if (!continued) {
            return;
          }
        }
      },
      cancel() {
        ac.abort();
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

  #emitPolling(event: StreamPollingTelemetryEvent): void {
    if (!this.#onPollingEvent) return;
    try {
      this.#onPollingEvent(event);
    } catch {
      /* empty - telemetry callbacks must never break stream processing */
    }
  }
}

interface DrainRemainingChunksOptions {
  controller: ReadableStreamDefaultController<StreamPart>;
  store: StreamStore;
  streamId: string;
  fromSeq: number;
  chunkPageSize: number;
  onChunk: (seq: number) => void;
}

async function drainRemainingChunks(
  options: DrainRemainingChunksOptions,
): Promise<number> {
  const { controller, store, streamId, chunkPageSize, onChunk } = options;
  let fromSeq = options.fromSeq;
  let drained = 0;

  while (true) {
    const chunks = await store.getChunks(streamId, fromSeq, chunkPageSize);
    if (chunks.length === 0) break;

    for (const chunk of chunks) {
      controller.enqueue(chunk.data as StreamPart);
      onChunk(chunk.seq);
      drained++;
      fromSeq = chunk.seq + 1;
    }

    if (chunks.length < chunkPageSize) {
      break;
    }
  }

  return drained;
}

async function waitForDelay(
  ms: number,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    await setTimeout(ms, undefined, signal ? { signal } : undefined);
    return true;
  } catch (error) {
    if (isAbortError(error)) return false;
    throw error;
  }
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
