import { waitFor } from '@zukhruf/testing/async';
import { Postgres, type PostgresDatabase } from '@zukhruf/testing/postgres';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Pool } from 'pg';
import { PgBoss } from 'pg-boss';

import {
  type AdmissionScope,
  AgentStorageDatabaseMismatchError,
  InterAgentCommunicationTypes,
  PostgresAgentStorage,
  type SandboxIdleWake,
  type Wake,
  createInterAgentCommunication,
} from '@deepagents/experimental/zukhruf';

const testPostgres = new Postgres({ environment: process.env });

async function startedBoss(
  resources: AsyncDisposableStack,
  database: PostgresDatabase,
): Promise<PgBoss> {
  const boss = new PgBoss({ connectionString: database.connectionString });
  boss.on('error', () => {});
  await boss.start();
  resources.defer(() => boss.stop({ graceful: false }));
  return boss;
}

/** Writes a child chat, its stream, a trigger-turn mail and its turn through every bound part. */
async function admitChild(scope: AdmissionScope, chatId: string) {
  await scope.store.createChat({ id: chatId, userId: 'user-1' });
  await scope.mailboxStore.enqueue({
    ...createInterAgentCommunication({
      author: { chatId: 'root', userId: 'user-1' },
      recipient: { chatId, userId: 'user-1' },
      content: 'new task',
      type: InterAgentCommunicationTypes.NewTask,
    }),
    triggerTurn: true,
  });
  await scope.queue.push({
    kind: 'mailbox',
    streamId: `turn/${chatId}#1`,
    chatId,
    userId: 'user-1',
  });
  await scope.streams.createStream({
    id: `turn/${chatId}#1`,
    status: 'queued',
    createdAt: Date.now(),
    startedAt: null,
    finishedAt: null,
    cancelRequestedAt: null,
    error: null,
  });
}

/** What another connection sees of `admitChild`'s four writes. */
async function admitted(storage: PostgresAgentStorage, chatId: string) {
  const conversation = { chatId, userId: 'user-1' };
  return {
    chat: (await storage.store.getChat(chatId))?.userId,
    stream: await storage.streams.store.getStreamStatus(`turn/${chatId}#1`),
    mail: await storage.mailboxStore.hasPendingTriggerTurn(conversation),
    turn: await storage.queue.getTurnActivity(conversation),
  };
}

const NOTHING = {
  chat: undefined,
  stream: undefined,
  mail: false,
  turn: 'idle',
};
const EVERYTHING = {
  chat: 'user-1',
  stream: 'queued',
  mail: true,
  turn: 'queued',
};

function idleWake(chatId: string): Wake<SandboxIdleWake> {
  const runAt = new Date();
  return {
    id: crypto.randomUUID(),
    runAt,
    data: {
      conversation: { chatId, userId: 'user-1' },
      turnId: `turn/${chatId}#1`,
      scheduledFor: runAt.getTime(),
    },
  };
}

/** Backends of `pool`'s database, PgBoss's own aside, that wait for an advisory lock. */
async function advisoryWaiters(pool: Pool): Promise<number> {
  const { rows } = await pool.query<{ waiting: number }>(
    `SELECT count(*)::int AS waiting
     FROM pg_locks JOIN pg_stat_activity USING (pid)
     WHERE pg_locks.locktype = 'advisory' AND NOT pg_locks.granted
       AND pg_stat_activity.datname = current_database()
       AND pg_stat_activity.application_name <> 'pgboss'`,
  );
  return rows[0]?.waiting ?? 0;
}

