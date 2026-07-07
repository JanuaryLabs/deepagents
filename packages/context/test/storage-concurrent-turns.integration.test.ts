import { type UIMessage } from 'ai';
import assert from 'node:assert';
import { describe, it } from 'node:test';

import {
  ContextEngine,
  type ContextStore,
  InMemoryContextStore,
  assistant,
  user,
} from '@deepagents/context';

// Characterises how the message store behaves when turns overlap — e.g. a user
// sends a second message before the first assistant response has finished
// streaming. Each incoming request is modelled as its own ContextEngine sharing
// one store (as concurrent HTTP requests would). `continue(user)` reserves an
// empty assistant placeholder; completing the assistant is `continue(assistant)`.
//
// Invariant under test: no committed user turn may be silently dropped from the
// active chain, and the chain must never contain duplicate message ids or
// duplicate reasoning item ids — regardless of interleaving or completion order.
//
// Head commits go through the store's compare-and-swap
// (ContextStore.updateBranchHead + SavePipeline #commitHead): a writer holding
// a stale cached head can never rewind the branch; a turn that loses the race
// for the same head is grafted onto the winning head instead of orphaning it.

const CHAT = 'concurrent';
const USER = 'u1';

function engine(store: ContextStore): ContextEngine {
  return new ContextEngine({ store, chatId: CHAT, userId: USER });
}

function reply(id: string, text: string): UIMessage {
  return { id, role: 'assistant', parts: [{ type: 'text', text }] };
}

function reasoningReply(id: string, text: string, itemId: string): UIMessage {
  return {
    id,
    role: 'assistant',
    parts: [
      {
        type: 'reasoning',
        text: '',
        state: 'done',
        providerMetadata: {
          openai: { itemId, reasoningEncryptedContent: null },
        },
      },
      { type: 'text', text },
    ] as UIMessage['parts'],
  };
}

async function activeTexts(store: ContextStore): Promise<string[]> {
  const messages = await engine(store).getMessages();
  return messages.map((m) =>
    (m.parts as { type: string; text?: string }[])
      .filter((p) => p.type === 'text')
      .map((p) => p.text ?? '')
      .join(''),
  );
}

describe('message store under overlapping turns', () => {
  it('retains both turns when sent sequentially', async () => {
    const store = new InMemoryContextStore();

    const a1 = await engine(store).continue(user('A'));
    await engine(store).continue(assistant(reply(a1, 'reply-A')));
    const a2 = await engine(store).continue(user('B'));
    await engine(store).continue(assistant(reply(a2, 'reply-B')));

    assert.deepStrictEqual(await activeTexts(store), [
      'A',
      'reply-A',
      'B',
      'reply-B',
    ]);
  });

  it('retains both turns when the first request completes before the second', async () => {
    const store = new InMemoryContextStore();

    const eA = engine(store);
    const aA = await eA.continue(user('A'));
    const eB = engine(store);
    const aB = await eB.continue(user('B'));

    await eA.continue(assistant(reply(aA, 'reply-A')));
    await eB.continue(assistant(reply(aB, 'reply-B')));

    assert.deepStrictEqual(await activeTexts(store), [
      'A',
      'reply-A',
      'B',
      'reply-B',
    ]);
  });

  it('does not drop the second turn when the first assistant finishes last', async () => {
    const store = new InMemoryContextStore();

    const eA = engine(store);
    const aA = await eA.continue(user('A'));
    const eB = engine(store);
    const aB = await eB.continue(user('B'));

    await eB.continue(assistant(reply(aB, 'reply-B'))); // fast second request finishes first
    await eA.continue(assistant(reply(aA, 'reply-A'))); // slow first request finishes last

    assert.deepStrictEqual(await activeTexts(store), [
      'A',
      'reply-A',
      'B',
      'reply-B',
    ]);
  });

  it('does not drop a turn when two requests race the same head', async () => {
    const store = new InMemoryContextStore();
    const seed = engine(store);
    const s = await seed.continue(user('seed'));
    await seed.continue(assistant(reply(s, 'reply-seed')));

    const eA = engine(store);
    const eB = engine(store);
    await Promise.all([eA.getMessages(), eB.getMessages()]); // both initialise at the same head

    const [aA, aB] = await Promise.all([
      eA.continue(user('A')),
      eB.continue(user('B')),
    ]);
    await Promise.all([
      eA.continue(assistant(reply(aA, 'reply-A'))),
      eB.continue(assistant(reply(aB, 'reply-B'))),
    ]);

    const texts = await activeTexts(store);
    assert.ok(texts.includes('A'), `lost turn A: ${JSON.stringify(texts)}`);
    assert.ok(texts.includes('B'), `lost turn B: ${JSON.stringify(texts)}`);
  });

  it('does not drop a turn started before the first assistant completes', async () => {
    const store = new InMemoryContextStore();
    const e = engine(store);

    const a1 = await e.continue(user('A'));
    const a2 = await e.continue(user('B')); // second turn before the first assistant is filled
    await e.continue(assistant(reply(a1, 'reply-A')));
    await e.continue(assistant(reply(a2, 'reply-B')));

    assert.deepStrictEqual(await activeTexts(store), [
      'A',
      'reply-A',
      'B',
      'reply-B',
    ]);
  });

  it('never yields duplicate message ids or duplicate reasoning item ids', async () => {
    const store = new InMemoryContextStore();

    const eA = engine(store);
    const aA = await eA.continue(user('A'));
    const eB = engine(store);
    const aB = await eB.continue(user('B'));
    await eB.continue(assistant(reasoningReply(aB, 'reply-B', 'rs_B')));
    await eA.continue(assistant(reasoningReply(aA, 'reply-A', 'rs_A')));

    const messages = await engine(store).getMessages();

    const ids = messages.map((m) => m.id);
    assert.strictEqual(
      ids.length,
      new Set(ids).size,
      `duplicate message ids: ${JSON.stringify(ids)}`,
    );

    const reasoningIds = messages.flatMap((m) =>
      m.parts
        .filter(
          (
            p,
          ): p is Extract<UIMessage['parts'][number], { type: 'reasoning' }> =>
            p.type === 'reasoning',
        )
        .map((p) => p.providerMetadata?.openai?.itemId)
        .filter((id): id is string => typeof id === 'string'),
    );
    assert.strictEqual(
      reasoningIds.length,
      new Set(reasoningIds).size,
      `duplicate reasoning ids: ${JSON.stringify(reasoningIds)}`,
    );
  });
});
