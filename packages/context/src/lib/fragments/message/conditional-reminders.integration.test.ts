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
  stripReminders,
  user,
} from '@deepagents/context';

function getTextParts(message: UIMessage): string[] {
  return message.parts
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text);
}

describe('ContextEngine conditional reminders', () => {
  it('applies everyNTurns reminder on matching turn', async () => {
    const store = new InMemoryContextStore();
    const engine = new ContextEngine({
      store,
      chatId: 'cond-1',
      userId: 'u1',
    });

    engine.set(user('turn 1'), assistantText('reply 1'));
    await engine.save();

    engine.set(user('turn 2'), assistantText('reply 2'));
    await engine.save();

    engine.set(
      reminder('every-third', { when: everyNTurns(3) }),
      user('turn 3'),
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
      chatId: 'cond-2',
      userId: 'u1',
    });

    engine.set(user('turn 1'), assistantText('reply 1'));
    await engine.save();

    engine.set(
      reminder('every-third', { when: everyNTurns(3) }),
      user('turn 2'),
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
      chatId: 'cond-once',
      userId: 'u1',
    });

    engine.set(reminder('welcome', { when: once() }), user('first message'));

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
      chatId: 'cond-once-skip',
      userId: 'u1',
    });

    engine.set(user('turn 1'), assistantText('reply'));
    await engine.save();

    engine.set(reminder('welcome', { when: once() }), user('turn 2'));

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
      chatId: 'cond-after',
      userId: 'u1',
    });

    engine.set(user('turn 1'), assistantText('reply 1'));
    await engine.save();
    engine.set(user('turn 2'), assistantText('reply 2'));
    await engine.save();

    engine.set(reminder('late-hint', { when: afterTurn(2) }), user('turn 3'));

    const { messages } = await engine.resolve({ renderer: new XmlRenderer() });
    const lastMsg = messages[messages.length - 1];
    const text = getTextParts(lastMsg).join('');

    assert.ok(
      text.includes('late-hint'),
      `Turn 3 (afterTurn: 2): expected reminder. Got: ${text}`,
    );
  });

  it('resolves callback text with turn context', async () => {
    const store = new InMemoryContextStore();
    const engine = new ContextEngine({
      store,
      chatId: 'cond-callback',
      userId: 'u1',
    });

    engine.set(user('turn 1'), assistantText('reply'));
    await engine.save();

    engine.set(
      reminder((ctx) => `turn=${ctx.turn}`, { when: everyNTurns(2) }),
      user('turn 2'),
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

  it('mixes immediate and conditional reminders', async () => {
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
      reminder('conditional', { when: everyNTurns(3) }),
      user('turn 3', reminder('always-here')),
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
      'Conditional reminder should be present on turn 3',
    );
  });

  it('conditional reminders are not persisted (engine-level only)', async () => {
    const store = new InMemoryContextStore();
    const engine = new ContextEngine({
      store,
      chatId: 'no-persist',
      userId: 'u1',
    });

    engine.set(reminder('ephemeral', { when: everyNTurns(1) }), user('turn 1'));
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
      `Conditional reminders should not persist. Got: ${text}`,
    );
  });

  it('does not mutate original message on resolve (double-resolve safe)', async () => {
    const store = new InMemoryContextStore();
    const engine = new ContextEngine({
      store,
      chatId: 'double-resolve',
      userId: 'u1',
    });

    engine.set(
      reminder('conditional', { when: everyNTurns(1) }),
      user('hello'),
    );

    const renderer = new XmlRenderer();
    const result1 = await engine.resolve({ renderer });
    const result2 = await engine.resolve({ renderer });

    const text1 = getTextParts(result1.messages[0]).join('');
    const text2 = getTextParts(result2.messages[0]).join('');

    const count1 = (text1.match(/conditional/g) || []).length;
    const count2 = (text2.match(/conditional/g) || []).length;

    assert.strictEqual(count1, 1, 'First resolve should have 1 reminder');
    assert.strictEqual(
      count2,
      1,
      'Second resolve should still have 1 reminder (not doubled)',
    );
  });

  it('applies conditional reminders to persisted user messages when no pending', async () => {
    const store = new InMemoryContextStore();
    const engine = new ContextEngine({
      store,
      chatId: 'persisted-target',
      userId: 'u1',
    });

    engine.set(user('saved message'), assistantText('reply'));
    await engine.save();

    engine.set(reminder('late-addition', { when: everyNTurns(1) }));

    const { messages } = await engine.resolve({ renderer: new XmlRenderer() });
    const userMsg = messages.find((m) => m.role === 'user')!;
    const text = getTextParts(userMsg).join('');

    assert.ok(
      text.includes('late-addition'),
      `Conditional reminder should apply to persisted user message. Got: ${text}`,
    );
  });

  it('applies multiple conditional reminders in a single resolve', async () => {
    const store = new InMemoryContextStore();
    const engine = new ContextEngine({
      store,
      chatId: 'multi-cond',
      userId: 'u1',
    });

    engine.set(
      reminder('r1', { when: everyNTurns(1) }),
      reminder('r2', { when: everyNTurns(1) }),
      user('hello'),
    );

    const { messages } = await engine.resolve({ renderer: new XmlRenderer() });
    const text = getTextParts(messages[0]).join('');

    assert.ok(text.includes('r1'), `Expected r1 in message. Got: ${text}`);
    assert.ok(text.includes('r2'), `Expected r2 in message. Got: ${text}`);
  });

  it('applies asPart conditional reminder as a separate text part', async () => {
    const store = new InMemoryContextStore();
    const engine = new ContextEngine({
      store,
      chatId: 'cond-aspart',
      userId: 'u1',
    });

    engine.set(
      reminder('part-hint', { when: everyNTurns(1), asPart: true }),
      user('hello'),
    );

    const { messages } = await engine.resolve({ renderer: new XmlRenderer() });
    const parts = getTextParts(messages[0]);

    assert.strictEqual(parts.length, 2, 'Expected 2 text parts');
    assert.strictEqual(parts[0], 'hello');
    assert.strictEqual(parts[1], 'part-hint');
  });

  it('skips conditional reminder when callback returns empty string', async () => {
    const store = new InMemoryContextStore();
    const engine = new ContextEngine({
      store,
      chatId: 'cond-empty-cb',
      userId: 'u1',
    });

    engine.set(
      reminder(() => '', { when: everyNTurns(1) }),
      user('hello'),
    );

    const { messages } = await engine.resolve({ renderer: new XmlRenderer() });
    const text = getTextParts(messages[0]).join('');

    assert.strictEqual(text, 'hello');
  });

  it('does not crash when no user messages exist', async () => {
    const store = new InMemoryContextStore();
    const engine = new ContextEngine({
      store,
      chatId: 'cond-no-user',
      userId: 'u1',
    });

    engine.set(
      reminder('hint', { when: everyNTurns(1) }),
      assistantText('no user here'),
    );

    const { messages } = await engine.resolve({ renderer: new XmlRenderer() });
    assert.strictEqual(messages.length, 1);
    assert.strictEqual(messages[0].role, 'assistant');
  });

  it('conditional reminders do not leak into system prompt', async () => {
    const store = new InMemoryContextStore();
    const engine = new ContextEngine({
      store,
      chatId: 'cond-no-leak',
      userId: 'u1',
    });

    engine.set(
      reminder('secret-hint', { when: everyNTurns(1) }),
      user('hello'),
    );

    const { systemPrompt } = await engine.resolve({
      renderer: new XmlRenderer(),
    });

    assert.ok(
      !systemPrompt.includes('secret-hint'),
      `System prompt should not contain conditional reminder. Got: ${systemPrompt}`,
    );
  });

  it('applies reminder regardless of set() order (reminder after user)', async () => {
    const store = new InMemoryContextStore();
    const engine = new ContextEngine({
      store,
      chatId: 'cond-order',
      userId: 'u1',
    });

    engine.set(user('hello'), reminder('after-user', { when: everyNTurns(1) }));

    const { messages } = await engine.resolve({ renderer: new XmlRenderer() });
    const text = getTextParts(messages[0]).join('');

    assert.ok(
      text.includes('after-user'),
      `Reminder should apply even when set after user. Got: ${text}`,
    );
  });

  it('targets last user message when both persisted and pending exist', async () => {
    const store = new InMemoryContextStore();
    const engine = new ContextEngine({
      store,
      chatId: 'cond-target-last',
      userId: 'u1',
    });

    engine.set(user('persisted-msg'), assistantText('reply'));
    await engine.save();

    engine.set(
      reminder('targeted', { when: everyNTurns(1) }),
      user('pending-msg'),
    );

    const { messages } = await engine.resolve({ renderer: new XmlRenderer() });

    const persistedUser = messages.find(
      (m) =>
        m.role === 'user' &&
        getTextParts(m).some((t) => t.includes('persisted-msg')),
    )!;
    const pendingUser = messages.find(
      (m) =>
        m.role === 'user' &&
        getTextParts(m).some((t) => t.includes('pending-msg')),
    )!;

    const persistedText = getTextParts(persistedUser).join('');
    const pendingText = getTextParts(pendingUser).join('');

    assert.ok(
      !persistedText.includes('targeted'),
      `Persisted user message should NOT have reminder. Got: ${persistedText}`,
    );
    assert.ok(
      pendingText.includes('targeted'),
      `Pending (last) user message should have reminder. Got: ${pendingText}`,
    );
  });

  it('stripReminders works on conditionally-applied reminders', async () => {
    const store = new InMemoryContextStore();
    const engine = new ContextEngine({
      store,
      chatId: 'cond-strip',
      userId: 'u1',
    });

    engine.set(reminder('strippable', { when: everyNTurns(1) }), user('hello'));

    const { messages } = await engine.resolve({ renderer: new XmlRenderer() });
    const userMsg = messages[0];
    const textBefore = getTextParts(userMsg).join('');
    assert.ok(textBefore.includes('strippable'));

    const stripped = stripReminders(userMsg);
    const textAfter = getTextParts(stripped).join('');

    assert.strictEqual(textAfter, 'hello');
    assert.ok(
      !textAfter.includes('strippable'),
      `Stripped message should not contain reminder. Got: ${textAfter}`,
    );
  });
});
