import assert from 'node:assert';
import { before, describe, it, mock } from 'node:test';

import {
  ContextEngine,
  InMemoryContextStore,
  type InspectResult,
  XmlRenderer,
  assistantText,
  getModelsRegistry,
  hint,
  role,
  user,
} from '../src/index.ts';

describe('ContextEngine.inspect()', () => {
  before(async () => {
    // Pre-load the models registry to avoid network calls in tests
    await getModelsRegistry().load();
  });

  it('should return all expected fields with empty context', async () => {
    const store = new InMemoryContextStore();
    const engine = new ContextEngine({
      store,
      chatId: 'test-chat-1',
    });

    const result = await engine.inspect({
      modelId: 'openai:gpt-4o',
      renderer: new XmlRenderer(),
    });

    // Verify structure
    assert.ok(result.estimate, 'should have estimate');
    assert.strictEqual(
      typeof result.rendered,
      'string',
      'should have rendered',
    );
    assert.ok(result.fragments, 'should have fragments');
    assert.ok(result.graph, 'should have graph');
    assert.ok(result.meta, 'should have meta');

    // Verify meta
    assert.strictEqual(result.meta.chatId, 'test-chat-1');
    assert.strictEqual(result.meta.branch, 'main');
    assert.ok(typeof result.meta.timestamp === 'number');

    // Verify empty fragments
    assert.deepStrictEqual(result.fragments.context, []);
    assert.deepStrictEqual(result.fragments.pending, []);
    assert.deepStrictEqual(result.fragments.persisted, []);
  });

  it('should include context fragments in output', async () => {
    const store = new InMemoryContextStore();
    const engine = new ContextEngine({
      store,
      chatId: 'test-chat-2',
    });

    engine.set(role('You are a helpful assistant.'));
    engine.set(hint('Be concise.'));

    const result = await engine.inspect({
      modelId: 'openai:gpt-4o',
      renderer: new XmlRenderer(),
    });

    // Verify context fragments
    assert.strictEqual(result.fragments.context.length, 2);
    assert.strictEqual(result.fragments.context[0].name, 'role');
    assert.strictEqual(
      result.fragments.context[0].data,
      'You are a helpful assistant.',
    );
    assert.strictEqual(result.fragments.context[1].name, 'hint');

    // Verify rendered output contains the role (using XmlRenderer)
    assert.ok(result.rendered.includes('<role>'));
    assert.ok(result.rendered.includes('helpful assistant'));
  });

  it('should include pending messages', async () => {
    const store = new InMemoryContextStore();
    const engine = new ContextEngine({
      store,
      chatId: 'test-chat-3',
    });

    engine.set(user('Hello!'));
    engine.set(assistantText('Hi there!'));

    const result = await engine.inspect({
      modelId: 'openai:gpt-4o',
      renderer: new XmlRenderer(),
    });

    // Pending messages (not yet saved)
    assert.strictEqual(result.fragments.pending.length, 2);
    assert.strictEqual(result.fragments.pending[0].name, 'user');
    assert.strictEqual(result.fragments.pending[0].data, 'Hello!');
    assert.strictEqual(result.fragments.pending[1].name, 'assistant');

    // No persisted messages yet
    assert.strictEqual(result.fragments.persisted.length, 0);
  });

  it('should include persisted messages after save', async () => {
    const store = new InMemoryContextStore();
    const engine = new ContextEngine({
      store,
      chatId: 'test-chat-4',
    });

    engine.set(user('Hello!'));
    engine.set(assistantText('Hi there!'));
    await engine.save();

    const result = await engine.inspect({
      modelId: 'openai:gpt-4o',
      renderer: new XmlRenderer(),
    });

    // After save, pending should be empty
    assert.strictEqual(result.fragments.pending.length, 0);

    // Persisted messages should exist
    assert.strictEqual(result.fragments.persisted.length, 2);
    assert.strictEqual(result.fragments.persisted[0].name, 'user');
    assert.strictEqual(result.fragments.persisted[1].name, 'assistant');
  });

  it('should provide accurate token estimates', async () => {
    const store = new InMemoryContextStore();
    const engine = new ContextEngine({
      store,
      chatId: 'test-chat-5',
    });

    engine.set(role('You are a helpful assistant.'));

    const result = await engine.inspect({
      modelId: 'openai:gpt-4o',
      renderer: new XmlRenderer(),
    });

    // Verify estimate structure
    assert.ok(result.estimate.tokens > 0, 'should have positive token count');
    assert.ok(result.estimate.cost >= 0, 'should have non-negative cost');
    assert.strictEqual(result.estimate.model, 'gpt-4o');
    assert.strictEqual(result.estimate.provider, 'openai');

    // Verify fragment-level estimates
    assert.ok(result.estimate.fragments.length > 0);
    assert.ok(result.estimate.fragments[0].tokens > 0);
  });

  it('should include graph data', async () => {
    const store = new InMemoryContextStore();
    const engine = new ContextEngine({
      store,
      chatId: 'test-chat-6',
    });

    engine.set(user('Hello!'));
    engine.set(assistantText('Hi!'));
    await engine.save();

    const result = await engine.inspect({
      modelId: 'openai:gpt-4o',
      renderer: new XmlRenderer(),
    });

    // Verify graph structure
    assert.strictEqual(result.graph.chatId, 'test-chat-6');
    assert.strictEqual(result.graph.nodes.length, 2);
    assert.ok(result.graph.branches.length >= 1);

    // Verify branch points to head
    const activeBranch = result.graph.branches.find((b) => b.isActive);
    assert.ok(activeBranch, 'should have active branch');
    assert.ok(activeBranch.headMessageId, 'active branch should have head');
  });

  it('should throw on invalid model ID', async () => {
    const store = new InMemoryContextStore();
    const engine = new ContextEngine({
      store,
      chatId: 'test-chat-8',
    });

    await assert.rejects(async () => {
      await engine.inspect({
        modelId: 'invalid:nonexistent-model' as any,
        renderer: new XmlRenderer(),
      });
    }, /not found/i);
  });

  it('should be JSON-serializable', async () => {
    const store = new InMemoryContextStore();
    const engine = new ContextEngine({
      store,
      chatId: 'test-chat-9',
    });

    engine.set(role('You are helpful.'));
    engine.set(user('Hello'));
    await engine.save();

    const result = await engine.inspect({
      modelId: 'openai:gpt-4o',
      renderer: new XmlRenderer(),
    });

    // Should not throw
    const json = JSON.stringify(result);
    const parsed = JSON.parse(json) as InspectResult;

    // Verify round-trip
    assert.strictEqual(parsed.meta.chatId, 'test-chat-9');
    assert.strictEqual(parsed.estimate.model, 'gpt-4o');
    assert.ok(parsed.rendered.includes('helpful'));
  });
});
