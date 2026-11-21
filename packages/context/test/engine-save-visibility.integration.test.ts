import { Latch } from '@zukhruf/async';
import type { UIMessage } from 'ai';
import assert from 'node:assert';
import { describe, it } from 'node:test';

import {
  ContextEngine,
  type ContextFragment,
  InMemoryContextStore,
  type MessageData,
  user,
} from '@deepagents/context';

function texts(messages: UIMessage[]) {
  return messages.map((m) =>
    m.parts
      .filter((p) => p.type === 'text')
      .map((p) => p.text)
      .join(''),
  );
}

async function storedIds(
  store: InMemoryContextStore,
  headMessageId: string | undefined,
) {
  assert.ok(headMessageId, 'save committed a head');
  const chain = await store.getMessageChain(headMessageId);
  return chain.map((m) => m.id);
}

function ids(...fragments: ContextFragment[]) {
  return fragments.map((f) => f.id);
}

interface Hold {
  readonly entered: Latch;
  readonly release: Latch;
}

function hold(): Hold {
  return { entered: new Latch(), release: new Latch() };
}

/** A slow store: each queued hold makes one message write wait for its release. */
class HeldWriteStore extends InMemoryContextStore {
  readonly holds: Hold[] = [];

  override async addMessages(messages: MessageData[]): Promise<void> {
    const held = this.holds.shift();
    if (held) {
      held.entered.open();
      await held.release.wait();
    }
    return super.addMessages(messages);
  }
}

/** A slow store: each queued hold makes one chain read wait for its release. */
class HeldChainReadStore extends InMemoryContextStore {
  readonly holds: Hold[] = [];

  override async getMessageChain(headId: string): Promise<MessageData[]> {
    const chain = await super.getMessageChain(headId);
    const held = this.holds.shift();
    if (held) {
      held.entered.open();
      await held.release.wait();
    }
    return chain;
  }
}

/** A slow store: each queued hold makes one branch-head commit wait for its release. */
class HeldCommitStore extends InMemoryContextStore {
  readonly holds: Hold[] = [];

  override async updateBranchHead(
    branchId: string,
    messageId: string | null,
    expectedHeadMessageId: string | null,
  ): Promise<boolean> {
    const held = this.holds.shift();
    if (held) {
      held.entered.open();
      await held.release.wait();
    }
    return super.updateBranchHead(branchId, messageId, expectedHeadMessageId);
  }
}

/** One store outage per queued fault on the next message write. */
class FailNextWriteStore extends InMemoryContextStore {
  readonly faults: Error[] = [];

  override async addMessages(messages: MessageData[]): Promise<void> {
    const fault = this.faults.shift();
    if (fault) throw fault;
    return super.addMessages(messages);
  }
}

describe('ContextEngine messages while a save is in flight', () => {
  it('shows the message exactly once while its write is pending and after it lands', async () => {
    const store = new HeldWriteStore();
    const context = new ContextEngine({ store, chatId: 'held', userId: 'u1' });
    await context.getMessages();
    context.set(user('hello'));
    const write = hold();
    store.holds.push(write);

    const saving = context.save();
    await write.entered.wait();
    const during = await context.getMessages();
    write.release.open();
    await saving;
    const after = await context.getMessages();

    assert.deepStrictEqual(texts(during), ['hello']);
    assert.deepStrictEqual(texts(after), ['hello']);
  });

  it('shows the message to a read whose chain lookup began before the save committed', async () => {
    const store = new HeldChainReadStore();
    const context = new ContextEngine({ store, chatId: 'read', userId: 'u1' });
    context.set(user('first'));
    await context.save();
    context.set(user('second'));
    const read = hold();
    store.holds.push(read);

    const reading = context.getMessages();
    await read.entered.wait();
    await context.save();
    read.release.open();

    assert.deepStrictEqual(texts(await reading), ['first', 'second']);
    assert.deepStrictEqual(texts(await context.getMessages()), [
      'first',
      'second',
    ]);
  });

  it('keeps the message pending after a failed save, and a retry saves it once', async () => {
    const store = new FailNextWriteStore();
    const context = new ContextEngine({ store, chatId: 'fail', userId: 'u1' });
    const hello = user('hello');
    context.set(hello);
    store.faults.push(new Error('database restarting'));

    await assert.rejects(context.save(), /database restarting/);
    const afterFailure = await context.getMessages();
    const retried = await context.save();

    assert.deepStrictEqual(texts(afterFailure), ['hello']);
    assert.deepStrictEqual(texts(await context.getMessages()), ['hello']);
    assert.deepStrictEqual(
      await storedIds(store, retried.headMessageId),
      ids(hello),
    );
  });

  it('leaves the in-flight messages to the first save when a second save overlaps it', async () => {
    const store = new HeldCommitStore();
    const context = new ContextEngine({ store, chatId: 'twice', userId: 'u1' });
    const first = user('first');
    const second = user('second');
    context.set(first);
    await context.save();
    context.set(second);
    const commit = hold();
    store.holds.push(commit);

    const saving = context.save();
    await commit.entered.wait();
    await context.save();
    commit.release.open();
    const saved = await saving;

    assert.strictEqual(context.branch, 'main');
    assert.deepStrictEqual(
      await storedIds(store, saved.headMessageId),
      ids(first, second),
    );
    assert.deepStrictEqual(texts(await context.getMessages()), [
      'first',
      'second',
    ]);
  });

  it('leaves a message set during an in-flight save pending for the next save', async () => {
    const store = new HeldWriteStore();
    const context = new ContextEngine({ store, chatId: 'later', userId: 'u1' });
    await context.getMessages();
    const first = user('first');
    const second = user('second');
    context.set(first);
    const write = hold();
    store.holds.push(write);

    const saving = context.save();
    await write.entered.wait();
    context.set(second);
    write.release.open();
    const saved = await saving;
    const savedIds = await storedIds(store, saved.headMessageId);
    const next = await context.save();

    assert.deepStrictEqual(savedIds, ids(first));
    assert.deepStrictEqual(
      await storedIds(store, next.headMessageId),
      ids(first, second),
    );
    assert.deepStrictEqual(texts(await context.getMessages()), [
      'first',
      'second',
    ]);
  });
});
