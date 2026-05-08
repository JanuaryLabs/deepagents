import { InMemoryFs } from 'just-bash';
import assert from 'node:assert';
import { describe, it, mock } from 'node:test';

import {
  ContextEngine,
  InMemoryContextStore,
  XmlRenderer,
  assistantText,
  createBashTool,
  createRoutingSandbox,
  createVirtualSandbox,
  elapsedExceeds,
  reminder,
  user,
} from '@deepagents/context';

import { getTextParts } from '../../../text.ts';

async function createVirtualAgentSandbox() {
  return createBashTool({
    sandbox: await createRoutingSandbox({
      backend: await createVirtualSandbox({ fs: new InMemoryFs() }),
      hostExtensions: [],
    }),
  });
}

async function withFakeTime<T>(
  startIso: string,
  fn: (advance: (ms: number) => void) => Promise<T>,
): Promise<T> {
  mock.timers.enable({ apis: ['Date'] });
  mock.timers.setTime(new Date(startIso).getTime());
  try {
    return await fn((ms) => mock.timers.tick(ms));
  } finally {
    mock.timers.reset();
  }
}

async function lastUserText(engine: ContextEngine): Promise<string> {
  const { messages } = await engine.resolve({
    renderer: new XmlRenderer(),
    sandbox: await createVirtualAgentSandbox(),
  });
  return getTextParts(messages[messages.length - 1]).join('');
}

describe('elapsedExceeds', () => {
  it('fires when elapsed since last user message exceeds threshold', async () => {
    await withFakeTime('2026-05-06T10:00:00Z', async (advance) => {
      const engine = new ContextEngine({
        store: new InMemoryContextStore(),
        chatId: 'elapsed-above',
        userId: 'u1',
      });
      engine.set(user('turn 1'), assistantText('reply'));
      await engine.save();

      advance(60_001);

      engine.set(
        reminder('idle', { when: elapsedExceeds(60_000) }),
        user('turn 2'),
      );
      await engine.save();

      assert.ok((await lastUserText(engine)).includes('idle'));
    });
  });

  it('fires AT the threshold (>= semantics)', async () => {
    await withFakeTime('2026-05-06T10:00:00Z', async (advance) => {
      const engine = new ContextEngine({
        store: new InMemoryContextStore(),
        chatId: 'elapsed-at',
        userId: 'u1',
      });
      engine.set(user('turn 1'), assistantText('reply'));
      await engine.save();

      advance(60_000);

      engine.set(
        reminder('at-threshold', { when: elapsedExceeds(60_000) }),
        user('turn 2'),
      );
      await engine.save();

      assert.ok((await lastUserText(engine)).includes('at-threshold'));
    });
  });

  it('does NOT fire when elapsed is below threshold', async () => {
    await withFakeTime('2026-05-06T10:00:00Z', async (advance) => {
      const engine = new ContextEngine({
        store: new InMemoryContextStore(),
        chatId: 'elapsed-below',
        userId: 'u1',
      });
      engine.set(user('turn 1'), assistantText('reply'));
      await engine.save();

      advance(30_000);

      engine.set(
        reminder('idle', { when: elapsedExceeds(60_000) }),
        user('turn 2'),
      );
      await engine.save();

      assert.ok(!(await lastUserText(engine)).includes('idle'));
    });
  });

  it('does NOT fire on first turn (elapsed undefined)', async () => {
    const engine = new ContextEngine({
      store: new InMemoryContextStore(),
      chatId: 'elapsed-first',
      userId: 'u1',
    });
    engine.set(reminder('idle', { when: elapsedExceeds(1) }), user('first'));
    await engine.save();

    assert.ok(!(await lastUserText(engine)).includes('idle'));
  });
});
