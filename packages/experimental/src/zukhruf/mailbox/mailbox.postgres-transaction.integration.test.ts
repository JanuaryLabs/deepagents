import { waitFor } from '@zukhruf/testing/async';
import { Postgres } from '@zukhruf/testing/postgres';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { postgresTransaction } from '@deepagents/context';
import {
  PostgresMailboxStore,
  createInterAgentCommunication,
} from '@deepagents/experimental/zukhruf';

const testPostgres = new Postgres({ environment: process.env });

const root = { chatId: 'root', userId: 'user-1' };
const researcher = { chatId: 'researcher', userId: 'user-1' };

function mail(content: string) {
  return createInterAgentCommunication({
    author: root,
    recipient: researcher,
    content,
  });
}

test('mail written through a store bound to a transaction is gone when the transaction throws and kept when it commits', async () => {
  await using database = await testPostgres.database();
  const pool = database.pool();
  const mailbox = await PostgresMailboxStore.create({ pool });

  await assert.rejects(
    postgresTransaction(pool, async (tx) => {
      const bound = mailbox.bind(tx);
      await bound.beginTurn(researcher, 'refused-turn');
      await bound.enqueue(mail('refused'));
      throw new Error('admission refused');
    }),
    /admission refused/,
  );
  const afterRollback = {
    pending: await mailbox.hasPending(researcher),
    recipientActive: (await mailbox.enqueue(mail('probe'))).recipientActive,
  };
  await mailbox.drain(researcher);

  await postgresTransaction(pool, async (tx) => {
    await mailbox.bind(tx).enqueue(mail('admitted'));
  });

  assert.deepStrictEqual(
    {
      afterRollback,
      afterCommit: (await mailbox.drain(researcher)).map(
        ({ content }) => content,
      ),
    },
    {
      afterRollback: { pending: false, recipientActive: false },
      afterCommit: ['admitted'],
    },
  );
});

test('a nested transaction on a bound mailbox discards only its own mail', async () => {
  await using database = await testPostgres.database();
  const pool = database.pool();
  const mailbox = await PostgresMailboxStore.create({ pool });

  await postgresTransaction(pool, async (tx) => {
    await mailbox.bind(tx).enqueue(mail('kept'));
    await assert.rejects(
      postgresTransaction(tx, async (inner) => {
        await mailbox.bind(inner).enqueue(mail('discarded'));
        throw new Error('inner refused');
      }),
      /inner refused/,
    );
    await mailbox.bind(tx).enqueue(mail('after the savepoint'));
  });

  assert.deepStrictEqual(
    (await mailbox.drain(researcher)).map(({ content }) => content),
    ['kept', 'after the savepoint'],
  );
});

test("a bound store holds the recipient's lock until its transaction ends, so another worker's drain waits and then sees the mail", async (t) => {
  await using database = await testPostgres.database();
  const pool = database.pool();
  const mailbox = await PostgresMailboxStore.create({ pool });
  const otherWorker = await PostgresMailboxStore.create({
    pool: database.pool(),
  });
  let drained: Promise<string[]> | undefined;

  await postgresTransaction(pool, async (tx) => {
    await mailbox.bind(tx).enqueue(mail('admitted'));
    drained = otherWorker
      .drain(researcher)
      .then((items) => items.map(({ content }) => content));
    await waitFor(
      async () => {
        const { rows } = await pool.query<{ waiting: number }>(
          `SELECT count(*)::int AS waiting FROM pg_locks
            WHERE locktype = 'advisory' AND NOT granted
              AND database = (SELECT oid FROM pg_database
                               WHERE datname = current_database())`,
        );
        assert.equal(rows[0]?.waiting, 1);
      },
      {
        signal: AbortSignal.any([t.signal, AbortSignal.timeout(10_000)]),
        interval: 25,
      },
    );
  });

  assert.deepStrictEqual(await drained, ['admitted']);
});
