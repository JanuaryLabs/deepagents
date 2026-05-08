import assert from 'node:assert';
import { describe, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import {
  PollingChangeSource,
  PostgresStreamStore,
  type StreamChunkData,
  type StreamData,
  StreamManager,
} from '@deepagents/context';
import { withPostgresContainer } from '@deepagents/test';

const POSTGRES_18 = { image: 'postgres:18-alpine' };

function testSchema(): string {
  return `stream_test_${crypto.randomUUID().replaceAll('-', '_')}`;
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

async function withStore<T>(
  fn: (store: PostgresStreamStore) => Promise<T>,
): Promise<T | undefined> {
  return await withPostgresContainer(async (container) => {
    const store = new PostgresStreamStore({
      pool: container.connectionString,
      schema: testSchema(),
    });
    await store.initialize();
    try {
      return await fn(store);
    } finally {
      await store.close();
    }
  }, POSTGRES_18);
}

async function withTimeout<T>(
  promise: Promise<T>,
  label: string,
  timeoutMs = 5_000,
): Promise<T> {
  return await Promise.race([
    promise,
    sleep(timeoutMs).then(() => {
      throw new Error(`${label} timed out after ${timeoutMs}ms`);
    }),
  ]);
}

describe('PostgreSQL StreamStore Integration', () => {
  it('should require initialize before querying', async () =>
    await withPostgresContainer(async (container) => {
      const store = new PostgresStreamStore({
        pool: container.connectionString,
        schema: testSchema(),
      });
      try {
        await assert.rejects(
          () => store.getStream('missing'),
          /PostgresStreamStore not initialized/,
        );
      } finally {
        await store.close();
      }
    }, POSTGRES_18));

  it('should create, upsert, retrieve, update, and list streams', async () =>
    await withStore(async (store) => {
      const stream = createStream({
        id: 'stream-a',
        createdAt: 100,
      });

      await store.createStream(stream);
      assert.deepStrictEqual(await store.getStream(stream.id), stream);

      const existing = await store.upsertStream({
        ...stream,
        status: 'running',
        createdAt: 200,
      });
      assert.strictEqual(existing.created, false);
      assert.deepStrictEqual(existing.stream, stream);

      const inserted = await store.upsertStream(
        createStream({
          id: 'stream-b',
          status: 'running',
          createdAt: 50,
          startedAt: 60,
        }),
      );
      assert.strictEqual(inserted.created, true);

      assert.deepStrictEqual(await store.listStreamIds(), [
        'stream-b',
        'stream-a',
      ]);
      assert.deepStrictEqual(await store.listStreamIds({ status: 'running' }), [
        'stream-b',
      ]);

      await store.updateStreamStatus('stream-a', 'running');
      assert.strictEqual(await store.getStreamStatus('stream-a'), 'running');

      await store.updateStreamStatus('stream-a', 'failed', {
        error: 'boom',
      });
      const failed = await store.getStream('stream-a');
      assert.ok(failed);
      assert.strictEqual(failed.status, 'failed');
      assert.strictEqual(failed.error, 'boom');
      assert.ok(failed.startedAt);
      assert.ok(failed.finishedAt);
    }));

  it('should append and read JSONB chunks with ordering, paging, and multi-stream batches', async () =>
    await withStore(async (store) => {
      const streamA = createStream({ id: 'stream-a' });
      const streamB = createStream({ id: 'stream-b' });
      await store.createStream(streamA);
      await store.createStream(streamB);

      const payload = {
        type: 'tool-result',
        nested: { ok: true, count: 2 },
        items: ['a', 'b', null],
      };

      await store.appendChunks([
        createChunk(streamA.id, 0, { type: 'text-delta', delta: 'zero' }),
        createChunk(streamB.id, 0, { type: 'text-delta', delta: 'other' }),
        createChunk(streamA.id, 1, payload),
        createChunk(streamA.id, 2, { type: 'finish' }),
      ]);

      const allA = await store.getChunks(streamA.id);
      assert.deepStrictEqual(
        allA.map((chunk) => chunk.seq),
        [0, 1, 2],
      );
      assert.deepStrictEqual(allA[1].data, payload);

      const pagedA = await store.getChunks(streamA.id, 1, 1);
      assert.strictEqual(pagedA.length, 1);
      assert.strictEqual(pagedA[0].seq, 1);
      assert.deepStrictEqual(pagedA[0].data, payload);

      const allB = await store.getChunks(streamB.id);
      assert.strictEqual(allB.length, 1);
      assert.deepStrictEqual(allB[0].data, {
        type: 'text-delta',
        delta: 'other',
      });

      await store.appendChunks([]);
      assert.strictEqual((await store.getChunks(streamA.id)).length, 3);
    }));

  it('should delete chunks by cascade and reopen only terminal streams', async () =>
    await withStore(async (store) => {
      const queued = createStream({ id: 'queued' });
      const running = createStream({ id: 'running', status: 'running' });
      const completed = createStream({ id: 'completed', status: 'completed' });
      await store.createStream(queued);
      await store.createStream(running);
      await store.createStream(completed);
      await store.appendChunks([
        createChunk(completed.id, 0),
        createChunk(completed.id, 1),
      ]);

      await assert.rejects(
        () => store.reopenStream(queued.id),
        /Only terminal streams can be reopened/,
      );
      await assert.rejects(
        () => store.reopenStream(running.id),
        /Only terminal streams can be reopened/,
      );

      const reopened = await store.reopenStream(completed.id);
      assert.strictEqual(reopened.id, completed.id);
      assert.strictEqual(reopened.status, 'queued');
      assert.strictEqual(reopened.startedAt, null);
      assert.strictEqual(reopened.finishedAt, null);
      assert.deepStrictEqual(await store.getChunks(completed.id), []);

      await store.appendChunks([createChunk(reopened.id, 0)]);
      await store.deleteStream(reopened.id);
      assert.strictEqual(await store.getStream(reopened.id), undefined);
      assert.deepStrictEqual(await store.getChunks(reopened.id), []);
    }));

  it('should tail a PostgreSQL stream through PollingChangeSource without notify triggers', async () =>
    await withStore(async (store) => {
      const stream = createStream({
        status: 'running',
        startedAt: Date.now(),
      });
      await store.createStream(stream);
      await store.appendChunks([createChunk(stream.id, 0)]);

      const manager = new StreamManager({
        store,
        changeSource: new PollingChangeSource({
          reads: store,
          config: {
            minMs: 5,
            maxMs: 5,
            multiplier: 1,
            jitterRatio: 0,
            statusCheckEvery: 1,
          },
        }),
      });

      const received: unknown[] = [];
      const consume = (async () => {
        for await (const chunk of manager.watch(stream.id)) {
          received.push(chunk);
        }
      })();

      await store.appendChunks([createChunk(stream.id, 1)]);
      await store.updateStreamStatus(stream.id, 'completed');
      await withTimeout(consume, 'polling stream watch');

      assert.deepStrictEqual(received, [
        { type: 'text-delta', delta: 'chunk-0' },
        { type: 'text-delta', delta: 'chunk-1' },
      ]);
    }));
});
