import { type UIMessage } from 'ai';
import assert from 'node:assert';
import { describe, it } from 'node:test';

import {
  ContextEngine,
  InMemoryContextStore,
  XmlRenderer,
  assistant,
  user,
} from '@deepagents/context';

function makeEngine() {
  return new ContextEngine({
    store: new InMemoryContextStore(),
    chatId: `empty-asst-${Math.random().toString(36).slice(2)}`,
    userId: 'test-user',
  });
}

describe('ContextEngine.getMessages filters empty assistant placeholders', () => {
  it('omits a pending assistant fragment whose parts are empty', async () => {
    const engine = makeEngine();
    engine.set(
      user({ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }),
    );
    engine.set(assistant({ id: 'a1', role: 'assistant', parts: [] }));

    const { messages } = await engine.resolve({ renderer: new XmlRenderer() });

    assert.deepStrictEqual(
      messages.map((m) => ({ id: m.id, role: m.role })),
      [{ id: 'u1', role: 'user' }],
    );
  });

  it('keeps pending assistant fragments that have parts', async () => {
    const engine = makeEngine();
    engine.set(
      user({ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }),
    );
    const filledAssistant: UIMessage = {
      id: 'a1',
      role: 'assistant',
      parts: [{ type: 'text', text: 'hello' }],
    };
    engine.set(assistant(filledAssistant));

    const { messages } = await engine.resolve({ renderer: new XmlRenderer() });

    assert.strictEqual(messages.length, 2);
    assert.strictEqual(messages[1].id, 'a1');
    assert.strictEqual(messages[1].parts.length, 1);
  });

  it('preserves order when the placeholder is between other messages', async () => {
    const engine = makeEngine();
    engine.set(
      user({ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'q1' }] }),
    );
    engine.set(assistant({ id: 'a1', role: 'assistant', parts: [] }));
    engine.set(
      user({ id: 'u2', role: 'user', parts: [{ type: 'text', text: 'q2' }] }),
    );

    const { messages } = await engine.resolve({ renderer: new XmlRenderer() });

    assert.deepStrictEqual(
      messages.map((m) => m.id),
      ['u1', 'u2'],
    );
  });
});
