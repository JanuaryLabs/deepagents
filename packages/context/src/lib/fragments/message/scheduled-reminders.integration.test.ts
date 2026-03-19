import type { UIMessage } from 'ai';
import assert from 'node:assert';
import { describe, it } from 'node:test';

import {
  ContextEngine,
  InMemoryContextStore,
  XmlRenderer,
  afterTurn,
  assistantText,
  everyNTurns,
  once,
  reminder,
  user,
} from '@deepagents/context';

function getTextParts(message: UIMessage): string[] {
  return message.parts
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text);
}

describe('ContextEngine scheduled reminders', () => {
  it('applies everyNTurns reminder on matching turn', async () => {
    const store = new InMemoryContextStore();
    const engine = new ContextEngine({
      store,
      chatId: 'scheduled-1',
      userId: 'u1',
    });

    engine.set(user('turn 1'), assistantText('reply 1'));
    await engine.save();

    engine.set(user('turn 2'), assistantText('reply 2'));
    await engine.save();

    engine.set(
      user('turn 3', reminder('every-third', { when: everyNTurns(3) })),
    );

    const { messages } = await engine.resolve({ renderer: new XmlRenderer() });
    const lastMsg = messages[messages.length - 1];
    const text = getTextParts(lastMsg).join('');

    assert.ok(
      text.includes('every-third'),
      `Turn 3: expected reminder to be included. Got: ${text}`,
    );
  });

  it('skips everyNTurns reminder on non-matching turn', async () => {
    const store = new InMemoryContextStore();
    const engine = new ContextEngine({
      store,
      chatId: 'scheduled-2',
      userId: 'u1',
    });

    engine.set(user('turn 1'), assistantText('reply 1'));
    await engine.save();

    engine.set(
      user('turn 2', reminder('every-third', { when: everyNTurns(3) })),
    );

    const { messages } = await engine.resolve({ renderer: new XmlRenderer() });
    const lastMsg = messages[messages.length - 1];
    const text = getTextParts(lastMsg).join('');

    assert.ok(
      !text.includes('every-third'),
      `Turn 2: expected reminder to be skipped. Got: ${text}`,
    );
  });

  it('applies once reminder only on first turn', async () => {
    const store = new InMemoryContextStore();
    const engine = new ContextEngine({
      store,
      chatId: 'scheduled-once',
      userId: 'u1',
    });

    engine.set(user('first message', reminder('welcome', { when: once() })));

    const { messages } = await engine.resolve({ renderer: new XmlRenderer() });
    const lastMsg = messages[messages.length - 1];
    const text = getTextParts(lastMsg).join('');

    assert.ok(
      text.includes('welcome'),
      `Turn 1: expected once reminder. Got: ${text}`,
    );
  });

  it('skips once reminder after first turn', async () => {
    const store = new InMemoryContextStore();
    const engine = new ContextEngine({
      store,
      chatId: 'scheduled-once-skip',
      userId: 'u1',
    });

    engine.set(user('turn 1'), assistantText('reply'));
    await engine.save();

    engine.set(user('turn 2', reminder('welcome', { when: once() })));

    const { messages } = await engine.resolve({ renderer: new XmlRenderer() });
    const lastMsg = messages[messages.length - 1];
    const text = getTextParts(lastMsg).join('');

    assert.ok(
      !text.includes('welcome'),
      `Turn 2: expected once reminder to be skipped. Got: ${text}`,
    );
  });

  it('applies afterTurn reminder only after specified turn', async () => {
    const store = new InMemoryContextStore();
    const engine = new ContextEngine({
      store,
      chatId: 'scheduled-after',
      userId: 'u1',
    });

    engine.set(user('turn 1'), assistantText('reply 1'));
    await engine.save();
    engine.set(user('turn 2'), assistantText('reply 2'));
    await engine.save();

    engine.set(user('turn 3', reminder('late-hint', { when: afterTurn(2) })));

    const { messages } = await engine.resolve({ renderer: new XmlRenderer() });
    const lastMsg = messages[messages.length - 1];
    const text = getTextParts(lastMsg).join('');

    assert.ok(
      text.includes('late-hint'),
      `Turn 3 (afterTurn: 2): expected reminder. Got: ${text}`,
    );
  });

  it('resolves scheduled callback with turn context', async () => {
    const store = new InMemoryContextStore();
    const engine = new ContextEngine({
      store,
      chatId: 'scheduled-callback',
      userId: 'u1',
    });

    engine.set(user('turn 1'), assistantText('reply'));
    await engine.save();

    engine.set(
      user(
        'turn 2',
        reminder((ctx) => `turn=${ctx.turn}`, { when: everyNTurns(2) }),
      ),
    );

    const { messages } = await engine.resolve({ renderer: new XmlRenderer() });
    const lastMsg = messages[messages.length - 1];
    const text = getTextParts(lastMsg).join('');

    assert.ok(
      text.includes('turn=2'),
      `Expected callback to receive turn=2. Got: ${text}`,
    );
  });

  it('getTurnCount counts user messages from persisted and pending', async () => {
    const store = new InMemoryContextStore();
    const engine = new ContextEngine({
      store,
      chatId: 'turn-count',
      userId: 'u1',
    });

    engine.set(user('msg 1'), assistantText('reply 1'));
    await engine.save();

    engine.set(user('msg 2'), assistantText('reply 2'));
    await engine.save();

    engine.set(user('msg 3'));

    const count = await engine.getTurnCount();
    assert.strictEqual(count, 3);
  });

  it('mixes immediate and scheduled reminders in the same message', async () => {
    const store = new InMemoryContextStore();
    const engine = new ContextEngine({
      store,
      chatId: 'mixed-reminders',
      userId: 'u1',
    });

    engine.set(user('turn 1'), assistantText('reply'));
    await engine.save();
    engine.set(user('turn 2'), assistantText('reply'));
    await engine.save();

    engine.set(
      user(
        'turn 3',
        reminder('always-here'),
        reminder('conditional', { when: everyNTurns(3) }),
      ),
    );

    const { messages } = await engine.resolve({ renderer: new XmlRenderer() });
    const lastMsg = messages[messages.length - 1];
    const text = getTextParts(lastMsg).join('');

    assert.ok(
      text.includes('always-here'),
      'Immediate reminder should be present',
    );
    assert.ok(
      text.includes('conditional'),
      'Scheduled reminder should be present on turn 3',
    );
  });

  it('does not persist scheduled reminders after save', async () => {
    const store = new InMemoryContextStore();
    const engine = new ContextEngine({
      store,
      chatId: 'no-persist',
      userId: 'u1',
    });

    engine.set(user('turn 1', reminder('ephemeral', { when: everyNTurns(1) })));
    await engine.save();

    const engine2 = new ContextEngine({
      store,
      chatId: 'no-persist',
      userId: 'u1',
    });

    const { messages } = await engine2.resolve({ renderer: new XmlRenderer() });
    const lastMsg = messages[messages.length - 1];
    const text = getTextParts(lastMsg).join('');

    assert.ok(
      !text.includes('ephemeral'),
      `Scheduled reminders should not persist. Got: ${text}`,
    );
  });

  it('does not mutate original message on resolve (double-resolve safe)', async () => {
    const store = new InMemoryContextStore();
    const engine = new ContextEngine({
      store,
      chatId: 'double-resolve',
      userId: 'u1',
    });

    engine.set(user('hello', reminder('scheduled', { when: everyNTurns(1) })));

    const renderer = new XmlRenderer();
    const result1 = await engine.resolve({ renderer });
    const result2 = await engine.resolve({ renderer });

    const text1 = getTextParts(result1.messages[0]).join('');
    const text2 = getTextParts(result2.messages[0]).join('');

    const count1 = (text1.match(/scheduled/g) || []).length;
    const count2 = (text2.match(/scheduled/g) || []).length;

    assert.strictEqual(count1, 1, 'First resolve should have 1 reminder');
    assert.strictEqual(
      count2,
      1,
      'Second resolve should still have 1 reminder (not doubled)',
    );
  });

  it('does not persist scheduled reminders when resolve is called before save', async () => {
    const store = new InMemoryContextStore();
    const engine = new ContextEngine({
      store,
      chatId: 'resolve-then-save',
      userId: 'u1',
    });

    engine.set(user('hello', reminder('ephemeral', { when: everyNTurns(1) })));

    await engine.resolve({ renderer: new XmlRenderer() });
    await engine.save();

    const engine2 = new ContextEngine({
      store,
      chatId: 'resolve-then-save',
      userId: 'u1',
    });

    const { messages } = await engine2.resolve({ renderer: new XmlRenderer() });
    const lastMsg = messages[messages.length - 1];
    const text = getTextParts(lastMsg).join('');

    assert.ok(
      !text.includes('ephemeral'),
      `Scheduled reminders should not persist even after resolve-then-save. Got: ${text}`,
    );
  });
});
