import { PGlite } from '@electric-sql/pglite';
import assert from 'node:assert/strict';
import { suite, test } from 'node:test';
import { PgBoss, fromPglite } from 'pg-boss';

import {
  type ConversationId,
  type ConversationStatusChangeHint,
  type ConversationStatusChangeSource,
  PgBossConversationStatusChangeSource,
} from '@deepagents/experimental/zukhruf';
import { settleWithin, withPostgresContainer } from '@deepagents/test';

interface ChangeSourceHarness extends AsyncDisposable {
  /** Two pg-boss instances over one database: the subscriber and the notifier. */
  subscriber: ConversationStatusChangeSource;
  notifier: ConversationStatusChangeSource;
  /** Raises an arbitrary payload on the source's channel, bypassing `notify`. */
  raw(payload: string): Promise<void>;
}

const CHANNEL = 'zukhruf_status_contract';

async function pgliteHarness(): Promise<ChangeSourceHarness> {
  const pglite = new PGlite();
  const boss = new PgBoss({ db: fromPglite(pglite), backend: 'pglite' });
  boss.on('error', () => {});
  await boss.start();
  const source = new PgBossConversationStatusChangeSource(boss, {
    channel: CHANNEL,
  });
  return {
    subscriber: source,
    notifier: source,
    raw: async (payload) => {
      await pglite.query('SELECT pg_notify($1, $2)', [CHANNEL, payload]);
    },
    async [Symbol.asyncDispose]() {
      await boss.stop({ graceful: false });
      await pglite.close();
    },
  };
}

async function postgresHarness(): Promise<ChangeSourceHarness> {
  const ready = Promise.withResolvers<ChangeSourceHarness>();
  const release = Promise.withResolvers<void>();
  const lifecycle = withPostgresContainer(async (container) => {
    const listening = new PgBoss({
      connectionString: container.connectionString,
    });
    const notifying = new PgBoss({
      connectionString: container.connectionString,
    });
    listening.on('error', () => {});
    notifying.on('error', () => {});
    try {
      await listening.start();
      await notifying.start();
      ready.resolve({
        subscriber: new PgBossConversationStatusChangeSource(listening, {
          channel: CHANNEL,
        }),
        notifier: new PgBossConversationStatusChangeSource(notifying, {
          channel: CHANNEL,
        }),
        raw: async (payload) => {
          await notifying
            .getDb()
            .executeSql('SELECT pg_notify($1, $2)', [CHANNEL, payload]);
        },
        async [Symbol.asyncDispose]() {
          release.resolve();
          await lifecycle;
        },
      });
      await release.promise;
    } catch (error) {
      ready.reject(error);
      throw error;
    } finally {
      await notifying.stop({ graceful: false });
      await listening.stop({ graceful: false });
    }
  });
  void lifecycle.catch((error: unknown) => ready.reject(error));
  return ready.promise;
}

async function collect(
  source: ConversationStatusChangeSource,
  signal: AbortSignal,
): Promise<{ hints: ConversationStatusChangeHint[]; done: Promise<void> }> {
  const events: ConversationStatusChangeHint[] = [];
  const subscription = await source.subscribe(signal);
  const done = (async () => {
    try {
      for await (const event of subscription) {
        events.push(event);
      }
    } catch (error) {
      if (!(error instanceof Error && error.name === 'AbortError')) {
        throw error;
      }
    }
  })();
  return { hints: events, done };
}

async function waitForHints(
  hints: ConversationStatusChangeHint[],
  expected: ConversationId[],
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (hints.length < expected.length) {
    if (Date.now() > deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.deepStrictEqual(
    hints,
    expected.map((conversation) => ({ type: 'change', conversation })),
  );
}

const contracts = [
  { name: 'pglite', makeHarness: pgliteHarness },
  { name: 'postgres', makeHarness: postgresHarness },
];

for (const contract of contracts) {
  suite(`ConversationStatusChangeSource contract — ${contract.name}`, () => {
    test('a hint raised through one pg-boss instance reaches a subscriber on another', async () => {
      await using h = await contract.makeHarness();
      const abort = new AbortController();
      const { hints, done } = await collect(h.subscriber, abort.signal);
      try {
        await h.notifier.notify({ chatId: 'chat-a', userId: 'u1' });
        await h.notifier.notify({ chatId: 'chat-b', userId: 'u2' });
        await waitForHints(hints, [
          { chatId: 'chat-a', userId: 'u1' },
          { chatId: 'chat-b', userId: 'u2' },
        ]);
      } finally {
        abort.abort();
        await settleWithin(done, 'subscription ends on abort');
      }
    });

    test('payloads that are not conversation hints are ignored', async () => {
      await using h = await contract.makeHarness();
      const abort = new AbortController();
      const { hints, done } = await collect(h.subscriber, abort.signal);
      try {
        await h.raw('not json');
        await h.raw(JSON.stringify({ chatId: 'missing-user' }));
        await h.notifier.notify({ chatId: 'chat-c', userId: 'u3' });
        await waitForHints(hints, [{ chatId: 'chat-c', userId: 'u3' }]);
      } finally {
        abort.abort();
        await settleWithin(done, 'subscription ends on abort');
      }
    });

    test('an aborted subscription receives nothing further', async () => {
      await using h = await contract.makeHarness();
      const abort = new AbortController();
      const { hints, done } = await collect(h.subscriber, abort.signal);
      abort.abort();
      await settleWithin(done, 'subscription ends on abort');
      const seen = hints.length;

      await h.notifier.notify({ chatId: 'after-abort', userId: 'u1' });
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal(hints.length, seen);
    });
  });
}

test('a pg-boss database without LISTEN support is rejected at subscribe time', async () => {
  const pglite = new PGlite();
  const boss = new PgBoss({
    db: fromPglite({
      query: (query, params) => pglite.query(query, params),
      exec: (query) => pglite.exec(query),
    }),
    backend: 'pglite',
  });
  boss.on('error', () => {});
  await boss.start();
  try {
    const source = new PgBossConversationStatusChangeSource(boss);
    await assert.rejects(
      source.subscribe(new AbortController().signal),
      /requires a pg-boss database with LISTEN support/,
    );
  } finally {
    await boss.stop({ graceful: false });
    await pglite.close();
  }
});

test('a live listener emits reset on reconnect but not on initial connect', async () => {
  let reconnect = () => {};
  let closes = 0;
  const boss = {
    getDb: () => ({
      listen: async (
        _channel: string,
        _onNotification: (payload: string) => void,
        onReconnect: () => void,
      ) => {
        onReconnect();
        reconnect = onReconnect;
        return {
          close: async () => {
            closes += 1;
          },
        };
      },
    }),
  } as unknown as PgBoss;
  const source = new PgBossConversationStatusChangeSource(boss);
  const events = await source.subscribe(new AbortController().signal);
  const iterator = events[Symbol.asyncIterator]();
  const first = iterator.next();

  assert.equal(
    await Promise.race([
      first.then(() => 'event'),
      new Promise<'pending'>((resolve) => setImmediate(resolve, 'pending')),
    ]),
    'pending',
  );
  reconnect();
  assert.deepEqual(await first, { value: { type: 'reset' }, done: false });

  await iterator.return?.();
  assert.equal(closes, 1);
});
