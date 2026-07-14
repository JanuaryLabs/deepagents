import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  InterAgentCommunicationType,
  SqliteMailboxStore,
  createInterAgentCommunication,
} from '@deepagents/experimental/zukhruf';

const root = { chatId: 'root', userId: 'user-1' };
const researcher = { chatId: 'researcher', userId: 'user-1' };
const reviewer = { chatId: 'reviewer', userId: 'user-1' };

const holdWriteLock = `
  import { DatabaseSync } from 'node:sqlite';

  const database = new DatabaseSync(process.argv[1]);
  database.exec('BEGIN IMMEDIATE');
  process.stdout.write('locked\\n');
  setTimeout(() => {
    database.exec('COMMIT');
    database.close();
  }, 200);
`;

function mail(content: string) {
  return createInterAgentCommunication({
    author: root,
    recipient: researcher,
    content,
  });
}

async function runWhileWriteLocked<T>(
  path: string,
  operation: () => Promise<T>,
): Promise<T> {
  const holder = spawn(
    process.execPath,
    ['--input-type=module', '-e', holdWriteLock, path],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stderr = '';
  holder.stderr.setEncoding('utf8');
  holder.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  const exited = once(holder, 'exit');
  const [signal] = await once(holder.stdout, 'data');
  assert.equal(signal.toString(), 'locked\n', stderr);

  try {
    return await operation();
  } finally {
    const [exitCode] = await exited;
    assert.equal(exitCode, 0, stderr);
  }
}

describe('zukhruf mailbox', () => {
  it('drains only the leading queue-only prefix before a trigger', async () => {
    using store = new SqliteMailboxStore(':memory:');

    await store.enqueue(mail('queued before one'));
    await store.enqueue(mail('queued before two'));
    await store.enqueue({
      ...mail('trigger'),
      type: InterAgentCommunicationType.NewTask,
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

  it('isolates recipients when one mailbox drains', async () => {
    using store = new SqliteMailboxStore(':memory:');

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
    using store = new SqliteMailboxStore(':memory:');
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
    const directory = await mkdtemp(join(tmpdir(), 'zukhruf-mailbox-dedup-'));
    const path = join(directory, 'mailbox.sqlite');
    const completion = createInterAgentCommunication({
      id: 'child-completion:stream-consumed',
      type: InterAgentCommunicationType.FinalAnswer,
      author: researcher,
      recipient: root,
      content: 'finished once',
    });
    try {
      {
        using firstStore = new SqliteMailboxStore(path);
        await firstStore.enqueue(completion);
        assert.deepStrictEqual(
          (await firstStore.drainLeadingQueueOnly(root)).map(
            ({ content }) => content,
          ),
          ['finished once'],
        );
      }

      using restartedStore = new SqliteMailboxStore(path);
      await restartedStore.enqueue(completion);
      assert.deepStrictEqual(await restartedStore.drain(root), []);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('keeps pending mail across store re-instantiation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'zukhruf-mailbox-'));
    const path = join(directory, 'mailbox.sqlite');
    try {
      {
        using firstStore = new SqliteMailboxStore(path);
        await firstStore.enqueue(mail('survives restart'));
      }

      using secondStore = new SqliteMailboxStore(path);
      assert.deepStrictEqual(
        (await secondStore.drain(researcher)).map(
          (communication) => communication.content,
        ),
        ['survives restart'],
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('atomically hands active-turn mail off across store instances', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'zukhruf-mailbox-active-'));
    const path = join(directory, 'mailbox.sqlite');
    try {
      using turnStore = new SqliteMailboxStore(path);
      using senderStore = new SqliteMailboxStore(path);

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
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('waits for cross-process writers while enqueueing and draining in FIFO order', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'zukhruf-mailbox-lock-'));
    const path = join(directory, 'mailbox.sqlite');
    try {
      using store = new SqliteMailboxStore(path);
      await store.enqueue(mail('one'));
      await store.enqueue(mail('two'));

      await runWhileWriteLocked(path, () => store.enqueue(mail('three')));
      const messages = await runWhileWriteLocked(path, () =>
        store.drain(researcher),
      );

      assert.deepStrictEqual(
        messages.map(({ content }) => content),
        ['one', 'two', 'three'],
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

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
