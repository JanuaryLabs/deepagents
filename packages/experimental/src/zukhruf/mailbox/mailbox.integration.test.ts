import assert from 'node:assert/strict';
import { mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  InterAgentCommunicationType,
  SqliteMailboxStore,
  createInterAgentCommunication,
} from '@deepagents/experimental/zukhruf';
import { Sqlite } from '@deepagents/test';

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
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'zukhruf-mailbox-dedup-'),
    );
    const path = join(directory.path, 'mailbox.sqlite');
    const completion = createInterAgentCommunication({
      id: 'child-completion:stream-consumed',
      type: InterAgentCommunicationType.FinalAnswer,
      author: researcher,
      recipient: root,
      content: 'finished once',
    });
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
  });

  it('keeps pending mail across store re-instantiation', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'zukhruf-mailbox-'),
    );
    const path = join(directory.path, 'mailbox.sqlite');
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
  });

  it('atomically hands active-turn mail off across store instances', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'zukhruf-mailbox-active-'),
    );
    const path = join(directory.path, 'mailbox.sqlite');
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
  });

  it('waits for cross-process writers while enqueueing and draining in FIFO order', async () => {
    const sqlite = new Sqlite();
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'zukhruf-mailbox-lock-'),
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
