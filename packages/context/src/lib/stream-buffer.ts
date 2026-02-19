import type { UIMessageStreamWriter } from 'ai';

import type { StreamPart } from './guardrail.ts';
import type { StreamChunkData, StreamStore } from './stream/stream-store.ts';

export interface PersistedWriterOptions {
  writer: UIMessageStreamWriter;
  store: StreamStore;
  streamId: string;
  /**
   * How chunks are persisted relative to the stream:
   * - 'buffered' (default): batch up to `flushSize` chunks, flush on threshold or when stream ends
   * - 'immediate': persist each chunk before forwarding (higher latency, no data loss)
   */
  strategy?: 'buffered' | 'immediate';
  /** For buffered strategy: flush after this many chunks (default: 20) */
  flushSize?: number;
}

export interface PersistedWriter {
  writer: UIMessageStreamWriter;
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

  async function flush() {
    if (buffer.length === 0) return;
    const batch = buffer;
    buffer = [];
    await store.appendChunks(batch);
  }

  function makeChunk(part: StreamPart): StreamChunkData {
    return {
      streamId,
      seq: seq++,
      data: part,
      createdAt: Date.now(),
    };
  }

  async function persistChunk(chunk: StreamChunkData) {
    if (strategy === 'immediate') {
      await store.appendChunks([chunk]);
    } else {
      buffer.push(chunk);
      if (buffer.length >= flushSize) {
        await flush();
      }
    }
  }

  const wrappedWriter: UIMessageStreamWriter = {
    onError: writer.onError,
    async write(part: StreamPart) {
      await persistChunk(makeChunk(part));
      writer.write(part);
    },
    merge(stream: ReadableStream) {
      const transform = new TransformStream({
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
      await store.updateStreamStatus(streamId, 'completed');
    },
    async fail(error?: string) {
      await flush();
      await store.updateStreamStatus(streamId, 'failed', { error });
    },
    async cleanup() {
      await store.deleteStream(streamId);
    },
  };
}
