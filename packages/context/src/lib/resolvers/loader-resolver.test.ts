import { InMemoryFs } from 'just-bash';
import assert from 'node:assert';
import { describe, it } from 'node:test';

import {
  AsyncResolver,
  ContextEngine,
  type ContextFragment,
  FragmentLoaderResolver,
  FunctionResolver,
  GeneratorResolver,
  InMemoryContextStore,
  IterableResolver,
  type LoadContext,
  PromiseResolver,
  XmlRenderer,
  createBashTool,
  createRoutingSandbox,
  createVirtualSandbox,
  defaultResolvers,
  fragment,
} from '@deepagents/context';

async function createVirtualAgentSandbox() {
  return createBashTool({
    sandbox: await createRoutingSandbox({
      backend: await createVirtualSandbox({ fs: new InMemoryFs() }),
      hostExtensions: [],
    }),
  });
}

async function ctx(signal?: AbortSignal): Promise<LoadContext> {
  return {
    sandbox: await createVirtualAgentSandbox(),
    context: new ContextEngine({
      store: new InMemoryContextStore(),
      chatId: crypto.randomUUID(),
      userId: 'resolver-test',
    }),
    signal,
  };
}

const newWalker = () => new FragmentLoaderResolver(defaultResolvers());

describe('FragmentLoaderResolver — top-level loader', () => {
  it('materializes a top-level async loader as fragment data', async () => {
    const f = fragment('readme', async () => 'file contents');
    const walker = newWalker();
    await walker.resolve([f], await ctx());
    assert.deepStrictEqual(f.data, ['file contents']);
  });

  it('materializes a sync loader', async () => {
    const f = fragment('counter', () => 42);
    const walker = newWalker();
    await walker.resolve([f], await ctx());
    assert.deepStrictEqual(f.data, [42]);
  });

  it('materializes a generator loader into an array', async () => {
    function* g() {
      yield 'a';
      yield 'b';
    }
    const f = fragment('chunks', g);
    const walker = newWalker();
    await walker.resolve([f], await ctx());
    assert.deepStrictEqual(f.data, [['a', 'b']]);
  });
});

describe('FragmentLoaderResolver — nested', () => {
  it('materializes a loader nested inside an array child', async () => {
    const f = fragment('outer', ['static', async () => 'loaded']);
    const walker = newWalker();
    await walker.resolve([f], await ctx());
    assert.deepStrictEqual(f.data, [['static', 'loaded']]);
  });

  it('materializes a loader nested inside a child fragment', async () => {
    const inner = fragment('inner', async () => 'deep');
    const outer = fragment('outer', inner);
    const walker = newWalker();
    await walker.resolve([outer], await ctx());
    assert.deepStrictEqual(outer.data, [inner]);
    assert.deepStrictEqual(inner.data, ['deep']);
  });

  it('recurses when a loader returns another loader', async () => {
    const f = fragment('lazy', async () => async () => 'eventually');
    const walker = newWalker();
    await walker.resolve([f], await ctx());
    assert.deepStrictEqual(f.data, ['eventually']);
  });

  it('recurses when a loader returns a fragment containing a loader', async () => {
    const f = fragment('outer', async () =>
      fragment('inner', async () => 'final'),
    );
    const walker = newWalker();
    await walker.resolve([f], await ctx());
    const data = f.data as ContextFragment[];
    assert.strictEqual(data.length, 1);
    assert.deepStrictEqual(data[0].data, ['final']);
  });
});

describe('FragmentLoaderResolver — caching', () => {
  it('does not call a loader twice across two resolve() calls', async () => {
    let calls = 0;
    const f = fragment('counter', async () => {
      calls += 1;
      return calls;
    });
    const walker = newWalker();
    await walker.resolve([f], await ctx());
    await walker.resolve([f], await ctx());
    assert.strictEqual(calls, 1);
  });
});

