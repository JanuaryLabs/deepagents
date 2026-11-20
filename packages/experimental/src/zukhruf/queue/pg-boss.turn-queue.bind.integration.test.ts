import { waitFor } from '@zukhruf/testing/async';
import { Postgres } from '@zukhruf/testing/postgres';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PgBoss } from 'pg-boss';

import { postgresTransaction } from '@deepagents/context';
import {
  InterAgentCommunicationTypes,
  PgBossTurnQueue,
  PostgresMailboxStore,
  type TurnRef,
  createInterAgentCommunication,
} from '@deepagents/experimental/zukhruf';

const testPostgres = new Postgres({ environment: process.env });

function mailboxTurn(chatId: string, n: number): TurnRef {
  return {
    kind: 'mailbox',
    streamId: `turn/${chatId}#${n}:${crypto.randomUUID()}`,
    chatId,
    userId: 'user-1',
  };
}

test('a turn pushed through a transaction that throws never reaches a worker, and one pushed through a committed transaction does', async (t) => {
  await using resources = new AsyncDisposableStack();
  const database = resources.use(await testPostgres.database());
  const pool = database.pool();
  const boss = new PgBoss({ connectionString: database.connectionString });
  boss.on('error', () => {});
  await boss.start();
  resources.defer(() => boss.stop({ graceful: false }));
  const queue = await PgBossTurnQueue.create(boss, {
    pollingIntervalSeconds: 0.5,
  });
  const refused = mailboxTurn('child', 1);
  const admitted = mailboxTurn('child', 2);
  const conversation = { chatId: 'child', userId: 'user-1' };

  await assert.rejects(
    postgresTransaction(pool, async (tx) => {
      await queue.bind(tx).push(refused);
      throw new Error('admission refused');
    }),
    /admission refused/,
  );
  const afterRollback = {
    activity: await queue.getTurnActivity(conversation),
    current: await queue.getCurrentTurn(conversation),
  };
  await postgresTransaction(pool, async (tx) => {
    await queue.bind(tx).push(admitted);
  });
  const seen: TurnRef[] = [];
  {
    await using _worker = await queue.consume(
      async (turn) => {
        seen.push(turn);
      },
      { onOrphaned: async () => {} },
    );
    await waitFor(() => assert.equal(seen.length, 1), {
      signal: t.signal,
      interval: 25,
    });
  }

  assert.deepStrictEqual(
    { afterRollback, seen },
    {
      afterRollback: { activity: 'idle', current: undefined },
      seen: [admitted],
    },
  );
});

test('a bound queue counts the turn its transaction pushed while other connections still see none', async () => {
  await using resources = new AsyncDisposableStack();
  const database = resources.use(await testPostgres.database());
  const pool = database.pool();
  const boss = new PgBoss({ connectionString: database.connectionString });
  boss.on('error', () => {});
  await boss.start();
  resources.defer(() => boss.stop({ graceful: false }));
  const queue = await PgBossTurnQueue.create(boss);
  const conversation = { chatId: 'child', userId: 'user-1' };

  const inside = await postgresTransaction(pool, async (tx) => {
    const bound = queue.bind(tx);
    const before = await bound.getTurnActivity(conversation);
    await bound.push(mailboxTurn('child', 1));
    return {
      before,
      after: await bound.getTurnActivity(conversation),
      elsewhere: await queue.getTurnActivity(conversation),
    };
  });

  assert.deepStrictEqual(
    { inside, afterCommit: await queue.getTurnActivity(conversation) },
    {
      inside: { before: 'idle', after: 'queued', elsewhere: 'idle' },
      afterCommit: 'queued',
    },
  );
});

test('mail and a wake turn admitted together run on the transaction client alone, so a one-client pool that PgBoss shares completes', async () => {
  await using resources = new AsyncDisposableStack();
  const database = resources.use(await testPostgres.database());
  // Every caller (the stores, PgBoss and its queue-metadata lookups) shares
  // one connection: any of them reaching for the pool inside the transaction
  // waits for the connection the transaction holds, and times out.
  const pool = database.pool({ max: 1, connectionTimeoutMillis: 5_000 });
  const boss = new PgBoss({
    db: { executeSql: (text, values) => pool.query(text, values) },
  });
  boss.on('error', () => {});
  await boss.start();
  resources.defer(() => boss.stop({ graceful: false }));
  const queue = await PgBossTurnQueue.create(boss, { schema: 'pgboss' });
  const mailbox = await PostgresMailboxStore.create({ pool });
  const child = { chatId: 'child', userId: 'user-1' };

  const inside = await postgresTransaction(pool, async (tx) => {
    const boundMailbox = mailbox.bind(tx);
    const boundQueue = queue.bind(tx);
    await boundMailbox.enqueue({
      ...createInterAgentCommunication({
        author: { chatId: 'root', userId: 'user-1' },
        recipient: child,
        content: 'new task',
        type: InterAgentCommunicationTypes.NewTask,
      }),
      triggerTurn: true,
    });
    await boundQueue.push(mailboxTurn('child', 1));
    return {
      triggerPending: await boundMailbox.hasPendingTriggerTurn(child),
      activity: await boundQueue.getTurnActivity(child),
    };
  });

  assert.deepStrictEqual(
    {
      inside,
      triggerPending: await mailbox.hasPendingTriggerTurn(child),
      activity: await queue.getTurnActivity(child),
    },
    {
      inside: { triggerPending: true, activity: 'queued' },
      triggerPending: true,
      activity: 'queued',
    },
  );
});
