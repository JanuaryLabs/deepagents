import { generateId } from 'ai';
import { InMemoryFs } from 'just-bash';
import assert from 'node:assert';
import { describe, it } from 'node:test';

import {
  ContextEngine,
  InMemoryContextStore,
  XmlRenderer,
  assertCountSpec,
  assistant,
  createBashTool,
  createVirtualSandbox,
  lastAssistantLength,
  reminder,
  user,
} from '@deepagents/context';

import { getTextParts } from '../../text.ts';

async function createVirtualAgentSandbox() {
  return createBashTool({
    sandbox: await createVirtualSandbox({ fs: new InMemoryFs() }),
  });
}

async function setupAssistantText(chatId: string, text: string) {
  const store = new InMemoryContextStore();
  const engine = new ContextEngine({ store, chatId, userId: 'u1' });
  engine.set(user('turn 1'));
  engine.set(
    assistant({
      id: generateId(),
      role: 'assistant',
      parts: [{ type: 'text', text }],
    }),
  );
  await engine.save();
  return engine;
}

async function lastUserText(engine: ContextEngine): Promise<string> {
  const { messages } = await engine.resolve({
    renderer: new XmlRenderer(),
    sandbox: await createVirtualAgentSandbox(),
  });
  return getTextParts(messages[messages.length - 1]).join('');
}

describe('lastAssistantLength', () => {
  it('fires when text length passes gte threshold', async () => {
    const engine = await setupAssistantText('lal-gte', 'x'.repeat(2500));
    engine.set(
      reminder('verbose', { when: lastAssistantLength({ gte: 2000 }) }),
      user('turn 2'),
    );
    await engine.save();
    assert.ok((await lastUserText(engine)).includes('verbose'));
  });

  it('does NOT fire below threshold', async () => {
    const engine = await setupAssistantText('lal-below', 'short');
    engine.set(
      reminder('verbose', { when: lastAssistantLength({ gte: 2000 }) }),
      user('turn 2'),
    );
    await engine.save();
    assert.ok(!(await lastUserText(engine)).includes('verbose'));
  });

  it('throws at builder time when spec is empty', () => {
    assert.throws(
      () => lastAssistantLength({}),
      /at least one of gte\/lte\/eq/,
    );
  });

  it('returns false when no assistant history exists', async () => {
    const store = new InMemoryContextStore();
    const engine = new ContextEngine({
      store,
      chatId: 'lal-empty',
      userId: 'u1',
    });
    engine.set(
      reminder('verbose', { when: lastAssistantLength({ gte: 1 }) }),
      user('hi'),
    );
    await engine.save();
    assert.ok(!(await lastUserText(engine)).includes('verbose'));
  });
});

describe('assertCountSpec', () => {
  it('throws when spec has no fields', () => {
    assert.throws(() => assertCountSpec({}), /at least one of/);
  });

  it('throws when eq is combined with gte', () => {
    assert.throws(
      () => assertCountSpec({ eq: 3, gte: 1 }),
      /eq cannot be combined with gte\/lte/,
    );
  });

  it('throws when eq is combined with lte', () => {
    assert.throws(
      () => assertCountSpec({ eq: 3, lte: 5 }),
      /eq cannot be combined with gte\/lte/,
    );
  });

  it('accepts gte alone, lte alone, eq alone, and gte+lte range', () => {
    assert.doesNotThrow(() => assertCountSpec({ gte: 1 }));
    assert.doesNotThrow(() => assertCountSpec({ lte: 5 }));
    assert.doesNotThrow(() => assertCountSpec({ eq: 3 }));
    assert.doesNotThrow(() => assertCountSpec({ gte: 1, lte: 5 }));
  });
});
