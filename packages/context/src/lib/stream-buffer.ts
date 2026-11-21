import type { UIMessageStreamWriter } from 'ai';

import {
  type StreamChunkData,
  type StreamStore,
  collectStreamFailures,
} from './stream/stream-store.ts';
import type { StreamPart } from './stream/types.ts';

/**
 * Chunks a merged stream may queue behind the in-flight append before the
 * writer stops reading it. It caps the next batch at the size of one
 * `watch()` page (`StreamManager`'s default `chunkPageSize`), so a reader
 * catches up on a batch in one read.
 */
const MAX_QUEUED_CHUNKS = 128;

export interface PersistedWriterOptions {
  writer: UIMessageStreamWriter;
  store: StreamStore;
  streamId: string;
}

/**
 * A `UIMessageStreamWriter` whose `write` persists the chunk before forwarding
 * it, so it returns that work's promise. Await it to keep chunk order and to
 * observe storage failures.
 */
export type PersistedStreamWriter = Omit<UIMessageStreamWriter, 'write'> & {
  write(part: StreamPart): Promise<void>;
};

export interface PersistedWriter {
  writer: PersistedStreamWriter;
  streamId: string;
  flush(): Promise<void>;
  complete(): Promise<void>;
  fail(error?: string): Promise<void>;
  cleanup(): Promise<void>;
}

interface QueuedChunk {
  chunk: StreamChunkData;
  committed(): void;
  failed(error: unknown): void;
}

/**
 * Persists each chunk before forwarding it. The first chunk is appended at
 * once; chunks that arrive while an append is in flight go into the next
 * append together, so batches grow with the store's latency and a live reader
 * waits at most one store round trip.
 */
export async function persistedWriter(
  options: PersistedWriterOptions,
): Promise<PersistedWriter> {
  const { writer, store, streamId } = options;

  let seq = 0;
  let queue: QueuedChunk[] = [];
  let appending: Promise<void> | undefined;
  let appendSettled: Promise<void> = Promise.resolve();
  let failure: { error: unknown } | undefined;
  let failedByChunk = false;
  let abortedByChunk = false;

  function enqueue(
    part: StreamPart,
    committed: () => void,
    failed: (error: unknown) => void,
  ) {
    if (failure) {
      failed(failure.error);
      return;
    }
    queue.push({
      chunk: { streamId, seq: seq++, data: part, createdAt: Date.now() },
      committed,
      failed,
    });
    appending ??= appendQueued();
  }

  async function appendQueued() {
    while (queue.length > 0) {
      const batch = queue;
      queue = [];
      const chunks = batch.map(({ chunk }) => chunk);
      const append = Promise.try(() => store.appendChunks(chunks));
      appendSettled = append.then(
        () => undefined,
        () => undefined,
      );
      try {
        await append;
      } catch (error) {
        failure = { error };
        const rejected = [...batch, ...queue];
        queue = [];
        for (const entry of rejected) entry.failed(error);
        break;
      }
      failedByChunk ||= collectStreamFailures(chunks).length > 0;
      abortedByChunk ||= chunks.some(({ data }) => data.type === 'abort');
      for (const entry of batch) entry.committed();
    }
    appending = undefined;
  }

  async function settle() {
    while (appending) await appending;
  }

  async function flush() {
    await settle();
    if (failure) throw failure.error;
  }

  const wrappedWriter: PersistedStreamWriter = {
    onError: writer.onError,
    write(part: StreamPart) {
      const { promise, resolve, reject } = Promise.withResolvers<void>();
      enqueue(
        part,
        () => {
          writer.write(part);
          resolve();
        },
        reject,
      );
      return promise;
    },
    merge(stream: ReadableStream<StreamPart>) {
      let cancelled = false;
      const transform = new TransformStream<StreamPart, StreamPart>({
        async transform(part, controller) {
          enqueue(
            part,
            () => {
              if (!cancelled) controller.enqueue(part);
            },
            (error) => {
              if (!cancelled) controller.error(error);
            },
          );
          while (queue.length >= MAX_QUEUED_CHUNKS && !failure) {
            await appendSettled;
          }
        },
        flush: () => flush(),
        cancel() {
          cancelled = true;
        },
      });
      writer.merge(stream.pipeThrough(transform));
    },
  };

  return {
    writer: wrappedWriter,
    streamId,
    flush,
    async complete() {
      await flush();
      if (failedByChunk) return;
      await store.updateStreamStatus(
        streamId,
        abortedByChunk ? 'cancelled' : 'completed',
      );
    },
    async fail(error?: string) {
      await settle();
      if (failedByChunk) return;
      await store.updateStreamStatus(streamId, 'failed', { error });
    },
    async cleanup() {
      await store.deleteStream(streamId);
    },
  };
}