test('create refuses a PgBoss on another database than the pool, naming both databases', async () => {
  await using resources = new AsyncDisposableStack();
  const storesDatabase = resources.use(await testPostgres.database());
  const bossDatabase = resources.use(await testPostgres.database());
  const pool = storesDatabase.pool();
  const boss = await startedBoss(resources, bossDatabase);
  const nameOf = async (db: Pool) =>
    (await db.query<{ name: string }>('SELECT current_database() AS name'))
      .rows[0]?.name;

  const failure = await PostgresAgentStorage.create({ pool, boss }).catch(
    (error: unknown) => error,
  );

  assert.ok(failure instanceof AgentStorageDatabaseMismatchError, `${failure}`);
  assert.deepStrictEqual(
    { pool: failure.pool.database, boss: failure.boss.database },
    {
      pool: await nameOf(pool),
      boss: await nameOf(bossDatabase.pool()),
    },
  );
});

test('an admission whose work throws leaves none of its chat, stream, mail and turn; one that resolves commits all four', async () => {
  await using resources = new AsyncDisposableStack();
  const database = resources.use(await testPostgres.database());
  const boss = await startedBoss(resources, database);
  await using storage = await PostgresAgentStorage.create({
    pool: database.pool(),
    boss,
  });
  const tree = { userId: 'user-1', treeId: 'root' };

  const refusal = storage.admit(tree, async (scope) => {
    await admitChild(scope, 'refused');
    throw new Error('admission refused');
  });
  await assert.rejects(refusal, /admission refused/);
  const accepted = await storage.admit(tree, async (scope) => {
    await admitChild(scope, 'accepted');
    return 'accepted';
  });

  assert.deepStrictEqual(
    {
      accepted,
      refused: await admitted(storage, 'refused'),
      admitted: await admitted(storage, 'accepted'),
    },
    { accepted: 'accepted', refused: NOTHING, admitted: EVERYTHING },
  );
});

test('a session terminated in the middle of an admission leaves none of its writes', async (t) => {
  await using resources = new AsyncDisposableStack();
  const database = resources.use(await testPostgres.database());
  const boss = await startedBoss(resources, database);
  await using storage = await PostgresAgentStorage.create({
    pool: database.pool(),
    boss,
  });
  const observer = database.pool();
  // Platform setup no storage operation exposes: hold the message search
  // table, which only addMessage writes, so the admission stops after all
  // four parts have written.
  const holder = await observer.connect();
  resources.defer(() => holder.release());
  await holder.query('BEGIN');
  await holder.query(
    'LOCK TABLE "public"."messages_fts" IN ACCESS EXCLUSIVE MODE',
  );

  const admission = storage.admit(
    { userId: 'user-1', treeId: 'root' },
    async (scope) => {
      await admitChild(scope, 'child');
      await scope.store.addMessage({
        id: 'child-task',
        chatId: 'child',
        parentId: null,
        name: 'user',
        data: { role: 'user', parts: [{ type: 'text', text: 'new task' }] },
        createdAt: Date.now(),
      });
    },
  );
  const outcome = admission.then(
    () => 'committed',
    () => 'failed',
  );
  const pid = await waitFor(
    async () => {
      const { rows } = await observer.query<{ pid: number }>(
        `SELECT pid FROM pg_locks
         WHERE relation = '"public"."messages_fts"'::regclass AND NOT granted`,
      );
      assert.equal(rows.length, 1);
      return rows[0]?.pid;
    },
    { signal: t.signal, interval: 25 },
  );
  await observer.query('SELECT pg_terminate_backend($1)', [pid]);
  const settled = await outcome;
  await holder.query('ROLLBACK');

  assert.deepStrictEqual(
    { settled, left: await admitted(storage, 'child') },
    { settled: 'failed', left: NOTHING },
  );
});

