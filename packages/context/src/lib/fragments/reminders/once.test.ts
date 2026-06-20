import assert from 'node:assert';
import { describe, it } from 'node:test';

import { and, once, or } from '@deepagents/context';
import type { WhenContext } from '@deepagents/context';

// Steer-realistic context: firedOnceIds is always a Set during steer evaluation
// (only its absence signals a non-steer target). Tests override as needed.
function ctx(over: Partial<WhenContext> = {}): WhenContext {
  return {
    turn: 1,
    content: '',
    currentMessage: { id: 'm', role: 'user', parts: [] },
    chat: {} as never,
    branch: 'main',
    messageCount: 1,
    firedOnceIds: new Set(),
    ...over,
  };
}

describe('once(id)', () => {
  it('returns true until its id has fired, false after', async () => {
    assert.strictEqual(await once('recap')(ctx()), true);
    assert.strictEqual(
      await once('recap')(ctx({ firedOnceIds: new Set(['recap']) })),
      false,
    );
    assert.strictEqual(
      await once('recap')(ctx({ firedOnceIds: new Set(['other']) })),
      true,
    );
  });

  it('throws when used off a steer target (firedOnceIds absent)', async () => {
    await assert.rejects(
      async () => once('x')(ctx({ firedOnceIds: undefined })),
      /only supported on target:'steer'/,
    );
  });

  it('rejects an empty id', () => {
    assert.throws(() => once('  '), /non-empty id/);
  });

  it('records latch intent in onceCollector only when consulted and not fired', async () => {
    const collected = new Set<string>();
    await once('x')(ctx({ onceCollector: collected }));
    assert.deepStrictEqual([...collected], ['x']);

    // already fired → no intent recorded
    const afterFired = new Set<string>();
    await once('x')(
      ctx({ firedOnceIds: new Set(['x']), onceCollector: afterFired }),
    );
    assert.deepStrictEqual([...afterFired], []);
  });

  it('a short-circuited once() inside a combinator records no intent', async () => {
    // or() reaches once('b') only if once('a') is false; both true here means
    // or short-circuits on once('a') and never consults once('b').
    const collected = new Set<string>();
    const fired = await or(
      once('a'),
      once('b'),
    )(ctx({ onceCollector: collected }));
    assert.strictEqual(fired, true);
    assert.deepStrictEqual([...collected], ['a']);

    // and() consults both when the first is true.
    const both = new Set<string>();
    await and(once('a'), once('b'))(ctx({ onceCollector: both }));
    assert.deepStrictEqual([...both], ['a', 'b']);
  });
});
