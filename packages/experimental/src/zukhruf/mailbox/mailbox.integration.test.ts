import { TemporaryFiles } from '@zukhruf/fs';
import { Postgres } from '@zukhruf/testing/postgres';
import { Sqlite } from '@zukhruf/testing/sqlite';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import pg from 'pg';

import {
  type InterAgentCommunication,
  InterAgentCommunicationTypes,
  type MailboxStore,
  PostgresMailboxStore,
  SqliteMailboxStore,
  createInterAgentCommunication,
} from '@deepagents/experimental/zukhruf';

const testPostgres = new Postgres({ environment: process.env });

const root = { chatId: 'root', userId: 'user-1' };
const researcher = { chatId: 'researcher', userId: 'user-1' };
const reviewer = { chatId: 'reviewer', userId: 'user-1' };

function mail(content: string) {
  return createInterAgentCommunication({
    author: root,
    recipient: researcher,
    content,
  });
}

/** One durable mailbox; each `open()` is another store on it, the way a second worker sees the same mail. */
interface MailboxBacking extends AsyncDisposable {
  open(): Promise<MailboxStore>;
  /** Closes every open store's connection, the way a worker process exits. */
  restart(): Promise<void>;
}

function backing(
  durable: AsyncDisposableStack,
  open: (connections: AsyncDisposableStack) => Promise<MailboxStore>,
): MailboxBacking {
  let connections = new AsyncDisposableStack();
  return {
    open: () => open(connections),
    restart: async () => {
      await connections.disposeAsync();
      connections = new AsyncDisposableStack();
    },
    [Symbol.asyncDispose]: async () => {
      try {
        await connections.disposeAsync();
      } finally {
        await durable.disposeAsync();
      }
    },
  };
}

async function sqliteBacking(): Promise<MailboxBacking> {
  await using resources = new AsyncDisposableStack();
  const directory = resources.use(
    await new TemporaryFiles().directory('zukhruf-mailbox-'),
  );
  const path = join(directory.path, 'mailbox.sqlite');
  return backing(resources.move(), async (connections) =>
    connections.use(new SqliteMailboxStore(path)),
  );
}

async function postgresBacking(): Promise<MailboxBacking> {
  await using resources = new AsyncDisposableStack();
  const database = resources.use(await testPostgres.database());
  return backing(resources.move(), (connections) =>
    PostgresMailboxStore.create({
      pool: connections.adopt(
        new pg.Pool({ connectionString: database.connectionString }),
        (pool) => pool.end(),
      ),
    }),
  );
}

const backings = [
  { name: 'SQLite', create: sqliteBacking },
  { name: 'PostgreSQL', create: postgresBacking },
];