test('two storages on separate pools admit one tree in turn: the second starts after the first commits and sees its writes', async (t) => {
  await using resources = new AsyncDisposableStack();
  const database = resources.use(await testPostgres.database());
  const boss = await startedBoss(resources, database);
  await using first = await PostgresAgentStorage.create({
    pool: database.pool(),
    boss,
  });
  await using second = await PostgresAgentStorage.create({
    pool: database.pool(),
    boss,
  });
  const tree = { userId: 'user-1', treeId: 'root' };
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const events: string[] = [];

  const holding = first.admit(tree, async (scope) => {
    await admitChild(scope, 'first-child');
    events.push('first entered');
    entered.resolve();
    await release.promise;
    events.push('first done');
  });
  await entered.promise;
  const waiting = second.admit(tree, async (scope) => {
    events.push('second entered');
    return (await scope.store.getChat('first-child'))?.userId;
  });
  const observer = database.pool();
  await waitFor(
    async () => {
      assert.ok(
        events.includes('second entered') ||
          (await advisoryWaiters(observer)) === 1,
      );
    },
    { signal: t.signal, interval: 25 },
  );
  const whileHeld = [...events];
  release.resolve();
  await holding;
  const seenBySecond = await waiting;

  assert.deepStrictEqual(
    { whileHeld, events, seenBySecond },
    {
      whileHeld: ['first entered'],
      events: ['first entered', 'first done', 'second entered'],
      seenBySecond: 'user-1',
    },
  );
});

test('an admission to another tree runs while one tree is held', async (t) => {
  await using resources = new AsyncDisposableStack();
  const database = resources.use(await testPostgres.database());
  const boss = await startedBoss(resources, database);
  await using first = await PostgresAgentStorage.create({
    pool: database.pool(),
    boss,
  });
  await using second = await PostgresAgentStorage.create({
    pool: database.pool(),
    boss,
  });
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const observer = database.pool();

  const holding = first.admit(
    { userId: 'user-1', treeId: 'held' },
    async () => {
      entered.resolve();
      await release.promise;
    },
  );
  await entered.promise;
  const other = second.admit(
    { userId: 'user-1', treeId: 'other' },
    async (scope) => {
      await admitChild(scope, 'other-child');
      return 'admitted';
    },
  );
  const watching = new AbortController();
  const waited = waitFor(
    async () => assert.equal(await advisoryWaiters(observer), 1),
    { signal: AbortSignal.any([t.signal, watching.signal]), interval: 25 },
  ).then(
    () => 'waited for the held tree',
    () => 'stopped watching',
  );
  const outcome = await Promise.race([other, waited]);
  watching.abort();
  await waited;
  release.resolve();
  await holding;
  await other;

  assert.deepStrictEqual(
    { outcome, committed: await admitted(second, 'other-child') },
    { outcome: 'admitted', committed: EVERYTHING },
  );
});

test('two storages on one database whose turn queues differ each keep their sandbox idle wakes on a queue named after their turn queue and deliver only their own', async (t) => {
  await using resources = new AsyncDisposableStack();
  const database = resources.use(await testPostgres.database());
  const boss = await startedBoss(resources, database);
  await using first = await PostgresAgentStorage.create({
    pool: database.pool(),
    boss,
    queue: { queue: 'tree-a' },
  });
  await using second = await PostgresAgentStorage.create({
    pool: database.pool(),
    boss,
    queue: { queue: 'tree-b' },
  });
  const firstWake = idleWake('chat-a');
  const secondWake = idleWake('chat-b');

  await first.sandboxIdleWakes.schedule(firstWake);
  await second.sandboxIdleWakes.schedule(secondWake);
  const waiting = {
    first: (await boss.findJobs('tree-a-sandbox-idle')).map((job) => job.id),
    second: (await boss.findJobs('tree-b-sandbox-idle')).map((job) => job.id),
  };
  const delivered: Record<'first' | 'second', Wake<SandboxIdleWake>[]> = {
    first: [],
    second: [],
  };
  await using _first = await first.sandboxIdleWakes.consume(async (wake) => {
    delivered.first.push(wake);
  });
  await using _second = await second.sandboxIdleWakes.consume(async (wake) => {
    delivered.second.push(wake);
  });
  await waitFor(
    () => assert.equal(delivered.first.length + delivered.second.length, 2),
    { signal: t.signal, interval: 25 },
  );

  assert.deepStrictEqual(
    { waiting, delivered },
    {
      waiting: { first: [firstWake.id], second: [secondWake.id] },
      delivered: { first: [firstWake], second: [secondWake] },
    },
  );
});