describe('FragmentLoaderResolver — errors', () => {
  it('wraps loader errors with fragment path and handler name', async () => {
    const f = fragment('bad', async () => {
      throw new Error('original cause');
    });
    const walker = newWalker();
    const loadContext = await ctx();
    await assert.rejects(
      () => walker.resolve([f], loadContext),
      /Async fragment 'bad' failed in AsyncResolver: original cause/,
    );
  });

  it('preserves the original error as the cause', async () => {
    const original = new Error('inner');
    const f = fragment('outer', async () => {
      throw original;
    });
    const walker = newWalker();
    try {
      await walker.resolve([f], await ctx());
      assert.fail('expected reject');
    } catch (err) {
      assert.strictEqual((err as Error).cause, original);
    }
  });

  it('throws on recursion past maxDepth with fragment name in message', async () => {
    const walker = new FragmentLoaderResolver(defaultResolvers(), {
      maxDepth: 2,
    });
    const recursive: () => () => unknown = () => () => recursive();
    const f = fragment('deep', recursive());
    const loadContext = await ctx();
    await assert.rejects(
      () => walker.resolve([f], loadContext),
      /Resolver recursion exceeded maxDepth=2 at fragment 'deep'/,
    );
  });
});

describe('FragmentLoaderResolver — cycle handling', () => {
  it('does not false-positive on a sub-object shared between siblings', async () => {
    const shared = { key: 'value' };
    const f = fragment('parent', [shared, shared]);
    const walker = newWalker();
    await walker.resolve([f], await ctx());
    const data = f.data as Array<Array<{ key: string }>>;
    assert.deepStrictEqual(data[0][0], { key: 'value' });
    assert.deepStrictEqual(data[0][1], { key: 'value' });
  });

  it('terminates on a self-referential array cycle', async () => {
    const arr: unknown[] = ['a'];
    arr.push(arr);
    const f = fragment('cyclic', arr);
    const walker = newWalker();
    await walker.resolve([f], await ctx());
    const data = f.data as unknown[][];
    assert.strictEqual(data[0][0], 'a');
  });
});

describe('FragmentLoaderResolver — abort signal', () => {
  it('aborts pre-walk when signal is already aborted', async () => {
    const ac = new AbortController();
    ac.abort(new Error('cancel'));
    const f = fragment('x', async () => 'never');
    const walker = newWalker();
    const loadContext = await ctx(ac.signal);
    await assert.rejects(() => walker.resolve([f], loadContext), /cancel/);
  });

  it('proceeds when no signal is provided', async () => {
    const f = fragment('x', async () => 'ok');
    const walker = newWalker();
    await walker.resolve([f], await ctx());
    assert.deepStrictEqual(f.data, ['ok']);
  });

  it('aborts mid-flight when signal triggers during a slow loader', async () => {
    const ac = new AbortController();
    const f = fragment(
      'slow',
      () =>
        new Promise<string>((resolve) =>
          setTimeout(() => resolve('too-late'), 200),
        ),
    );
    const walker = newWalker();
    setTimeout(() => ac.abort(new Error('mid-flight')), 20);
    const loadContext = await ctx(ac.signal);
    await assert.rejects(() => walker.resolve([f], loadContext), /mid-flight/);
  });
});

describe('FragmentLoaderResolver — custom resolver chain', () => {
  it('uses only the resolvers provided', async () => {
    const walker = new FragmentLoaderResolver([new AsyncResolver()]);
    const f = fragment('only-async', async () => 'async-result');
    await walker.resolve([f], await ctx());
    assert.deepStrictEqual(f.data, ['async-result']);
  });

  it('does not invoke disabled resolvers', async () => {
    // Chain without FunctionResolver — sync function leaks through unchanged.
    const walker = new FragmentLoaderResolver([new AsyncResolver()]);
    const syncLoader = () => 'sync';
    const f = fragment('sync-leak', syncLoader);
    await walker.resolve([f], await ctx());
    const data = f.data as unknown[];
    assert.strictEqual(data[0], syncLoader);
  });
});

describe('FragmentLoaderResolver — full default chain integration', () => {
  it('renders to XML after materialization', async () => {
    const f = fragment('skills', async () => ['skill-a', 'skill-b']);
    const walker = newWalker();
    await walker.resolve([f], await ctx());
    const xml = new XmlRenderer().render([f]);
    assert.ok(xml.includes('skill-a'));
    assert.ok(xml.includes('skill-b'));
  });

  it('handles all resolver types in one fragment tree', async () => {
    const f = fragment('mixed', [
      async () => 'from-async',
      () => 'from-sync',
      Promise.resolve('from-promise'),
      new Set(['from-iterable']),
    ]);
    const walker = new FragmentLoaderResolver([
      new AsyncResolver(),
      new GeneratorResolver(),
      new FunctionResolver(),
      new PromiseResolver(),
      new IterableResolver(),
    ]);
    await walker.resolve([f], await ctx());
    assert.deepStrictEqual(f.data, [
      ['from-async', 'from-sync', 'from-promise', ['from-iterable']],
    ]);
  });
});
