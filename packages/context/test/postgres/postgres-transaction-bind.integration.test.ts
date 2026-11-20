import { Postgres } from '@zukhruf/testing/postgres';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  PostgresContextStore,
  PostgresStreamStore,
  postgresTransaction,
} from '@deepagents/context';

const testPostgres = new Postgres({ environment: process.env });

const stream = (id: string) => ({
  id,
  status: 'queued' as const,
  createdAt: 1,
  startedAt: null,
  finishedAt: null,
  cancelRequestedAt: null,
  error: null,
});

test('writes through bound stores are gone when the transaction throws', async () => {
  await using database = await testPostgres.database();
  const pool = database.pool();
  const store = await PostgresContextStore.create({ pool });
  const streams = await PostgresStreamStore.create({ pool });

  await assert.rejects(
    postgresTransaction(pool, async (tx) => {
      await store.bind(tx).createChat({ id: 'chat-1', userId: 'user-1' });
      await streams.bind(tx).createStream(stream('stream-1'));
      await streams.bind(tx).appendChunks([
        {
          streamId: 'stream-1',
          seq: 0,
          data: { type: 'text-delta', id: 't', delta: 'hi' },
          createdAt: 2,
        },
      ]);
      throw new Error('admission refused');
    }),
    /admission refused/,
  );

  assert.deepStrictEqual(
    {
      chat: await store.getChat('chat-1'),
      stream: await streams.getStream('stream-1'),
      chunks: await streams.getChunks('stream-1'),
    },
    { chat: undefined, stream: undefined, chunks: [] },
  );
});

test('writes through bound stores are visible once the transaction commits', async () => {
  await using database = await testPostgres.database();
  const pool = database.pool();
  const store = await PostgresContextStore.create({ pool });
  const streams = await PostgresStreamStore.create({ pool });

  const update = await postgresTransaction(pool, async (tx) => {
    await store.bind(tx).createChat({ id: 'chat-1', userId: 'user-1' });
    await streams.bind(tx).createStream(stream('stream-1'));
    return streams
      .bind(tx)
      .updateStream('stream-1', () => ({ status: 'running', startedAt: 3 }));
  });

  const otherConnection = database.pool();
  const reader = await PostgresContextStore.create({ pool: otherConnection });
  const streamReader = await PostgresStreamStore.create({
    pool: otherConnection,
  });
  const running = { ...stream('stream-1'), status: 'running', startedAt: 3 };
  assert.deepStrictEqual(
    {
      update,
      chatUser: (await reader.getChat('chat-1'))?.userId,
      branch: (await reader.getActiveBranch('chat-1'))?.name,
      stream: await streamReader.getStream('stream-1'),
    },
    {
      update: { stream: running, updated: true },
      chatUser: 'user-1',
      branch: 'main',
      stream: running,
    },
  );
});

test('a bound store method that fails rolls back only its own savepoint', async () => {
  await using database = await testPostgres.database();
  const pool = database.pool();
  const store = await PostgresContextStore.create({ pool });
  const streams = await PostgresStreamStore.create({ pool });

  await postgresTransaction(pool, async (tx) => {
    const bound = store.bind(tx);
    await bound.createChat({ id: 'chat-1', userId: 'user-1' });
    await assert.rejects(
      bound.createChat({ id: 'chat-1', userId: 'user-1' }),
      /duplicate key/,
    );
    await assert.rejects(
      bound.updateChat('chat-1', () => {
        throw new Error('updater refused');
      }),
      /updater refused/,
    );
    await streams.bind(tx).createStream(stream('stream-1'));
  });

  assert.deepStrictEqual(
    {
      chatUser: (await store.getChat('chat-1'))?.userId,
      stream: (await streams.getStream('stream-1'))?.id,
    },
    { chatUser: 'user-1', stream: 'stream-1' },
  );
});

