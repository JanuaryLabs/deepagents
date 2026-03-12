import assert from 'node:assert';
import { before, describe, it } from 'node:test';

import {
  ContextEngine,
  InMemoryContextStore,
  XmlRenderer,
  getModelsRegistry,
  user,
} from '@deepagents/context';

describe('ContextEngine.estimate() with message codecs', () => {
  before(async () => {
    await getModelsRegistry().load();
  });

  it('counts pending message tokens from encoded UIMessage content', async () => {
    const shortEngine = new ContextEngine({
      userId: 'test-user',
      store: new InMemoryContextStore(),
      chatId: 'estimate-pending-short',
    });
    shortEngine.set(user('hi'));

    const longEngine = new ContextEngine({
      userId: 'test-user',
      store: new InMemoryContextStore(),
      chatId: 'estimate-pending-long',
    });
    longEngine.set(
      user(
        'this is a much longer pending message that should produce more input tokens than the short one',
      ),
    );

    const shortEstimate = await shortEngine.estimate('openai:gpt-4o', {
      renderer: new XmlRenderer(),
    });
    const longEstimate = await longEngine.estimate('openai:gpt-4o', {
      renderer: new XmlRenderer(),
    });

    const shortUser = shortEstimate.fragments.find((f) => f.name === 'user');
    const longUser = longEstimate.fragments.find((f) => f.name === 'user');

    assert.ok(shortUser, 'expected short pending user estimate');
    assert.ok(longUser, 'expected long pending user estimate');
    assert.ok(
      longUser.tokens > shortUser.tokens,
      'expected longer pending message to cost more tokens',
    );
  });

  it('counts persisted message tokens from stored UIMessage content', async () => {
    const shortEngine = new ContextEngine({
      userId: 'test-user',
      store: new InMemoryContextStore(),
      chatId: 'estimate-persisted-short',
    });
    shortEngine.set(user('hi'));
    await shortEngine.save();

    const longEngine = new ContextEngine({
      userId: 'test-user',
      store: new InMemoryContextStore(),
      chatId: 'estimate-persisted-long',
    });
    longEngine.set(
      user(
        'this is a much longer persisted message that should produce more input tokens than the short one',
      ),
    );
    await longEngine.save();

    const shortEstimate = await shortEngine.estimate('openai:gpt-4o', {
      renderer: new XmlRenderer(),
    });
    const longEstimate = await longEngine.estimate('openai:gpt-4o', {
      renderer: new XmlRenderer(),
    });

    const shortUser = shortEstimate.fragments.find((f) => f.name === 'user');
    const longUser = longEstimate.fragments.find((f) => f.name === 'user');

    assert.ok(shortUser, 'expected short persisted user estimate');
    assert.ok(longUser, 'expected long persisted user estimate');
    assert.ok(
      longUser.tokens > shortUser.tokens,
      'expected longer persisted message to cost more tokens',
    );
  });
});
