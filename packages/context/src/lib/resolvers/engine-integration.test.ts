import { InMemoryFs } from 'just-bash';
import assert from 'node:assert';
import { describe, it, mock } from 'node:test';

import {
  ContextEngine,
  InMemoryContextStore,
  XmlRenderer,
  createBashTool,
  createVirtualSandbox,
  fragment,
  hint,
  role,
} from '@deepagents/context';

async function createVirtualAgentSandbox() {
  return createBashTool({
    sandbox: await createVirtualSandbox({ fs: new InMemoryFs() }),
  });
}

const newEngine = () =>
  new ContextEngine({
    store: new InMemoryContextStore(),
    chatId: 'resolver-test',
    userId: 'user-1',
  });

describe('engine + resolver chain integration', () => {
  it('materializes async loaders in resolve()', async () => {
    const engine = newEngine();
    engine.set(
      role('You are a helper.'),
      fragment('readme', async () => 'project documentation'),
    );

    const { systemPrompt } = await engine.resolve({
      renderer: new XmlRenderer(),
      sandbox: await createVirtualAgentSandbox(),
    });

    assert.ok(systemPrompt.includes('project documentation'));
  });

  it('caches resolved values across resolve() calls', async () => {
    const engine = newEngine();
    const sandbox = await createVirtualAgentSandbox();
    const loader = mock.fn(async () => 'loaded-once');
    engine.set(fragment('cached', loader));

    await engine.resolve({ renderer: new XmlRenderer(), sandbox });
    await engine.resolve({ renderer: new XmlRenderer(), sandbox });

    assert.strictEqual(loader.mock.callCount(), 1);
  });

  it('passes the sandbox through to the loader', async () => {
    const engine = newEngine();
    const sandbox = await createVirtualAgentSandbox();
    let capturedSandbox: unknown = null;
    engine.set(
      fragment('probe', async (ctx) => {
        capturedSandbox = ctx.sandbox;
        return 'ok';
      }),
    );

    await engine.resolve({
      renderer: new XmlRenderer(),
      sandbox,
    });

    assert.strictEqual(capturedSandbox, sandbox);
  });

  it('rejects when a loader throws', async () => {
    const engine = newEngine();
    engine.set(
      fragment('broken', async () => {
        throw new Error('loader failed');
      }),
    );

    const sandbox = await createVirtualAgentSandbox();
    await assert.rejects(
      () =>
        engine.resolve({
          renderer: new XmlRenderer(),
          sandbox,
        }),
      /loader failed/,
    );
  });

  it('accepts a custom resolver chain via constructor', async () => {
    let customClaims = 0;
    let originalLoaderCalls = 0;
    class CountingResolver {
      readonly name = 'CountingResolver';
      canResolve(v: unknown): boolean {
        return typeof v === 'function';
      }
      async resolve() {
        customClaims += 1;
        return 'from-custom';
      }
    }

    const engine = new ContextEngine({
      store: new InMemoryContextStore(),
      chatId: 'custom-chain',
      userId: 'u',
      resolvers: [new CountingResolver()],
    });
    engine.set(
      fragment('x', async () => {
        originalLoaderCalls += 1;
        return 'from-original';
      }),
    );

    const { systemPrompt } = await engine.resolve({
      renderer: new XmlRenderer(),
      sandbox: await createVirtualAgentSandbox(),
    });

    assert.strictEqual(customClaims, 1);
    assert.strictEqual(originalLoaderCalls, 0);
    assert.ok(systemPrompt.includes('from-custom'));
    assert.ok(!systemPrompt.includes('from-original'));
  });

  it('coexists with sync (non-loader) fragments', async () => {
    const engine = newEngine();
    engine.set(
      hint('Be brief.'),
      fragment('async-hint', async () => 'Use UTC timestamps.'),
    );

    const { systemPrompt } = await engine.resolve({
      renderer: new XmlRenderer(),
      sandbox: await createVirtualAgentSandbox(),
    });

    assert.ok(systemPrompt.includes('Be brief.'));
    assert.ok(systemPrompt.includes('Use UTC timestamps.'));
  });

  it('estimate() materializes loaders before counting tokens', async () => {
    const engine = newEngine();
    const sandbox = await createVirtualAgentSandbox();
    const longString = 'x'.repeat(2000);
    engine.set(fragment('big', async () => longString));

    const result = await engine.estimate('openai:gpt-4o', { sandbox });

    // The 2000-char string materialized into the system prompt should bump
    // the input token count well above what an empty context produces.
    assert.ok(
      result.tokens > 100,
      `expected materialized tokens, got ${result.tokens}`,
    );
  });

  it('estimate() invokes a loader exactly once (caching)', async () => {
    const engine = newEngine();
    const sandbox = await createVirtualAgentSandbox();
    const loader = mock.fn(async () => 'estimate-content');
    engine.set(fragment('once', loader));

    await engine.estimate('openai:gpt-4o', { sandbox });
    await engine.estimate('openai:gpt-4o', { sandbox });

    assert.strictEqual(loader.mock.callCount(), 1);
  });

  it('inspect() materializes loaders before rendering', async () => {
    const engine = newEngine();
    const sandbox = await createVirtualAgentSandbox();
    engine.set(fragment('readme', async () => 'inspected-content'));

    const result = await engine.inspect({
      modelId: 'openai:gpt-4o',
      renderer: new XmlRenderer(),
      sandbox,
    });

    assert.ok(result.rendered.includes('inspected-content'));
  });
});