for (const backing of backings) {
  describe(`zukhruf mailbox on ${backing.name}`, () => {
    it('drains only the leading queue-only prefix before a trigger', async () => {
      await using mailbox = await backing.create();
      const store = await mailbox.open();

      await store.enqueue(mail('queued before one'));
      await store.enqueue(mail('queued before two'));
      await store.enqueue({
        ...mail('trigger'),
        type: InterAgentCommunicationTypes.NewTask,
        triggerTurn: true,
      });
      await store.enqueue(mail('queued after trigger'));

      assert.deepStrictEqual(
        (await store.drainLeadingQueueOnly(researcher)).map(
          ({ content }) => content,
        ),
        ['queued before one', 'queued before two'],
      );
      assert.deepStrictEqual(
        (await store.drain(researcher)).map(({ content, triggerTurn }) => ({
          content,
          triggerTurn,
        })),
        [
          { content: 'trigger', triggerTurn: true },
          { content: 'queued after trigger', triggerTurn: false },
        ],
      );
    });

    it('drains one writer’s mail in the order it was enqueued', async () => {
      await using mailbox = await backing.create();
      const store = await mailbox.open();

      await store.enqueue(mail('one'));
      await store.enqueue(mail('two'));
      await store.enqueue(mail('three'));

      assert.deepStrictEqual(
        (await store.drain(researcher)).map(({ content }) => content),
        ['one', 'two', 'three'],
      );
    });

    it('isolates recipients when one mailbox drains', async () => {
      await using mailbox = await backing.create();
      const store = await mailbox.open();

      await store.enqueue(
        createInterAgentCommunication({
          author: root,
          recipient: researcher,
          content: 'for researcher',
        }),
      );
      await store.enqueue(
        createInterAgentCommunication({
          author: root,
          recipient: reviewer,
          content: 'for reviewer',
        }),
      );

      assert.deepStrictEqual(
        (await store.drain(researcher)).map(({ content }) => content),
        ['for researcher'],
      );
      assert.equal(await store.hasPending(reviewer), true);
      assert.deepStrictEqual(
        (await store.drain(reviewer)).map(({ content }) => content),
        ['for reviewer'],
      );
    });

    it('stores a retried communication id only once', async () => {
      await using mailbox = await backing.create();
      const store = await mailbox.open();
      const completion = createInterAgentCommunication({
        id: 'child-completion:stream-1',
        author: researcher,
        recipient: root,
        content: 'finished',
      });

      await store.enqueue(completion);
      await store.enqueue(completion);

      assert.deepStrictEqual(
        (await store.drain(root)).map(({ id, content }) => ({ id, content })),
        [
          {
            id: 'child-completion:stream-1',
            content: 'finished',
          },
        ],
      );
    });

    it('does not redeliver a consumed terminal id after store restart', async () => {
      await using mailbox = await backing.create();
      const completion = createInterAgentCommunication({
        id: 'child-completion:stream-consumed',
        type: InterAgentCommunicationTypes.FinalAnswer,
        author: researcher,
        recipient: root,
        content: 'finished once',
      });
      const firstStore = await mailbox.open();
      await firstStore.enqueue(completion);
      assert.deepStrictEqual(
        (await firstStore.drainLeadingQueueOnly(root)).map(
          ({ content }) => content,
        ),
        ['finished once'],
      );

      await mailbox.restart();
      const restartedStore = await mailbox.open();
      await restartedStore.enqueue(completion);
      assert.deepStrictEqual(await restartedStore.drain(root), []);
    });

    it('keeps pending mail across store re-instantiation', async () => {
      await using mailbox = await backing.create();
      const firstStore = await mailbox.open();
      await firstStore.enqueue(mail('survives restart'));

      await mailbox.restart();
      const secondStore = await mailbox.open();
      assert.deepStrictEqual(
        (await secondStore.drain(researcher)).map(
          (communication) => communication.content,
        ),
        ['survives restart'],
      );
    });

    it('atomically hands active-turn mail off across store instances', async () => {
      await using mailbox = await backing.create();
      const turnStore = await mailbox.open();
      const senderStore = await mailbox.open();

      await turnStore.beginTurn(researcher, 'turn-1');
      assert.deepStrictEqual(await senderStore.enqueue(mail('before end')), {
        recipientActive: true,
      });
      assert.deepStrictEqual(await turnStore.endTurn(researcher, 'turn-1'), {
        hasPending: true,
        turnEnded: true,
      });

      assert.deepStrictEqual(await senderStore.enqueue(mail('after end')), {
        recipientActive: false,
      });
      assert.deepStrictEqual(await turnStore.endTurn(researcher, 'turn-1'), {
        hasPending: true,
        turnEnded: false,
      });
      assert.deepStrictEqual(
        (await turnStore.drain(researcher)).map(({ content }) => content),
        ['before end', 'after end'],
      );
      assert.deepStrictEqual(await turnStore.endTurn(researcher, 'turn-1'), {
        hasPending: false,
        turnEnded: false,
      });
    });
  });
}

describe('SqliteMailboxStore', () => {
  it('waits for cross-process writers while enqueueing and draining in FIFO order', async () => {
    const sqlite = new Sqlite();
    await using directory = await new TemporaryFiles().directory(
      'zukhruf-mailbox-lock-',
    );
    const path = join(directory.path, 'mailbox.sqlite');
    using store = new SqliteMailboxStore(path);
    await store.enqueue(mail('one'));
    await store.enqueue(mail('two'));

    {
      await using lock = await sqlite.writeLock(path, 200);
      await store.enqueue(mail('three'));
    }
    {
      await using lock = await sqlite.writeLock(path, 200);
      const messages = await store.drain(researcher);

      assert.deepStrictEqual(
        messages.map(({ content }) => content),
        ['one', 'two', 'three'],
      );
    }
  });
});

