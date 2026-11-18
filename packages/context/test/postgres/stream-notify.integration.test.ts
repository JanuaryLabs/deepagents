import { untilAborted } from '@zukhruf/async';
import { Postgres } from '@zukhruf/testing/postgres';
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

const POSTGRES_18 = { image: 'postgres:18-alpine' };

const testPostgres = new Postgres({ ...POSTGRES_18, environment: process.env });
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

function textDeltaChunk(
  seq: number,
  delta = `chunk-${seq}`,
): StreamChunkData['data'] {
  return { type: 'text-delta', id: `part-${seq}`, delta };
}

function createChunk(
  streamId: string,
  seq: number,
  data: StreamChunkData['data'] = textDeltaChunk(seq),
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
): Promise<T> {
  await using container = await testPostgres.database();

  const schema = testSchema();
  const store = await PostgresStreamStore.create({
    pool: container.connectionString,
    schema,
  });
  const source = await PostgresNotifyChangeSource.create({
    pool: container.connectionString,
    schema,
  });
  try {
    return await fn(store, source, container.connectionString);
  } finally {
    await source.close();
    await store.close();
  }
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
  it('installs its triggers while other sources install them at the same time', async (t) => {
    await using container = await testPostgres.database();
    const schema = testSchema();
    const store = await PostgresStreamStore.create({
      pool: container.connectionString,
      schema,
    });

    const results = await Promise.allSettled(
      Array.from({ length: 3 }, () =>
        PostgresNotifyChangeSource.create({
          pool: container.connectionString,
          schema,
        }),
      ),
    );
    const sources = results.flatMap((result) =>
      result.status === 'fulfilled' ? [result.value] : [],
    );
    const ac = new AbortController();
    try {
      assert.deepStrictEqual(
        results.map((result) =>
          result.status === 'fulfilled' ? 'opened' : result.reason.code,
        ),
        ['opened', 'opened', 'opened'],
      );
      const stream = createStream({ status: 'running', startedAt: Date.now() });
      await store.createStream(stream);
      const iterators = sources.map((source) =>
        source.subscribe(stream.id, ac.signal)[Symbol.asyncIterator](),
      );
      await Promise.all(
        iterators.map((iterator) => untilAborted(iterator.next(), t.signal)),
      );
      const nextChunks = iterators.map((iterator) => iterator.next());
      await store.appendChunks([createChunk(stream.id, 0)]);
      assert.deepStrictEqual(
        await Promise.all(
          nextChunks.map((next) => untilAborted(next, t.signal)),
        ),
        Array.from({ length: 3 }, () => ({
          value: { kind: 'chunks' },
          done: false,
        })),
      );
    } finally {
      ac.abort();
      await Promise.all(sources.map((source) => source.close()));
      await store.close();
    }
  });

  it('opens on installed triggers while other sources open at the same time', async (t) => {
    await using container = await testPostgres.database();
    const schema = testSchema();
    const store = await PostgresStreamStore.create({
      pool: container.connectionString,
      schema,
    });
    const initial = await PostgresNotifyChangeSource.create({
      pool: container.connectionString,
      schema,
    });
    await initial.close();

    const results = await Promise.allSettled(
      Array.from({ length: 3 }, () =>
        PostgresNotifyChangeSource.create({
          pool: container.connectionString,
          schema,
        }),
      ),
    );
    const sources = results.flatMap((result) =>
      result.status === 'fulfilled' ? [result.value] : [],
    );
    const ac = new AbortController();
    try {
      assert.deepStrictEqual(
        results.map((result) =>
          result.status === 'fulfilled' ? 'opened' : result.reason.code,
        ),
        ['opened', 'opened', 'opened'],
      );
      const stream = createStream({ status: 'running', startedAt: Date.now() });
      await store.createStream(stream);
      const iterators = sources.map((source) =>
        source.subscribe(stream.id, ac.signal)[Symbol.asyncIterator](),
      );
      await Promise.all(
        iterators.map((iterator) => untilAborted(iterator.next(), t.signal)),
      );
      const nextChunks = iterators.map((iterator) => iterator.next());
      await store.appendChunks([createChunk(stream.id, 0)]);
      assert.deepStrictEqual(
        await Promise.all(
          nextChunks.map((next) => untilAborted(next, t.signal)),
        ),
        Array.from({ length: 3 }, () => ({
          value: { kind: 'chunks' },
          done: false,
        })),
      );
    } finally {
      ac.abort();
      await Promise.all(sources.map((source) => source.close()));
      await store.close();
    }
  });

  it('should fail notify setup with PostgreSQL table-not-found when base stream tables are missing', async () => {
    await using container = await testPostgres.database();

    await assert.rejects(
      PostgresNotifyChangeSource.create({
        pool: container.connectionString,
        schema: testSchema(),
      }),
      (error: unknown) =>
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === '42P01',
    );
  });

  it('should receive chunk and terminal status wakeups through LISTEN/NOTIFY', async (t) =>
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
        assert.deepStrictEqual(await untilAborted(iterator.next(), t.signal), {
          value: { kind: 'tick' },
          done: false,
        });

        const nextChunk = iterator.next();
        await store.appendChunks([createChunk(stream.id, 0)]);
        assert.deepStrictEqual(await untilAborted(nextChunk, t.signal), {
          value: { kind: 'chunks' },
          done: false,
        });

        const nextStatus = iterator.next();
        await store.updateStreamStatus(stream.id, 'completed');
        assert.deepStrictEqual(await untilAborted(nextStatus, t.signal), {
          value: { kind: 'status' },
          done: false,
        });
      } finally {
        ac.abort();
        await iterator.return?.();
      }
    }));

  it('should filter unrelated stream IDs and schemas', async (t) =>
    await withNotifySource(async (store, source, connectionString) => {
      const watched = createStream({ id: 'watched', status: 'running' });
      const other = createStream({ id: 'other', status: 'running' });
      await store.createStream(watched);
      await store.createStream(other);

      const otherSchema = testSchema();
      const otherStore = await PostgresStreamStore.create({
        pool: connectionString,
        schema: otherSchema,
      });
      const otherSource = await PostgresNotifyChangeSource.create({
        pool: connectionString,
        schema: otherSchema,
      });

      const ac = new AbortController();
      const iterator = source
        .subscribe(watched.id, ac.signal)
        [Symbol.asyncIterator]();

      try {
        await untilAborted(iterator.next(), t.signal);

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
        assert.deepStrictEqual(await untilAborted(pending, t.signal), {
          value: { kind: 'chunks' },
          done: false,
        });
      } finally {
        ac.abort();
        await iterator.return?.();
        await otherSource.close();
        await otherStore.close();
      }
    }));

  it('should let StreamManager drain chunks written before subscription readiness', async (t) =>
    await withNotifySource(async (store, source) => {
      const stream = createStream({
        status: 'running',
        startedAt: Date.now(),
      });
      await store.createStream(stream);
      await store.appendChunks([createChunk(stream.id, 0)]);
      await store.updateStreamStatus(stream.id, 'completed');

      const manager = new StreamManager({ store, changeSource: source });
      const received = await untilAborted(
        Array.fromAsync(manager.watch(stream.id)),
        t.signal,
      );

      assert.deepStrictEqual(received, [textDeltaChunk(0)]);
    }));

  it('should release the listener connection on abort and close', async (t) => {
    await using container = await testPostgres.database();

    const schema = testSchema();
    const pool = new Pool({
      connectionString: container.connectionString,
      max: 1,
    });
    const store = await PostgresStreamStore.create({ pool, schema });
    const source = await PostgresNotifyChangeSource.create({ pool, schema });

    const ac = new AbortController();
    const iterator = source
      .subscribe('stream-without-row', ac.signal)
      [Symbol.asyncIterator]();

    try {
      await untilAborted(iterator.next(), t.signal);
      ac.abort();
      await untilAborted(
        iterator.return?.() ??
          Promise.resolve<IteratorResult<StreamChange>>({
            done: true,
            value: undefined,
          }),
        t.signal,
      );

      const result = await untilAborted(pool.query('SELECT 1 AS ok'), t.signal);
      assert.strictEqual(result.rows[0].ok, 1);

      await source.close();
      const afterClose = await untilAborted(
        pool.query('SELECT 1 AS ok'),
        t.signal,
      );
      assert.strictEqual(afterClose.rows[0].ok, 1);
    } finally {
      ac.abort();
      await iterator.return?.();
      await source.close();
      await store.close();
      await pool.end();
    }
  });

  it('should not leak a listener when closed during LISTEN setup', async (t) => {
    await using container = await testPostgres.database();

    const schema = testSchema();
    const pool = new Pool({
      connectionString: container.connectionString,
      max: 1,
    });
    const store = await PostgresStreamStore.create({ pool, schema });
    const source = await PostgresNotifyChangeSource.create({ pool, schema });

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

      await untilAborted(closePromise, t.signal);
      assert.deepStrictEqual(await untilAborted(first, t.signal), {
        value: undefined,
        done: true,
      });

      const result = await untilAborted(pool.query('SELECT 1 AS ok'), t.signal);
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
  });

  it('concurrent first subscribers share one LISTEN connection', async (t) =>
    await withNotifySource(async (_store, source, connectionString) => {
      const admin = new Pool({ connectionString, max: 1 });
      const ac = new AbortController();
      const first = source
        .subscribe('stream-a', ac.signal)
        [Symbol.asyncIterator]();
      const second = source
        .subscribe('stream-b', ac.signal)
        [Symbol.asyncIterator]();
      try {
        const ticks = await untilAborted(
          Promise.all([first.next(), second.next()]),
          t.signal,
        );
        assert.deepStrictEqual(
          ticks.map((tick) => tick.value),
          [{ kind: 'tick' }, { kind: 'tick' }],
        );

        const { rows } = await admin.query<{ listening: number }>(
          `SELECT count(*)::int AS listening FROM pg_stat_activity
           WHERE datname = current_database() AND query LIKE 'LISTEN %'`,
        );
        assert.strictEqual(rows[0].listening, 1);
      } finally {
        ac.abort();
        await first.return?.();
        await second.return?.();
        await admin.end();
      }
    }));

  it('a subscribe whose LISTEN setup fails rejects, and the next one listens', async (t) => {
    await using container = await testPostgres.database();
    const schema = testSchema();
    const pool = new Pool({
      connectionString: container.connectionString,
      max: 1,
      // Above one connect through an SSH forward to a remote engine.
      connectionTimeoutMillis: 2_000,
    });
    const store = await PostgresStreamStore.create({ pool, schema });
    const source = await PostgresNotifyChangeSource.create({ pool, schema });
    // Holds the pool's only connection, so the LISTEN setup cannot connect.
    const blocker = await pool.connect();
    let blockerReleased = false;
    const ac = new AbortController();
    const failing = source
      .subscribe('setup-failure', ac.signal)
      [Symbol.asyncIterator]();
    const retried = source
      .subscribe('setup-failure', ac.signal)
      [Symbol.asyncIterator]();
    try {
      await assert.rejects(untilAborted(failing.next(), t.signal), {
        message: /timeout exceeded when trying to connect/,
      });

      blocker.release();
      blockerReleased = true;
      assert.deepStrictEqual(await untilAborted(retried.next(), t.signal), {
        value: { kind: 'tick' },
        done: false,
      });
    } finally {
      ac.abort();
      if (!blockerReleased) {
        blocker.release();
      }
      await failing.return?.();
      await retried.return?.();
      await source.close();
      await store.close();
      await pool.end();
    }
  });

  it('fails subscribers when the LISTEN connection drops, then listens again', async (t) =>
    await withNotifySource(async (store, source, connectionString) => {
      const stream = createStream({
        status: 'running',
        startedAt: Date.now(),
      });
      await store.createStream(stream);
      const admin = new Pool({ connectionString, max: 1 });
      const ac = new AbortController();
      const dropped = source
        .subscribe(stream.id, ac.signal)
        [Symbol.asyncIterator]();
      const otherStream = source
        .subscribe('other-stream', ac.signal)
        [Symbol.asyncIterator]();
      const again = source
        .subscribe(stream.id, ac.signal)
        [Symbol.asyncIterator]();
      try {
        assert.deepStrictEqual(await untilAborted(dropped.next(), t.signal), {
          value: { kind: 'tick' },
          done: false,
        });
        assert.deepStrictEqual(
          await untilAborted(otherStream.next(), t.signal),
          { value: { kind: 'tick' }, done: false },
        );
        // Handled from the start: the drop can fail them before the query returns.
        const failures = Promise.all(
          [dropped, otherStream].map((subscription) =>
            assert.rejects(untilAborted(subscription.next(), t.signal), {
              message: /terminating connection due to administrator command/,
            }),
          ),
        );

        // What a database restart or an idle-connection kill does.
        const terminated = await admin.query(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
           WHERE datname = current_database()
             AND pid <> pg_backend_pid()
             AND query LIKE 'LISTEN %'`,
        );
        assert.strictEqual(terminated.rowCount, 1, 'one LISTEN connection');
        await failures;

        assert.deepStrictEqual(await untilAborted(again.next(), t.signal), {
          value: { kind: 'tick' },
          done: false,
        });
        const nextChunk = again.next();
        await store.appendChunks([createChunk(stream.id, 0)]);
        assert.deepStrictEqual(await untilAborted(nextChunk, t.signal), {
          value: { kind: 'chunks' },
          done: false,
        });
      } finally {
        ac.abort();
        await dropped.return?.();
        await otherStream.return?.();
        await again.return?.();
        await admin.end();
      }
    }));
});
