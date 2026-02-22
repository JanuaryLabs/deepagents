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

  describe('upsertStream', () => {
    it('should create a new stream and return created: true', async () => {
      await withStreamStore(async (store) => {
        const stream = createStream();
        const result = await store.upsertStream(stream);

        assert.strictEqual(result.created, true);
        assert.strictEqual(result.stream.id, stream.id);
        assert.strictEqual(result.stream.status, 'queued');
        assert.strictEqual(result.stream.createdAt, stream.createdAt);
      });
    });

    it('should return existing stream unchanged with created: false on conflict', async () => {
      await withStreamStore(async (store) => {
        const stream = createStream();
        const first = await store.upsertStream(stream);
        assert.strictEqual(first.created, true);

        await store.updateStreamStatus(stream.id, 'running');

        const second = await store.upsertStream({
          ...stream,
          createdAt: Date.now() + 1000,
        });

        assert.strictEqual(second.created, false);
        assert.strictEqual(second.stream.status, 'running');
        assert.strictEqual(second.stream.createdAt, stream.createdAt);
      });
    });

    it('should not overwrite existing stream data with conflicting input', async () => {
      await withStreamStore(async (store) => {
        const original = createStream();
        await store.upsertStream(original);

        const conflicting = {
          ...original,
          status: 'running' as const,
          createdAt: Date.now() + 9999,
        };
        const result = await store.upsertStream(conflicting);

        assert.strictEqual(result.created, false);
        assert.strictEqual(result.stream.status, 'queued');
        assert.strictEqual(result.stream.createdAt, original.createdAt);
      });
    });

    it('should preserve completed stream with finishedAt on conflict', async () => {
      await withStreamStore(async (store) => {
        const stream = createStream();
        await store.upsertStream(stream);
        await store.updateStreamStatus(stream.id, 'running');
        await store.updateStreamStatus(stream.id, 'completed');

        const result = await store.upsertStream({
          ...stream,
          createdAt: Date.now() + 1000,
        });

        assert.strictEqual(result.created, false);
        assert.strictEqual(result.stream.status, 'completed');
        assert.ok(result.stream.finishedAt);
      });
    });

    it('should preserve failed stream with error field on conflict', async () => {
      await withStreamStore(async (store) => {
        const stream = createStream();
        await store.upsertStream(stream);
        await store.updateStreamStatus(stream.id, 'running');
        await store.updateStreamStatus(stream.id, 'failed', {
          error: 'something broke',
        });

        const result = await store.upsertStream({
          ...stream,
          createdAt: Date.now() + 1000,
        });

        assert.strictEqual(result.created, false);
        assert.strictEqual(result.stream.status, 'failed');
        assert.strictEqual(result.stream.error, 'something broke');
        assert.ok(result.stream.finishedAt);
      });
    });

    it('should preserve cancelled stream with cancelRequestedAt on conflict', async () => {
      await withStreamStore(async (store) => {
        const stream = createStream();
        await store.upsertStream(stream);
        await store.updateStreamStatus(stream.id, 'cancelled');

        const result = await store.upsertStream({
          ...stream,
          createdAt: Date.now() + 1000,
        });

        assert.strictEqual(result.created, false);
        assert.strictEqual(result.stream.status, 'cancelled');
        assert.ok(result.stream.cancelRequestedAt);
        assert.ok(result.stream.finishedAt);
      });
    });

    it('should treat deleted stream as fresh insert on re-upsert', async () => {
      await withStreamStore(async (store) => {
        const stream = createStream();
        await store.upsertStream(stream);
        await store.deleteStream(stream.id);

        const result = await store.upsertStream({
          ...stream,
          createdAt: Date.now() + 5000,
        });

        assert.strictEqual(result.created, true);
        assert.strictEqual(result.stream.status, 'queued');
      });
    });

    it('should not disturb existing chunks on conflict', async () => {
      await withStreamStore(async (store) => {
        const stream = createStream();
        await store.upsertStream(stream);
        await store.updateStreamStatus(stream.id, 'running');

        const chunks = [
          createChunk(stream.id, 0),
          createChunk(stream.id, 1),
          createChunk(stream.id, 2),
        ];
        await store.appendChunks(chunks);

        await store.upsertStream({
          ...stream,
          createdAt: Date.now() + 1000,
        });

        const retrieved = await store.getChunks(stream.id);
        assert.strictEqual(retrieved.length, 3);
        assert.strictEqual(retrieved[0].seq, 0);
        assert.strictEqual(retrieved[1].seq, 1);
        assert.strictEqual(retrieved[2].seq, 2);
      });
    });
  });

  describe('StreamManager.register() idempotency', () => {
    it('should return created: true on first call', async () => {
      await withStreamStore(async (store) => {
        const manager = new StreamManager({ store });
        const streamId = crypto.randomUUID();
        const result = await manager.register(streamId);
        assert.strictEqual(result.created, true);
        assert.strictEqual(result.stream.id, streamId);
        assert.strictEqual(result.stream.status, 'queued');
      });
    });

    it('should return created: false on duplicate call', async () => {
      await withStreamStore(async (store) => {
        const manager = new StreamManager({ store });
        const streamId = crypto.randomUUID();
        await manager.register(streamId);
        const result = await manager.register(streamId);
        assert.strictEqual(result.created, false);
      });
    });

    it('should not overwrite status of existing stream', async () => {
      await withStreamStore(async (store) => {
        const manager = new StreamManager({ store });
        const streamId = crypto.randomUUID();
        await manager.register(streamId);
        await store.updateStreamStatus(streamId, 'running');

        const result = await manager.register(streamId);
        assert.strictEqual(result.stream.status, 'running');
      });
    });

    it('should not reset completed stream to queued', async () => {
      await withStreamStore(async (store) => {
        const manager = new StreamManager({ store });
        const streamId = crypto.randomUUID();
        await manager.register(streamId);
        await store.updateStreamStatus(streamId, 'running');
        await store.updateStreamStatus(streamId, 'completed');

        const result = await manager.register(streamId);
        assert.strictEqual(result.created, false);
        assert.strictEqual(result.stream.status, 'completed');
        assert.ok(result.stream.finishedAt);
      });
    });

    it('should not reset failed stream to queued', async () => {
      await withStreamStore(async (store) => {
        const manager = new StreamManager({ store });
        const streamId = crypto.randomUUID();
        await manager.register(streamId);
        await store.updateStreamStatus(streamId, 'running');
        await store.updateStreamStatus(streamId, 'failed', {
          error: 'timeout',
        });

        const result = await manager.register(streamId);
        assert.strictEqual(result.created, false);
        assert.strictEqual(result.stream.status, 'failed');
        assert.strictEqual(result.stream.error, 'timeout');
      });
    });

    it('should not reset cancelled stream to queued', async () => {
      await withStreamStore(async (store) => {
        const manager = new StreamManager({ store });
        const streamId = crypto.randomUUID();
        await manager.register(streamId);
        await store.updateStreamStatus(streamId, 'cancelled');

        const result = await manager.register(streamId);
        assert.strictEqual(result.created, false);
        assert.strictEqual(result.stream.status, 'cancelled');
        assert.ok(result.stream.cancelRequestedAt);
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

  describe('StreamManager.reopen()', () => {
    it('should reopen a completed stream as queued with no old chunks', async () => {
      await withStreamStore(async (store) => {
        const streams = new StreamManager({ store });
        const streamId = crypto.randomUUID();

        await streams.register(streamId);
        await store.updateStreamStatus(streamId, 'running');
        await store.appendChunks([
          createChunk(streamId, 0),
          createChunk(streamId, 1),
        ]);
        await store.updateStreamStatus(streamId, 'completed');

        const result = await streams.reopen(streamId);

        assert.strictEqual(result.created, true);
        assert.strictEqual(result.stream.status, 'queued');
        assert.strictEqual(result.stream.startedAt, null);
        assert.strictEqual(result.stream.finishedAt, null);
        assert.strictEqual(result.stream.error, null);

        const chunks = await store.getChunks(streamId);
        assert.strictEqual(chunks.length, 0);
      });
    });

    it('should reopen a failed stream', async () => {
      await withStreamStore(async (store) => {
        const streams = new StreamManager({ store });
        const streamId = crypto.randomUUID();

        await streams.register(streamId);
        await store.updateStreamStatus(streamId, 'running');
        await store.appendChunks([createChunk(streamId, 0)]);
        await store.updateStreamStatus(streamId, 'failed', {
          error: 'API timeout',
        });

        const result = await streams.reopen(streamId);

        assert.strictEqual(result.created, true);
        assert.strictEqual(result.stream.status, 'queued');
        assert.strictEqual(result.stream.error, null);

        const chunks = await store.getChunks(streamId);
        assert.strictEqual(chunks.length, 0);
      });
    });

    it('should reopen a cancelled stream', async () => {
      await withStreamStore(async (store) => {
        const streams = new StreamManager({ store });
        const streamId = crypto.randomUUID();

        await streams.register(streamId);
        await store.updateStreamStatus(streamId, 'cancelled');

        const result = await streams.reopen(streamId);

        assert.strictEqual(result.created, true);
        assert.strictEqual(result.stream.status, 'queued');
        assert.strictEqual(result.stream.cancelRequestedAt, null);
      });
    });

    it('should throw when trying to reopen a running stream', async () => {
      await withStreamStore(async (store) => {
        const streams = new StreamManager({ store });
        const streamId = crypto.randomUUID();

        await streams.register(streamId);
        await store.updateStreamStatus(streamId, 'running');

        await assert.rejects(
          () => streams.reopen(streamId),
          /Cannot reopen stream .* with status "running"/,
        );

        const unchanged = await store.getStream(streamId);
        assert.ok(unchanged);
        assert.strictEqual(unchanged.status, 'running');
      });
    });

    it('should throw when trying to reopen a queued stream', async () => {
      await withStreamStore(async (store) => {
        const streams = new StreamManager({ store });
        const streamId = crypto.randomUUID();

        await streams.register(streamId);

        await assert.rejects(
          () => streams.reopen(streamId),
          /Cannot reopen stream .* with status "queued"/,
        );
      });
    });

    it('should throw for a non-existent stream', async () => {
      await withStreamStore(async (store) => {
        const streams = new StreamManager({ store });
        const streamId = crypto.randomUUID();

        await assert.rejects(
          () => streams.reopen(streamId),
          /Stream .* not found/,
        );
      });
    });

    it('should throw on double reopen (second call sees queued status)', async () => {
      await withStreamStore(async (store) => {
        const streams = new StreamManager({ store });
        const streamId = crypto.randomUUID();

        await streams.register(streamId);
        await store.updateStreamStatus(streamId, 'running');
        await store.updateStreamStatus(streamId, 'completed');

        await streams.reopen(streamId);

        await assert.rejects(
          () => streams.reopen(streamId),
          /Cannot reopen stream .* with status "queued"/,
        );
      });
    });

    it('should allow persist() after reopen()', async () => {
      await withStreamStore(async (store) => {
        const streams = new StreamManager({ store });
        const streamId = crypto.randomUUID();

        await streams.register(streamId);
        await store.updateStreamStatus(streamId, 'running');
        await store.appendChunks([createChunk(streamId, 0)]);
        await store.updateStreamStatus(streamId, 'completed');

        await streams.reopen(streamId);

        const newStream = new ReadableStream({
          start(controller) {
            controller.enqueue({
              type: 'text-start',
              id: 'new-part',
            });
            controller.enqueue({
              type: 'text-delta',
              id: 'new-part',
              delta: 'reopened content',
            });
            controller.enqueue({
              type: 'text-end',
              id: 'new-part',
            });
            controller.close();
          },
        });

        await streams.persist(newStream, streamId, { strategy: 'immediate' });

        const after = await store.getStream(streamId);
        assert.ok(after);
        assert.strictEqual(after.status, 'completed');

        const chunks = await store.getChunks(streamId);
        assert.ok(chunks.length >= 3);
        assert.deepStrictEqual(chunks[0].data, {
          type: 'text-start',
          id: 'new-part',
        });
      });
    });
  });
});