test('a nested postgresTransaction on a transaction discards only its own writes', async () => {
  await using database = await testPostgres.database();
  const pool = database.pool();
  const store = await PostgresContextStore.create({ pool });

  await postgresTransaction(pool, async (tx) => {
    await store.bind(tx).createChat({ id: 'kept', userId: 'user-1' });
    await assert.rejects(
      postgresTransaction(tx, async (inner) => {
        await store.bind(inner).createChat({ id: 'discarded', userId: 'u' });
        throw new Error('inner refused');
      }),
      /inner refused/,
    );
  });

  assert.deepStrictEqual(
    {
      kept: (await store.getChat('kept'))?.id,
      discarded: await store.getChat('discarded'),
    },
    { kept: 'kept', discarded: undefined },
  );
});

test(
  'bound stores run on the transaction client alone, so a one-client pool completes',
  { timeout: 30_000 },
  async () => {
    await using database = await testPostgres.database();
    const pool = database.pool({ max: 1 });
    const store = await PostgresContextStore.create({ pool });
    const streams = await PostgresStreamStore.create({ pool });

    await postgresTransaction(pool, async (tx) => {
      const boundStore = store.bind(tx);
      const boundStreams = streams.bind(tx);
      await boundStore.createChat({ id: 'chat-1', userId: 'user-1' });
      await boundStore.updateChat('chat-1', () => ({ title: 'Admitted' }));
      await boundStreams.createStream(stream('stream-1'));
      await boundStreams.updateStream('stream-1', () => ({
        status: 'running',
      }));
      assert.equal((await boundStore.getChat('chat-1'))?.title, 'Admitted');
    });

    assert.deepStrictEqual(
      {
        title: (await store.getChat('chat-1'))?.title,
        status: await streams.getStreamStatus('stream-1'),
      },
      { title: 'Admitted', status: 'running' },
    );
  },
);

test('a store bound to a finished transaction refuses to query instead of using a released client', async () => {
  await using database = await testPostgres.database();
  const pool = database.pool();
  const store = await PostgresContextStore.create({ pool });
  const streams = await PostgresStreamStore.create({ pool });
  const committed = await postgresTransaction(pool, async (tx) => ({
    store: store.bind(tx),
    streams: streams.bind(tx),
  }));
  const rolledBack = await postgresTransaction(pool, async (tx) => {
    throw Object.assign(new Error('refused'), {
      bound: { store: store.bind(tx), streams: streams.bind(tx) },
    });
  }).catch((error: { bound: typeof committed }) => error.bound);

  const finished = /transaction is already finished/;
  await assert.rejects(committed.store.getChat('chat-1'), finished);
  await assert.rejects(committed.streams.getStream('stream-1'), finished);
  await assert.rejects(rolledBack.store.getChat('chat-1'), finished);
  await assert.rejects(rolledBack.streams.getStream('stream-1'), finished);
});

test('parallel bound calls on one transaction are refused instead of interleaving their savepoints', async () => {
  await using database = await testPostgres.database();
  const pool = database.pool();
  const store = await PostgresContextStore.create({ pool });
  const streams = await PostgresStreamStore.create({ pool });

  await assert.rejects(
    postgresTransaction(pool, (tx) =>
      Promise.all([
        store.bind(tx).createChat({ id: 'chat-1', userId: 'user-1' }),
        streams.bind(tx).createStream(stream('stream-1')),
      ]),
    ),
    /savepoint .* is still running/,
  );

  assert.deepStrictEqual(
    {
      chat: await store.getChat('chat-1'),
      stream: await streams.getStream('stream-1'),
    },
    { chat: undefined, stream: undefined },
  );
});

test('a query left running after the transaction body returns is refused and never committed', async () => {
  await using database = await testPostgres.database();
  const pool = database.pool();
  const store = await PostgresContextStore.create({ pool });
  const leaked = Promise.withResolvers<unknown>();

  await postgresTransaction(pool, async (tx) => {
    queueMicrotask(() => {
      store
        .bind(tx)
        .createChat({ id: 'leaked-chat', userId: 'user-1' })
        .then(leaked.resolve, leaked.resolve);
    });
  });

  assert.match(String(await leaked.promise), /transaction is already finished/);
  assert.equal(await store.getChat('leaked-chat'), undefined);
});
