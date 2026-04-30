import assert from 'node:assert';
import { describe, it } from 'node:test';

import {
  type WhenContext,
  afterTurn,
  everyNTurns,
  firstN,
  once,
} from '@deepagents/context';

function wctx(
  partial: Partial<WhenContext> & { turn: number; content: string },
): WhenContext {
  return {
    branch: 'main',
    chat: { id: 'test-chat', userId: 'test-user', createdAt: 0, updatedAt: 0 },
    messageCount: 0,
    ...partial,
  };
}

describe('everyNTurns', () => {
  it('fires on turns divisible by N', () => {
    const pred = everyNTurns(3);
    assert.strictEqual(pred(wctx({ turn: 1, content: '' })), false);
    assert.strictEqual(pred(wctx({ turn: 2, content: '' })), false);
    assert.strictEqual(pred(wctx({ turn: 3, content: '' })), true);
    assert.strictEqual(pred(wctx({ turn: 6, content: '' })), true);
    assert.strictEqual(pred(wctx({ turn: 7, content: '' })), false);
  });
});

describe('once', () => {
  it('fires only on turn 1', () => {
    const pred = once();
    assert.strictEqual(pred(wctx({ turn: 1, content: '' })), true);
    assert.strictEqual(pred(wctx({ turn: 2, content: '' })), false);
    assert.strictEqual(pred(wctx({ turn: 10, content: '' })), false);
  });
});

describe('firstN', () => {
  it('fires on first N turns', () => {
    const pred = firstN(3);
    assert.strictEqual(pred(wctx({ turn: 1, content: '' })), true);
    assert.strictEqual(pred(wctx({ turn: 3, content: '' })), true);
    assert.strictEqual(pred(wctx({ turn: 4, content: '' })), false);
  });
});

describe('afterTurn', () => {
  it('fires only after turn N', () => {
    const pred = afterTurn(5);
    assert.strictEqual(pred(wctx({ turn: 5, content: '' })), false);
    assert.strictEqual(pred(wctx({ turn: 6, content: '' })), true);
    assert.strictEqual(pred(wctx({ turn: 10, content: '' })), true);
  });
});

describe('custom WhenPredicate', () => {
  it('arbitrary turn-based function satisfies the contract', () => {
    const pred = ({ turn }: { turn: number; content: string }) => turn === 4;
    assert.strictEqual(pred(wctx({ turn: 3, content: '' })), false);
    assert.strictEqual(pred(wctx({ turn: 4, content: '' })), true);
    assert.strictEqual(pred(wctx({ turn: 5, content: '' })), false);
  });
});