describe('PostgresMailboxStore', () => {
  it('loses, duplicates and reorders no mail while two workers enqueue during drains from a third', async () => {
    await using mailbox = await postgresBacking();
    const [first, second, reader] = await Promise.all([
      mailbox.open(),
      mailbox.open(),
      mailbox.open(),
    ]);
    const firstSeries = Array.from({ length: 12 }, (_, i) => `first-${i}`);
    const secondSeries = Array.from({ length: 12 }, (_, i) => `second-${i}`);
    const enqueueAll = async (store: MailboxStore, series: string[]) => {
      for (const content of series) await store.enqueue(mail(content));
    };
    const drained: InterAgentCommunication[] = [];
    let writing = true;
    const writers = Promise.all([
      enqueueAll(first, firstSeries),
      enqueueAll(second, secondSeries),
    ]).finally(() => {
      writing = false;
    });

    while (writing) drained.push(...(await reader.drain(researcher)));
    await writers;
    drained.push(...(await reader.drain(researcher)));

    const contents = drained.map(({ content }) => content);
    assert.deepStrictEqual(
      {
        first: contents.filter((content) => content.startsWith('first-')),
        second: contents.filter((content) => content.startsWith('second-')),
        total: contents.length,
      },
      { first: firstSeries, second: secondSeries, total: 24 },
    );
  });

  it('delivers each message once while two workers drain the same mailbox at the same time', async () => {
    await using mailbox = await postgresBacking();
    const [writer, firstReader, secondReader] = await Promise.all([
      mailbox.open(),
      mailbox.open(),
      mailbox.open(),
    ]);
    const sent: string[] = [];
    const delivered: string[] = [];

    for (let round = 0; round < 10; round++) {
      for (const content of [`round-${round}-a`, `round-${round}-b`]) {
        await writer.enqueue(mail(content));
        sent.push(content);
      }
      const drains = await Promise.all([
        firstReader.drain(researcher),
        secondReader.drain(researcher),
      ]);
      delivered.push(...drains.flat().map(({ content }) => content));
    }

    assert.deepStrictEqual(delivered.toSorted(), sent.toSorted());
  });

  it('never strands mail when an enqueue races the end of the recipient turn on another worker', async () => {
    await using mailbox = await postgresBacking();
    const [turnStore, senderStore] = await Promise.all([
      mailbox.open(),
      mailbox.open(),
    ]);
    const stranded: number[] = [];

    for (let round = 0; round < 20; round++) {
      const recipient = { chatId: `racing-${round}`, userId: 'user-1' };
      await turnStore.beginTurn(recipient, 'turn');
      const [enqueued, ended] = await Promise.all([
        senderStore.enqueue(
          createInterAgentCommunication({
            author: root,
            recipient,
            content: `round ${round}`,
          }),
        ),
        turnStore.endTurn(recipient, 'turn'),
      ]);
      // The sender skips the wake when the recipient is active, so the end of
      // that turn must see the mail, or nothing ever delivers it.
      if (enqueued.recipientActive && !ended.hasPending) stranded.push(round);
    }

    assert.deepStrictEqual(stranded, []);
  });

  it('keeps the mail of stores on different schemas apart in one database', async () => {
    await using resources = new AsyncDisposableStack();
    const database = resources.use(await testPostgres.database());
    const pool = resources.adopt(
      new pg.Pool({ connectionString: database.connectionString }),
      (value) => value.end(),
    );
    const tenantA = await PostgresMailboxStore.create({
      pool,
      schema: 'tenant_a',
    });
    const tenantB = await PostgresMailboxStore.create({
      pool,
      schema: 'tenant_b',
    });

    await tenantA.enqueue(mail('for tenant a'));

    assert.deepStrictEqual(
      {
        tenantB: await tenantB.drain(researcher),
        tenantA: (await tenantA.drain(researcher)).map(
          ({ content }) => content,
        ),
      },
      { tenantB: [], tenantA: ['for tenant a'] },
    );
  });
});

describe('createInterAgentCommunication', () => {
  it('rejects empty communication addressing and content', () => {
    assert.throws(
      () =>
        createInterAgentCommunication({
          author: { chatId: '', userId: 'user-1' },
          recipient: researcher,
          content: 'hello',
        }),
      /author requires chatId and userId/,
    );
    assert.throws(
      () =>
        createInterAgentCommunication({
          author: root,
          recipient: researcher,
          content: '   ',
        }),
      /content cannot be empty/,
    );
  });
});
