import type { UIMessageStreamWriter } from 'ai';

import type { StreamChunkData, StreamStore } from './stream/stream-store.ts';
import type { StreamPart } from './stream/types.ts';

type StreamErrorPart = Extract<StreamPart, { type: 'error' }>;

export interface PersistedWriterOptions {
  writer: UIMessageStreamWriter;
  store: StreamStore;
  streamId: string;
  /**
   * How chunks are persisted relative to the stream:
   * - 'buffered' (default): batch up to `flushSize` chunks; data events flush promptly
   * - 'immediate': persist each chunk before forwarding (higher latency, no data loss)
   */
  strategy?: 'buffered' | 'immediate';
  /** For buffered strategy: flush after this many chunks (default: 20) */
  flushSize?: number;
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

export async function persistedWriter(
  options: PersistedWriterOptions,
): Promise<PersistedWriter> {
  const {
    writer,
    store,
    streamId,
    strategy = 'buffered',
    flushSize = 20,
  } = options;

  let seq = 0;
  let buffer: StreamChunkData[] = [];
  let failedByErrorChunk = false;
  let abortedByChunk = false;

  async function flush() {
    if (buffer.length === 0) return;
    const batch = buffer;
    buffer = [];
    await appendBatch(batch);
  }

  function makeChunk(part: StreamPart): StreamChunkData {
    return {
      streamId,
      seq: seq++,
      data: part,
      createdAt: Date.now(),
    };
  }

  function isStreamErrorPart(part: StreamPart): part is StreamErrorPart {
    return part.type === 'error';
  }

  async function appendBatch(batch: StreamChunkData[]) {
    const hasErrorPart =
      !failedByErrorChunk &&
      batch.map((chunk) => chunk.data).some(isStreamErrorPart);

    await store.appendChunks(batch);

    if (hasErrorPart) {
      failedByErrorChunk = true;
    }
  }

  async function persistChunk(chunk: StreamChunkData) {
    if (chunk.data.type === 'abort') {
      abortedByChunk = true;
    }
    if (strategy === 'immediate') {
      await appendBatch([chunk]);
    } else {
      buffer.push(chunk);
      // Custom data carries progress even while model output is paused.
      if (buffer.length >= flushSize || chunk.data.type.startsWith('data-')) {
        await flush();
      }
    }
  }

  const wrappedWriter: PersistedStreamWriter = {
    onError: writer.onError,
    async write(part: StreamPart) {
      await persistChunk(makeChunk(part));
      writer.write(part);
    },
    merge(stream: ReadableStream<StreamPart>) {
      const transform = new TransformStream<StreamPart, StreamPart>({
        async transform(chunk, controller) {
          await persistChunk(makeChunk(chunk));
          controller.enqueue(chunk);
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
      if (failedByErrorChunk) return;
      await store.updateStreamStatus(
        streamId,
        abortedByChunk ? 'cancelled' : 'completed',
      );
    },
    async fail(error?: string) {
      await flush();
      if (failedByErrorChunk) return;
      await store.updateStreamStatus(streamId, 'failed', { error });
    },
    async cleanup() {
      await store.deleteStream(streamId);
    },
  };
}
