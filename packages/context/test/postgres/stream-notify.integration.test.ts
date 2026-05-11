import assert from 'node:assert';
import { describe, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { Pool } from 'pg';

import {
  PostgresNotifyChangeSource,
  PostgresStreamStore,
  type StreamChange,
  type StreamChunkData,
  type StreamData,
  StreamManager,
} from '@deepagents/context';
import { withPostgresContainer } from '@deepagents/test';

const POSTGRES_18 = { image: 'postgres:18-alpine' };
const NO_CHANGE = Symbol('no-change');

function testSchema(): string {
  return `stream_notify_${crypto.randomUUID().replaceAll('-', '_')}`;
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

async function withNotifySource<T>(
  fn: (
    store: PostgresStreamStore,
    source: PostgresNotifyChangeSource,
    connectionString: string,
  ) => Promise<T>,
): Promise<T | undefined> {
  return await withPostgresContainer(async (container) => {
    const schema = testSchema();
    const store = new PostgresStreamStore({
      pool: container.connectionString,
      schema,
    });
    const source = new PostgresNotifyChangeSource({
      pool: container.connectionString,
      schema,
    });
    await store.initialize();
    await source.initialize();
    try {
      return await fn(store, source, container.connectionString);
    } finally {
      await source.close();
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

async function expectNoChange(
  promise: Promise<IteratorResult<StreamChange>>,
  label: string,
): Promise<void> {
  const result = await Promise.race([
    promise,
    sleep(150).then(() => NO_CHANGE),
  ]);
  assert.strictEqual(result, NO_CHANGE, label);
}

describe('PostgreSQL Notify StreamChangeSource Integration', () => {
  it('should fail notify setup with PostgreSQL table-not-found when base stream tables are missing', async () =>
    await withPostgresContainer(async (container) => {
      const source = new PostgresNotifyChangeSource({
        pool: container.connectionString,
        schema: testSchema(),
      });
      try {
        await assert.rejects(
          () => source.initialize(),
          (error: unknown) =>
            typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            error.code === '42P01',
        );
      } finally {
        await source.close();
      }
    }, POSTGRES_18));

  it('should receive chunk and terminal status wakeups through LISTEN/NOTIFY', async () =>
    await withNotifySource(async (store, source) => {
      const stream = createStream({
        status: 'running',
        startedAt: Date.now(),
      });
      await store.createStream(stream);

      const ac = new AbortController();
      const iterator = source
        .subscribe(stream.id, ac.signal)
        [Symbol.asyncIterator]();
      try {
        assert.deepStrictEqual(
          await withTimeout(iterator.next(), 'initial tick'),
          {
            value: { kind: 'tick' },
            done: false,
          },
        );

        const nextChunk = iterator.next();
        await store.appendChunks([createChunk(stream.id, 0)]);
        assert.deepStrictEqual(
          await withTimeout(nextChunk, 'chunk notification'),
          {
            value: { kind: 'chunks' },
            done: false,
          },
        );

        const nextStatus = iterator.next();
        await store.updateStreamStatus(stream.id, 'completed');
        assert.deepStrictEqual(
          await withTimeout(nextStatus, 'status notification'),
          {
            value: { kind: 'status' },
            done: false,
          },
        );
      } finally {
        ac.abort();
        await iterator.return?.();
      }
    }));

  it('should filter unrelated stream IDs and schemas', async () =>
    await withNotifySource(async (store, source, connectionString) => {
      const watched = createStream({ id: 'watched', status: 'running' });
      const other = createStream({ id: 'other', status: 'running' });
      await store.createStream(watched);
      await store.createStream(other);

      const otherSchema = testSchema();
      const otherStore = new PostgresStreamStore({
        pool: connectionString,
        schema: otherSchema,
      });
      const otherSource = new PostgresNotifyChangeSource({
        pool: connectionString,
        schema: otherSchema,
      });
      await otherStore.initialize();
      await otherSource.initialize();

      const ac = new AbortController();
      const iterator = source
        .subscribe(watched.id, ac.signal)
        [Symbol.asyncIterator]();

      try {
        await withTimeout(iterator.next(), 'initial tick');

        const pending = iterator.next();
        await store.appendChunks([createChunk(other.id, 0)]);
        await expectNoChange(pending, 'unrelated stream id should be ignored');

        const otherSchemaStream = createStream({
          id: watched.id,
          status: 'running',
        });
        await otherStore.createStream(otherSchemaStream);
        await otherStore.appendChunks([createChunk(otherSchemaStream.id, 0)]);
        await expectNoChange(pending, 'unrelated schema should be ignored');

        await store.appendChunks([createChunk(watched.id, 0)]);
        assert.deepStrictEqual(
          await withTimeout(pending, 'watched stream notification'),
          {
            value: { kind: 'chunks' },
            done: false,
          },
        );
      } finally {
        ac.abort();
        await iterator.return?.();
        await otherSource.close();
        await otherStore.close();
      }
    }));

  it('should let StreamManager drain chunks written before subscription readiness', async () =>
    await withNotifySource(async (store, source) => {
      const stream = createStream({
        status: 'running',
        startedAt: Date.now(),
      });
      await store.createStream(stream);
      await store.appendChunks([createChunk(stream.id, 0)]);
      await store.updateStreamStatus(stream.id, 'completed');

      const manager = new StreamManager({ store, changeSource: source });
      const received: unknown[] = [];
      await withTimeout(
        (async () => {
          for await (const chunk of manager.watch(stream.id)) {
            received.push(chunk);
          }
        })(),
        'initial tick stream drain',
      );

      assert.deepStrictEqual(received, [
        { type: 'text-delta', delta: 'chunk-0' },
      ]);
    }));

  it('should release the listener connection on abort and close', async () =>
    await withPostgresContainer(async (container) => {
      const schema = testSchema();
      const pool = new Pool({
        connectionString: container.connectionString,
        max: 1,
      });
      const store = new PostgresStreamStore({ pool, schema });
      const source = new PostgresNotifyChangeSource({ pool, schema });
      await store.initialize();
      await source.initialize();

      const ac = new AbortController();
      const iterator = source
        .subscribe('stream-without-row', ac.signal)
        [Symbol.asyncIterator]();

      try {
        await withTimeout(iterator.next(), 'initial tick');
        ac.abort();
        await withTimeout(
          iterator.return?.() ??
            Promise.resolve({
              done: true,
              value: undefined,
            } as IteratorResult<StreamChange>),
          'iterator return',
        );

        const result = await withTimeout(
          pool.query('SELECT 1 AS ok'),
          'pool query after abort',
        );
        assert.strictEqual(result.rows[0].ok, 1);

        await source.close();
        const afterClose = await withTimeout(
          pool.query('SELECT 1 AS ok'),
          'pool query after close',
        );
        assert.strictEqual(afterClose.rows[0].ok, 1);
      } finally {
        ac.abort();
        await iterator.return?.();
        await source.close();
        await store.close();
        await pool.end();
      }
    }, POSTGRES_18));

  it('should not leak a listener when closed during LISTEN setup', async () =>
    await withPostgresContainer(async (container) => {
      const schema = testSchema();
      const pool = new Pool({
        connectionString: container.connectionString,
        max: 1,
      });
      const store = new PostgresStreamStore({ pool, schema });
      const source = new PostgresNotifyChangeSource({ pool, schema });
      await store.initialize();
      await source.initialize();

      const blocker = await pool.connect();
      let blockerReleased = false;
      const ac = new AbortController();
      const iterator = source
        .subscribe('pending-listen-stream', ac.signal)
        [Symbol.asyncIterator]();
      const first = iterator.next();

      try {
        const closePromise = source.close();
        await sleep(25);
        blocker.release();
        blockerReleased = true;

        await withTimeout(closePromise, 'close during LISTEN setup');
        assert.deepStrictEqual(await withTimeout(first, 'pending subscribe'), {
          value: undefined,
          done: true,
        });

        const result = await withTimeout(
          pool.query('SELECT 1 AS ok'),
          'pool query after listen race',
        );
        assert.strictEqual(result.rows[0].ok, 1);
      } finally {
        ac.abort();
        if (!blockerReleased) {
          blocker.release();
        }
        await iterator.return?.();
        await source.close();
        await store.close();
        await pool.end();
      }
    }, POSTGRES_18));
});
