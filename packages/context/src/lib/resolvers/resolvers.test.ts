import { InMemoryFs } from 'just-bash';
import assert from 'node:assert';
import { describe, it } from 'node:test';

import {
  AsyncResolver,
  ContextEngine,
  FunctionResolver,
  GeneratorResolver,
  InMemoryContextStore,
  IterableResolver,
  type LoadContext,
  PromiseResolver,
  createBashTool,
  createVirtualSandbox,
  fragment,
} from '@deepagents/context';

async function createVirtualAgentSandbox() {
  return createBashTool({
    sandbox: await createVirtualSandbox({ fs: new InMemoryFs() }),
  });
}

async function ctx(): Promise<LoadContext> {
  return {
    sandbox: await createVirtualAgentSandbox(),
    context: new ContextEngine({
      store: new InMemoryContextStore(),
      chatId: crypto.randomUUID(),
      userId: 'resolver-test',
    }),
  };
}

describe('AsyncResolver', () => {
  const r = new AsyncResolver();

  it('claims async functions', () => {
    assert.strictEqual(
      r.canResolve(async () => 1),
      true,
    );
  });

  it('rejects sync functions', () => {
    assert.strictEqual(
      r.canResolve(() => 1),
      false,
    );
  });

  it('rejects non-functions', () => {
    assert.strictEqual(r.canResolve('hi'), false);
    assert.strictEqual(r.canResolve(Promise.resolve(1)), false);
  });

  it('awaits the loader and returns its result', async () => {
    const result = await r.resolve(async () => 'hello', await ctx());
    assert.strictEqual(result, 'hello');
  });
});

describe('FunctionResolver', () => {
  const r = new FunctionResolver();

  it('claims sync functions', () => {
    assert.strictEqual(
      r.canResolve(() => 1),
      true,
    );
  });

  it('claims any function (default chain orders Async/Generator before this one)', () => {
    assert.strictEqual(
      r.canResolve(async () => 1),
      true,
    );
  });

  it('returns the loader result wrapped in Promise', async () => {
    const result = await r.resolve(() => 42, await ctx());
    assert.strictEqual(result, 42);
  });
});

describe('GeneratorResolver', () => {
  const r = new GeneratorResolver();

  it('claims generator functions', () => {
    assert.strictEqual(
      r.canResolve(function* gen() {
        yield 1;
      }),
      true,
    );
  });

  it('claims async generator functions', () => {
    assert.strictEqual(
      r.canResolve(async function* gen() {
        yield 1;
      }),
      true,
    );
  });

  it('rejects regular sync functions', () => {
    assert.strictEqual(
      r.canResolve(() => 1),
      false,
    );
  });

  it('collects sync yields into an array', async () => {
    function* gen() {
      yield 'a';
      yield 'b';
    }
    const result = await r.resolve(gen, await ctx());
    assert.deepStrictEqual(result, ['a', 'b']);
  });

  it('collects async yields into an array', async () => {
    async function* gen() {
      yield 1;
      yield 2;
      yield 3;
    }
    const result = await r.resolve(gen, await ctx());
    assert.deepStrictEqual(result, [1, 2, 3]);
  });

  it('propagates errors thrown mid-iteration', async () => {
    async function* gen() {
      yield 'a';
      throw new Error('mid-iteration');
    }
    const loadCtx = await ctx();
    await assert.rejects(() => r.resolve(gen, loadCtx), /mid-iteration/);
  });
});

describe('PromiseResolver', () => {
  const r = new PromiseResolver();

  it('claims Promise instances', () => {
    assert.strictEqual(r.canResolve(Promise.resolve(1)), true);
  });

  it('rejects non-promises', () => {
    assert.strictEqual(r.canResolve(1), false);
    assert.strictEqual(
      r.canResolve(() => 1),
      false,
    );
  });

  it('awaits the promise', async () => {
    const result = await r.resolve(Promise.resolve('done'), await ctx());
    assert.strictEqual(result, 'done');
  });

  it('propagates rejected promises', async () => {
    const loadCtx = await ctx();
    const rejected = Promise.reject(new Error('boom'));
    // Suppress the unhandled-rejection warning before assert.rejects can catch it.
    rejected.catch(() => {});
    await assert.rejects(() => r.resolve(rejected, loadCtx), /boom/);
  });
});

describe('IterableResolver', () => {
  const r = new IterableResolver();

  it('claims plain iterables (Map, Set, custom)', () => {
    assert.strictEqual(r.canResolve(new Set([1])), true);
    assert.strictEqual(r.canResolve(new Map([['k', 'v']])), true);
  });

  it('rejects strings', () => {
    assert.strictEqual(r.canResolve('hello'), false);
  });

  it('rejects arrays', () => {
    assert.strictEqual(r.canResolve([1, 2]), false);
  });

  it('rejects fragments', () => {
    assert.strictEqual(r.canResolve(fragment('x', 'y')), false);
  });

  it('rejects promises', () => {
    assert.strictEqual(r.canResolve(Promise.resolve(1)), false);
  });

  it('collects iterable values into an array', async () => {
    const result = await r.resolve(new Set(['a', 'b', 'c']), await ctx());
    assert.deepStrictEqual(result, ['a', 'b', 'c']);
  });

  it('iterates a Map as entry pairs (not as an object)', async () => {
    const result = await r.resolve(
      new Map([
        ['k1', 'v1'],
        ['k2', 'v2'],
      ]),
      await ctx(),
    );
    assert.deepStrictEqual(result, [
      ['k1', 'v1'],
      ['k2', 'v2'],
    ]);
  });
});
