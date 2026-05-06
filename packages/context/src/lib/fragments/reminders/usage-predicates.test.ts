import type { LanguageModelUsage } from 'ai';
import assert from 'node:assert';
import { describe, it } from 'node:test';

import {
  ContextEngine,
  InMemoryContextStore,
  XmlRenderer,
  assistantText,
  reminder,
  usageExceeds,
  user,
} from '@deepagents/context';

import { getTextParts } from '../../text.ts';

function usage(input: number, output: number): LanguageModelUsage {
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: input + output,
    inputTokenDetails: {
      noCacheTokens: undefined,
      cacheReadTokens: undefined,
      cacheWriteTokens: undefined,
    },
    outputTokenDetails: {
      textTokens: undefined,
      reasoningTokens: undefined,
    },
  };
}

async function lastUserText(engine: ContextEngine): Promise<string> {
  const { messages } = await engine.resolve({ renderer: new XmlRenderer() });
  return getTextParts(messages[messages.length - 1]).join('');
}

describe('usageExceeds', () => {
  it('fires when totalTokens is above threshold', async () => {
    const engine = new ContextEngine({
      store: new InMemoryContextStore(),
      chatId: 'usage-above',
      userId: 'u1',
    });
    engine.set(user('turn 1'), assistantText('reply'));
    await engine.save();

    await engine.trackUsage(usage(6000, 4001));

    engine.set(
      reminder('over-budget', { when: usageExceeds(10_000) }),
      user('turn 2'),
    );
    await engine.save();

    assert.ok((await lastUserText(engine)).includes('over-budget'));
  });

  it('fires AT the threshold (>= semantics)', async () => {
    const engine = new ContextEngine({
      store: new InMemoryContextStore(),
      chatId: 'usage-at',
      userId: 'u1',
    });
    engine.set(user('turn 1'), assistantText('reply'));
    await engine.save();

    await engine.trackUsage(usage(6000, 4000));

    engine.set(
      reminder('at-threshold', { when: usageExceeds(10_000) }),
      user('turn 2'),
    );
    await engine.save();

    assert.ok((await lastUserText(engine)).includes('at-threshold'));
  });

  it('does NOT fire when below threshold', async () => {
    const engine = new ContextEngine({
      store: new InMemoryContextStore(),
      chatId: 'usage-below',
      userId: 'u1',
    });
    engine.set(user('turn 1'), assistantText('reply'));
    await engine.save();

    await engine.trackUsage(usage(5000, 4000));

    engine.set(
      reminder('over-budget', { when: usageExceeds(10_000) }),
      user('turn 2'),
    );
    await engine.save();

    assert.ok(!(await lastUserText(engine)).includes('over-budget'));
  });

  it('does NOT fire when usage is undefined (no trackUsage call)', async () => {
    const engine = new ContextEngine({
      store: new InMemoryContextStore(),
      chatId: 'usage-none',
      userId: 'u1',
    });
    engine.set(user('turn 1'), assistantText('reply'));
    await engine.save();

    engine.set(
      reminder('over-budget', { when: usageExceeds(1) }),
      user('turn 2'),
    );
    await engine.save();

    assert.ok(!(await lastUserText(engine)).includes('over-budget'));
  });
});
