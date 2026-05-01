import assert from 'node:assert';
import { describe, it } from 'node:test';

import {
  type WhenContext,
  afterTurn,
  and,
  everyNTurns,
  firstN,
  not,
  once,
  or,
} from '@deepagents/context';

function wctx(
  partial: Partial<WhenContext> & { turn: number; content: string },
): WhenContext {
  return {
    branch: 'main',
    chat: { id: 'test-chat', userId: 'test-user', createdAt: 0, updatedAt: 0 },
    messageCount: 0,
    currentMessage: {
      id: 'test-msg',
      role: 'user',
      parts: [{ type: 'text', text: partial.content }],
    },
    ...partial,
  };
}

describe('and', () => {
  it('combines with AND logic', async () => {
    const pred = and(everyNTurns(3), afterTurn(5));
    assert.strictEqual(await pred(wctx({ turn: 3, content: '' })), false);
    assert.strictEqual(await pred(wctx({ turn: 6, content: '' })), true);
    assert.strictEqual(await pred(wctx({ turn: 7, content: '' })), false);
    assert.strictEqual(await pred(wctx({ turn: 9, content: '' })), true);
  });
});

describe('or', () => {
  it('combines with OR logic', async () => {
    const pred = or(once(), everyNTurns(5));
    assert.strictEqual(await pred(wctx({ turn: 1, content: '' })), true);
    assert.strictEqual(await pred(wctx({ turn: 2, content: '' })), false);
    assert.strictEqual(await pred(wctx({ turn: 5, content: '' })), true);
    assert.strictEqual(await pred(wctx({ turn: 10, content: '' })), true);
  });
});

describe('not', () => {
  it('inverts a predicate', async () => {
    const pred = not(firstN(2));
    assert.strictEqual(await pred(wctx({ turn: 1, content: '' })), false);
    assert.strictEqual(await pred(wctx({ turn: 2, content: '' })), false);
    assert.strictEqual(await pred(wctx({ turn: 3, content: '' })), true);
  });
});
