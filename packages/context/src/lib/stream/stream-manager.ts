import { createUIMessageStream } from 'ai';
import { setTimeout } from 'node:timers/promises';

import type { StreamPart } from '../guardrail.ts';
import {
  type PersistedWriterOptions,
  persistedWriter,
} from '../stream-buffer.ts';
import type { StreamData, StreamStatus, StreamStore } from './stream-store.ts';

function isTerminal(status: StreamStatus) {
  return status !== 'queued' && status !== 'running';
}

export interface StreamManagerOptions {
  store: StreamStore;
}

export class StreamManager {
  #store: StreamStore;

  constructor(options: StreamManagerOptions) {
    this.#store = options.store;
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
    options?: Pick<PersistedWriterOptions, 'strategy' | 'flushSize'> & {
      cancelCheckInterval?: number;
    },
  ): Promise<{ streamId: string }> {
    const existing = await this.#store.getStream(streamId);
    if (existing && isTerminal(existing.status)) {
      return { streamId };
    }

    await this.#store.updateStreamStatus(streamId, 'running');

    const ac = new AbortController();
    const checkInterval = options?.cancelCheckInterval ?? 500;

    const pollCancel = (async () => {
      while (!ac.signal.aborted) {
        await setTimeout(checkInterval);
        if (ac.signal.aborted) break;
        const current = await this.#store.getStream(streamId);
        if (current?.status === 'cancelled') {
          ac.abort();
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
        if (pw) await pw.flush();
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
    options?: { interval?: number },
  ): ReadableStream<StreamPart> {
    const store = this.#store;
    const interval = options?.interval ?? 100;
    let lastSeq = -1;

    return new ReadableStream<StreamPart>({
      async start() {
        const stream = await store.getStream(streamId);
        if (!stream) {
          throw new Error(`Stream "${streamId}" not found`);
        }
      },
      async pull(controller) {
        while (true) {
          const [chunks, current] = await Promise.all([
            store.getChunks(streamId, lastSeq + 1),
            store.getStream(streamId),
          ]);

          for (const chunk of chunks) {
            controller.enqueue(chunk.data as StreamPart);
            lastSeq = chunk.seq;
          }

          if (current && isTerminal(current.status)) {
            const remaining = await store.getChunks(streamId, lastSeq + 1);
            for (const chunk of remaining) {
              controller.enqueue(chunk.data as StreamPart);
              lastSeq = chunk.seq;
            }
            controller.close();
            return;
          }

          if (chunks.length > 0) return;
          await setTimeout(interval);
        }
      },
    });
  }

  async cleanup(streamId: string): Promise<void> {
    await this.#store.deleteStream(streamId);
  }
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
