import { Latch } from '@zukhruf/async';
import assert from 'node:assert';
import { describe, it } from 'node:test';

import { ContextEngine, InMemoryContextStore, user } from '@deepagents/context';

describe('ContextEngine opening its chat', () => {
  it('reports no chat, the main branch and no head before the first store call', () => {
    const engine = new ContextEngine({
      store: new InMemoryContextStore(),
      chatId: 'unopened',
      userId: 'u1',
    });

    assert.strictEqual(engine.chat, null);
    assert.strictEqual(engine.branch, 'main');
    assert.strictEqual(engine.headMessageId, undefined);
  });

  it('opens again after a failed open', async () => {
    /** One store outage while the engine reads its active branch. */
    class FailFirstBranchReadStore extends InMemoryContextStore {
      readonly #faults = [new Error('database restarting')];

      override async getActiveBranch(chatId: string) {
        const fault = this.#faults.shift();
        if (fault) throw fault;
        return super.getActiveBranch(chatId);
      }
    }
    const engine = new ContextEngine({
      store: new FailFirstBranchReadStore(),
      chatId: 'retry',
      userId: 'u1',
    });

    await assert.rejects(engine.getMessages(), /database restarting/);
    assert.deepStrictEqual(await engine.getMessages(), []);
    assert.strictEqual(engine.chat?.id, 'retry');
  });

  it("keeps another user's chat hidden when the owner check fails", async () => {
    const store = new InMemoryContextStore();
    await new ContextEngine({
      store,
      chatId: 'shared',
      userId: 'owner',
    }).getMessages();
    const intruder = new ContextEngine({
      store,
      chatId: 'shared',
      userId: 'intruder',
    });

    await assert.rejects(intruder.getMessages(), /belongs to user "owner"/);

    assert.strictEqual(intruder.chat, null);
  });

  it('keeps the saved head when the first calls on one engine overlap', async () => {
    const release = new Latch();
    /** A slow store: the second branch read returns only after the latch opens. */
    class SlowSecondBranchReadStore extends InMemoryContextStore {
      #reads = 0;

      override async getActiveBranch(chatId: string) {
        const branch = await super.getActiveBranch(chatId);
        this.#reads += 1;
        if (this.#reads === 2) await release.wait();
        return branch;
      }
    }
    const context = new ContextEngine({
      store: new SlowSecondBranchReadStore(),
      chatId: 'overlap',
      userId: 'u1',
    });
    context.set(user('hello'));

    const saving = context.save();
    const reading = context.getMessages();
    const saved = await saving;
    release.open();
    await reading;

    assert.ok(saved.headMessageId, 'save committed a head');
    assert.strictEqual(context.headMessageId, saved.headMessageId);
    const messages = await context.getMessages();
    assert.deepStrictEqual(
      messages.map((m) =>
        m.parts
          .filter((p) => p.type === 'text')
          .map((p) => p.text)
          .join(''),
      ),
      ['hello'],
    );
  });
});
