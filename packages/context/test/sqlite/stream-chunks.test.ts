import assert from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  SqliteStreamStore,
  type StreamChunkData,
  type StreamData,
  StreamManager,
} from '@deepagents/context';

async function withStreamStore<T>(
  fn: (store: SqliteStreamStore) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'stream-test-'));
  const dbPath = path.join(dir, 'test.sqlite');
  const store = new SqliteStreamStore(dbPath);
  try {
    return await fn(store);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function createStream(overrides?: Partial<StreamData>): StreamData {
  return {
    id: crypto.randomUUID(),
    status: 'queued',
    createdAt: Date.now(),
    startedAt: null,
    finishedAt: null,
    cancelRequestedAt: null,
    error: null,
    ...overrides,
  };
}

function createChunk(
  streamId: string,
  seq: number,
  data: unknown = { type: 'text-delta', delta: `chunk-${seq}` },
): StreamChunkData {
  return {
    streamId,
    seq,
    data,
    createdAt: Date.now(),
  };
}

describe('Stream Chunks', () => {
  describe('createStream / getStream', () => {
    it('should create and retrieve a stream', async () => {
      await withStreamStore(async (store) => {
        const stream = createStream();
        await store.createStream(stream);

        const retrieved = await store.getStream(stream.id);
        assert.ok(retrieved);
        assert.strictEqual(retrieved.id, stream.id);
        assert.strictEqual(retrieved.status, 'queued');
        assert.strictEqual(retrieved.startedAt, null);
        assert.strictEqual(retrieved.finishedAt, null);
        assert.strictEqual(retrieved.cancelRequestedAt, null);
        assert.strictEqual(retrieved.error, null);
      });
    });

    it('should return undefined for non-existent stream', async () => {
      await withStreamStore(async (store) => {
        const result = await store.getStream('non-existent');
        assert.strictEqual(result, undefined);
      });
    });
  });

  describe('updateStreamStatus', () => {
    it('should transition to running and set startedAt', async () => {
      await withStreamStore(async (store) => {
        const stream = createStream();
        await store.createStream(stream);

        await store.updateStreamStatus(stream.id, 'running');

        const updated = await store.getStream(stream.id);
        assert.ok(updated);
        assert.strictEqual(updated.status, 'running');
        assert.ok(typeof updated.startedAt === 'number');
        assert.strictEqual(updated.finishedAt, null);
      });
    });

    it('should transition to completed and set finishedAt', async () => {
      await withStreamStore(async (store) => {
        const stream = createStream({
          status: 'running',
          startedAt: Date.now(),
        });
        await store.createStream(stream);

        await store.updateStreamStatus(stream.id, 'completed');

        const updated = await store.getStream(stream.id);
        assert.ok(updated);
        assert.strictEqual(updated.status, 'completed');
        assert.ok(typeof updated.finishedAt === 'number');
      });
    });

    it('should transition to failed with error message', async () => {
      await withStreamStore(async (store) => {
        const stream = createStream({
          status: 'running',
          startedAt: Date.now(),
        });
        await store.createStream(stream);

        await store.updateStreamStatus(stream.id, 'failed', {
          error: 'connection timeout',
        });

        const updated = await store.getStream(stream.id);
        assert.ok(updated);
        assert.strictEqual(updated.status, 'failed');
        assert.ok(typeof updated.finishedAt === 'number');
        assert.strictEqual(updated.error, 'connection timeout');
      });
    });

    it('should transition to cancelled and set both cancelRequestedAt and finishedAt', async () => {
      await withStreamStore(async (store) => {
        const stream = createStream({
          status: 'running',
          startedAt: Date.now(),
        });
        await store.createStream(stream);

        await store.updateStreamStatus(stream.id, 'cancelled');

        const updated = await store.getStream(stream.id);
        assert.ok(updated);
        assert.strictEqual(updated.status, 'cancelled');
        assert.ok(typeof updated.cancelRequestedAt === 'number');
        assert.ok(typeof updated.finishedAt === 'number');
      });
    });
  });

  describe('appendChunks / getChunks', () => {
    it('should append and retrieve chunks in order', async () => {
      await withStreamStore(async (store) => {
        const stream = createStream();
        await store.createStream(stream);

        await store.appendChunks([createChunk(stream.id, 0)]);
        await store.appendChunks([createChunk(stream.id, 1)]);
        await store.appendChunks([createChunk(stream.id, 2)]);

        const chunks = await store.getChunks(stream.id);
        assert.strictEqual(chunks.length, 3);
        assert.strictEqual(chunks[0].seq, 0);
        assert.strictEqual(chunks[1].seq, 1);
        assert.strictEqual(chunks[2].seq, 2);
      });
    });

    it('should retrieve chunks from a given sequence', async () => {
      await withStreamStore(async (store) => {
        const stream = createStream();
        await store.createStream(stream);

        for (let i = 0; i < 10; i++) {
          await store.appendChunks([createChunk(stream.id, i)]);
        }

        const chunks = await store.getChunks(stream.id, 5);
        assert.strictEqual(chunks.length, 5);
        assert.strictEqual(chunks[0].seq, 5);
        assert.strictEqual(chunks[4].seq, 9);
      });
    });

    it('should respect limit parameter', async () => {
      await withStreamStore(async (store) => {
        const stream = createStream();
        await store.createStream(stream);

        for (let i = 0; i < 10; i++) {
          await store.appendChunks([createChunk(stream.id, i)]);
        }

        const chunks = await store.getChunks(stream.id, 0, 3);
        assert.strictEqual(chunks.length, 3);
        assert.strictEqual(chunks[0].seq, 0);
        assert.strictEqual(chunks[2].seq, 2);
      });
    });

    it('should preserve chunk data through serialization', async () => {
      await withStreamStore(async (store) => {
        const stream = createStream();
        await store.createStream(stream);

        const complexData = {
          type: 'tool-call',
          toolName: 'search',
          args: { query: 'hello world', limit: 10 },
        };
        await store.appendChunks([createChunk(stream.id, 0, complexData)]);

        const chunks = await store.getChunks(stream.id);
        assert.deepStrictEqual(chunks[0].data, complexData);
      });
    });

    it('should return empty array for stream with no chunks', async () => {
      await withStreamStore(async (store) => {
        const stream = createStream();
        await store.createStream(stream);

        const chunks = await store.getChunks(stream.id);
        assert.strictEqual(chunks.length, 0);
      });
    });
  });

  describe('appendChunks (batch)', () => {
    it('should append multiple chunks in a single batch', async () => {
      await withStreamStore(async (store) => {
        const stream = createStream();
        await store.createStream(stream);

        const chunks = Array.from({ length: 20 }, (_, i) =>
          createChunk(stream.id, i),
        );
        await store.appendChunks(chunks);

        const retrieved = await store.getChunks(stream.id);
        assert.strictEqual(retrieved.length, 20);
        assert.strictEqual(retrieved[0].seq, 0);
        assert.strictEqual(retrieved[19].seq, 19);
      });
    });

    it('should handle empty batch', async () => {
      await withStreamStore(async (store) => {
        await store.appendChunks([]);
      });
    });
  });

  describe('deleteStream', () => {
    it('should delete stream and cascade to chunks', async () => {
      await withStreamStore(async (store) => {
        const stream = createStream();
        await store.createStream(stream);

        for (let i = 0; i < 5; i++) {
          await store.appendChunks([createChunk(stream.id, i)]);
        }

        await store.deleteStream(stream.id);

        const deleted = await store.getStream(stream.id);
        assert.strictEqual(deleted, undefined);

        const chunks = await store.getChunks(stream.id);
        assert.strictEqual(chunks.length, 0);
      });
    });

    it('should not affect other streams when deleting one', async () => {
      await withStreamStore(async (store) => {
        const stream1 = createStream();
        const stream2 = createStream();
        await store.createStream(stream1);
        await store.createStream(stream2);

        await store.appendChunks([createChunk(stream1.id, 0)]);
        await store.appendChunks([createChunk(stream2.id, 0)]);

        await store.deleteStream(stream1.id);

        const remaining = await store.getStream(stream2.id);
        assert.ok(remaining);

        const remainingChunks = await store.getChunks(stream2.id);
        assert.strictEqual(remainingChunks.length, 1);
      });
    });
  });

  describe('Full lifecycle', () => {
    it('should handle queued → running → append → complete → cleanup flow', async () => {
      await withStreamStore(async (store) => {
        const stream = createStream();
        await store.createStream(stream);

        await store.updateStreamStatus(stream.id, 'running');

        const running = await store.getStream(stream.id);
        assert.ok(running);
        assert.strictEqual(running.status, 'running');

        const chunkTypes = [
          { type: 'text-start', id: 'part-1' },
          { type: 'text-delta', id: 'part-1', delta: 'Hello ' },
          { type: 'text-delta', id: 'part-1', delta: 'world' },
          { type: 'text-end', id: 'part-1' },
          { type: 'finish' },
        ];

        for (let i = 0; i < chunkTypes.length; i++) {
          await store.appendChunks([createChunk(stream.id, i, chunkTypes[i])]);
        }

        await store.updateStreamStatus(stream.id, 'completed');

        const updated = await store.getStream(stream.id);
        assert.ok(updated);
        assert.ok(typeof updated.startedAt === 'number');
        assert.ok(typeof updated.finishedAt === 'number');

        const allChunks = await store.getChunks(stream.id);
        assert.strictEqual(allChunks.length, 5);
        assert.deepStrictEqual(allChunks[4].data, { type: 'finish' });

        await store.deleteStream(stream.id);

        const afterCleanup = await store.getChunks(stream.id);
        assert.strictEqual(afterCleanup.length, 0);
      });
    });
  });

  describe('StreamManager.register', () => {
    it('should create a queued stream', async () => {
      await withStreamStore(async (store) => {
        const streams = new StreamManager({ store });
        const streamId = crypto.randomUUID();
        await streams.register(streamId);

        const stream = await store.getStream(streamId);
        assert.ok(stream);
        assert.strictEqual(stream.status, 'queued');
        assert.strictEqual(stream.startedAt, null);
      });
    });
  });

  describe('StreamManager.watch()', () => {
    it('should throw when stream does not exist', async () => {
      await withStreamStore(async (store) => {
        const streams = new StreamManager({ store });

        const readable = streams.watch('non-existent');
        const reader = readable.getReader();
        await assert.rejects(
          () => reader.read(),
          /Stream "non-existent" not found/,
        );
      });
    });

    it('should replay all chunks from a completed stream', async () => {
      await withStreamStore(async (store) => {
        const streams = new StreamManager({ store });

        const stream = createStream({
          status: 'running',
          startedAt: Date.now(),
        });
        await store.createStream(stream);

        for (let i = 0; i < 5; i++) {
          await store.appendChunks([createChunk(stream.id, i)]);
        }
        await store.updateStreamStatus(stream.id, 'completed');

        const received: unknown[] = [];
        const readable = streams.watch(stream.id);
        for await (const chunk of readable) {
          received.push(chunk);
        }

        assert.strictEqual(received.length, 5);
        assert.deepStrictEqual(received[0], {
          type: 'text-delta',
          delta: 'chunk-0',
        });
        assert.deepStrictEqual(received[4], {
          type: 'text-delta',
          delta: 'chunk-4',
        });
      });
    });

    it('should catchup then live-tail until stream completes', async () => {
      await withStreamStore(async (store) => {
        const streams = new StreamManager({ store });

        const stream = createStream({
          status: 'running',
          startedAt: Date.now(),
        });
        await store.createStream(stream);

        await store.appendChunks([createChunk(stream.id, 0)]);
        await store.appendChunks([createChunk(stream.id, 1)]);

        const received: unknown[] = [];
        const readable = streams.watch(stream.id, { interval: 20 });

        setTimeout(async () => {
          await store.appendChunks([createChunk(stream.id, 2)]);
          await store.appendChunks([createChunk(stream.id, 3)]);
          await store.updateStreamStatus(stream.id, 'completed');
        }, 60);

        for await (const chunk of readable) {
          received.push(chunk);
        }

        assert.strictEqual(received.length, 4);
        assert.deepStrictEqual(received[0], {
          type: 'text-delta',
          delta: 'chunk-0',
        });
        assert.deepStrictEqual(received[3], {
          type: 'text-delta',
          delta: 'chunk-3',
        });
      });
    });

    it('should close normally when stream status is failed', async () => {
      await withStreamStore(async (store) => {
        const streams = new StreamManager({ store });

        const stream = createStream({
          status: 'running',
          startedAt: Date.now(),
        });
        await store.createStream(stream);

        await store.appendChunks([createChunk(stream.id, 0)]);

        setTimeout(async () => {
          await store.appendChunks([createChunk(stream.id, 1)]);
          await store.updateStreamStatus(stream.id, 'failed', {
            error: 'test error',
          });
        }, 60);

        const received: unknown[] = [];
        const readable = streams.watch(stream.id, { interval: 20 });
        for await (const chunk of readable) {
          received.push(chunk);
        }

        assert.strictEqual(received.length, 2);

        const updated = await store.getStream(stream.id);
        assert.ok(updated);
        assert.strictEqual(updated.error, 'test error');
      });
    });

    it('should close when stream is cancelled', async () => {
      await withStreamStore(async (store) => {
        const streams = new StreamManager({ store });

        const stream = createStream({
          status: 'running',
          startedAt: Date.now(),
        });
        await store.createStream(stream);

        await store.appendChunks([createChunk(stream.id, 0)]);
        await store.updateStreamStatus(stream.id, 'cancelled');

        const received: unknown[] = [];
        const readable = streams.watch(stream.id, { interval: 20 });
        for await (const chunk of readable) {
          received.push(chunk);
        }

        assert.strictEqual(received.length, 1);

        const updated = await store.getStream(stream.id);
        assert.ok(updated);
        assert.strictEqual(updated.status, 'cancelled');
        assert.ok(typeof updated.cancelRequestedAt === 'number');
      });
    });

    it('should watch a queued stream that transitions to running then completed', async () => {
      await withStreamStore(async (store) => {
        const streams = new StreamManager({ store });

        const stream = createStream({ status: 'queued' });
        await store.createStream(stream);

        const received: unknown[] = [];
        const readable = streams.watch(stream.id, { interval: 20 });

        setTimeout(async () => {
          await store.updateStreamStatus(stream.id, 'running');
          await store.appendChunks([createChunk(stream.id, 0)]);
          await store.appendChunks([createChunk(stream.id, 1)]);
          await store.updateStreamStatus(stream.id, 'completed');
        }, 60);

        for await (const chunk of readable) {
          received.push(chunk);
        }

        assert.strictEqual(received.length, 2);
        assert.deepStrictEqual(received[0], {
          type: 'text-delta',
          delta: 'chunk-0',
        });
        assert.deepStrictEqual(received[1], {
          type: 'text-delta',
          delta: 'chunk-1',
        });
      });
    });
  });

  describe('StreamManager.watch() detach is passive', () => {
    it('should NOT change stream status when reader detaches', async () => {
      await withStreamStore(async (store) => {
        const streams = new StreamManager({ store });

        const stream = createStream({
          status: 'running',
          startedAt: Date.now(),
        });
        await store.createStream(stream);

        await store.appendChunks([createChunk(stream.id, 0)]);

        const readable = streams.watch(stream.id, { interval: 20 });
        const reader = readable.getReader();

        const first = await reader.read();
        assert.ok(!first.done);

        await reader.cancel();

        const updated = await store.getStream(stream.id);
        assert.ok(updated);
        assert.strictEqual(updated.status, 'running');
      });
    });
  });

  describe('StreamManager.cancel()', () => {
    it('should set stream status to cancelled', async () => {
      await withStreamStore(async (store) => {
        const streams = new StreamManager({ store });

        const stream = createStream({
          status: 'running',
          startedAt: Date.now(),
        });
        await store.createStream(stream);

        await streams.cancel(stream.id);

        const updated = await store.getStream(stream.id);
        assert.ok(updated);
        assert.strictEqual(updated.status, 'cancelled');
        assert.ok(typeof updated.cancelRequestedAt === 'number');
      });
    });

    it('should cause watcher to close after cancel', async () => {
      await withStreamStore(async (store) => {
        const streams = new StreamManager({ store });

        const stream = createStream({
          status: 'running',
          startedAt: Date.now(),
        });
        await store.createStream(stream);

        await store.appendChunks([createChunk(stream.id, 0)]);

        const received: unknown[] = [];
        const readable = streams.watch(stream.id, { interval: 20 });

        globalThis.setTimeout(async () => {
          await store.appendChunks([createChunk(stream.id, 1)]);
          await streams.cancel(stream.id);
        }, 60);

        for await (const chunk of readable) {
          received.push(chunk);
        }

        assert.strictEqual(received.length, 2);

        const updated = await store.getStream(stream.id);
        assert.ok(updated);
        assert.strictEqual(updated.status, 'cancelled');
      });
    });
  });

  describe('StreamManager.persist() terminal state guard', () => {
    it('should return early without changing status when stream is cancelled', async () => {
      await withStreamStore(async (store) => {
        const streams = new StreamManager({ store });
        const stream = createStream({
          status: 'cancelled',
          startedAt: Date.now(),
          finishedAt: Date.now(),
          cancelRequestedAt: Date.now(),
        });
        await store.createStream(stream);

        const dummy = new ReadableStream({
          start(c) {
            c.close();
          },
        });
        const result = await streams.persist(dummy, stream.id);

        assert.strictEqual(result.streamId, stream.id);
        const after = await store.getStream(stream.id);
        assert.ok(after);
        assert.strictEqual(after.status, 'cancelled');
      });
    });

    it('should return early without changing status when stream is completed', async () => {
      await withStreamStore(async (store) => {
        const streams = new StreamManager({ store });
        const stream = createStream({
          status: 'completed',
          startedAt: Date.now(),
          finishedAt: Date.now(),
        });
        await store.createStream(stream);

        const dummy = new ReadableStream({
          start(c) {
            c.close();
          },
        });
        const result = await streams.persist(dummy, stream.id);

        assert.strictEqual(result.streamId, stream.id);
        const after = await store.getStream(stream.id);
        assert.ok(after);
        assert.strictEqual(after.status, 'completed');
      });
    });

    it('should return early without changing status when stream is failed', async () => {
      await withStreamStore(async (store) => {
        const streams = new StreamManager({ store });
        const stream = createStream({
          status: 'failed',
          startedAt: Date.now(),
          finishedAt: Date.now(),
          error: 'previous error',
        });
        await store.createStream(stream);

        const dummy = new ReadableStream({
          start(c) {
            c.close();
          },
        });
        const result = await streams.persist(dummy, stream.id);

        assert.strictEqual(result.streamId, stream.id);
        const after = await store.getStream(stream.id);
        assert.ok(after);
        assert.strictEqual(after.status, 'failed');
        assert.strictEqual(after.error, 'previous error');
      });
    });
  });

  describe('StreamManager.cleanup', () => {
    it('should delete stream and all chunks', async () => {
      await withStreamStore(async (store) => {
        const streams = new StreamManager({ store });
        const streamId = crypto.randomUUID();
        await streams.register(streamId);

        await store.appendChunks([createChunk(streamId, 0)]);
        await store.appendChunks([createChunk(streamId, 1)]);

        await streams.cleanup(streamId);

        const deleted = await store.getStream(streamId);
        assert.strictEqual(deleted, undefined);
        const chunks = await store.getChunks(streamId);
        assert.strictEqual(chunks.length, 0);
      });
    });
  });
});
