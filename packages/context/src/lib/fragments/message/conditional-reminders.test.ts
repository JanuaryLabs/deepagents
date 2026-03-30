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
    await engine.save();

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
    await engine.save();

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
    await engine.save();

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
    await engine.save();

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
    await engine.save();

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
    await engine.save();

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
    await engine.save();

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

  it('conditional reminder text is persisted but reminder fragment is not re-evaluated by new engine', async () => {
    const store = new InMemoryContextStore();
    const engine = new ContextEngine({
      store,
      chatId: 'no-persist',
      userId: 'u1',
    });

    engine.set(reminder('baked-in', { when: everyNTurns(1) }), user('turn 1'));
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
      text.includes('baked-in'),
      `Stored message should contain reminder text from original save. Got: ${text}`,
    );
    assert.strictEqual(
      (text.match(/baked-in/g) || []).length,
      1,
      'Reminder text should appear exactly once (not re-applied by engine2)',
    );
  });

  it('double-resolve is safe after save', async () => {
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
    await engine.save();

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

  it('applies multiple conditional reminders in a single save', async () => {
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
    await engine.save();

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
    await engine.save();

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
    await engine.save();

    const { messages } = await engine.resolve({ renderer: new XmlRenderer() });
    const text = getTextParts(messages[0]).join('');

    assert.strictEqual(text, 'hello');
  });

  it('save() persists conditional reminder text and metadata to the stored message', async () => {
    const store = new InMemoryContextStore();
    const engine = new ContextEngine({
      store,
      chatId: 'save-persist',
      userId: 'u1',
    });

    engine.set(
      reminder('persisted-hint', { when: everyNTurns(1) }),
      user('hello'),
    );
    await engine.save();

    const storedMessages = await store.getMessages('save-persist');
    const storedUser = storedMessages.find((m) => m.name === 'user')!;
    const storedData = storedUser.data as UIMessage;

    const text = getTextParts(storedData).join('');
    assert.ok(
      text.includes('persisted-hint'),
      `Stored message should contain reminder text after save(). Got: ${text}`,
    );

    assert.ok(
      Array.isArray(
        (storedData.metadata as Record<string, unknown>)?.reminders,
      ),
      'Stored message should have reminder metadata',
    );
  });

  it('save then resolve does not double-apply reminders', async () => {
    const store = new InMemoryContextStore();
    const engine = new ContextEngine({
      store,
      chatId: 'save-then-resolve',
      userId: 'u1',
    });

    engine.set(reminder('once-only', { when: everyNTurns(1) }), user('hello'));
    await engine.save();

    const { messages } = await engine.resolve({ renderer: new XmlRenderer() });
    const userMsg = messages.find((m) => m.role === 'user')!;
    const text = getTextParts(userMsg).join('');

    assert.strictEqual(
      (text.match(/once-only/g) || []).length,
      1,
      `Reminder should appear exactly once after save+resolve. Got: ${text}`,
    );
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
    await engine.save();

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
    await engine.save();

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
    await engine.save();

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
    await engine.save();

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
    await engine.save();

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

  it('preserves branching-assigned ID when conditional reminders re-create the fragment', async () => {
    const store = new InMemoryContextStore();
    const engine = new ContextEngine({
      store,
      chatId: 'branch-cond',
      userId: 'u1',
    });

    engine.set(user('warmup'), assistantText('ack'));
    await engine.save();

    const original = user('hello');
    const originalId = original.id!;
    engine.set(original, assistantText('reply'));
    await engine.save();

    engine.set(
      reminder('branch-hint', { when: everyNTurns(1) }),
      user({
        id: originalId,
        role: 'user',
        parts: [{ type: 'text', text: 'updated' }],
      }),
    );
    await engine.save();

    const activeBranchMessages = await store.getMessages('branch-cond');
    const branchedUser = activeBranchMessages.find(
      (m) =>
        m.name === 'user' &&
        getTextParts(m.data as UIMessage)
          .join('')
          .includes('updated'),
    );

    assert.ok(
      branchedUser,
      'Updated user message should exist on the new branch',
    );
    assert.notStrictEqual(
      branchedUser!.id,
      originalId,
      'Branched message should have a new ID, not the original',
    );
    assert.ok(
      getTextParts(branchedUser!.data as UIMessage)
        .join('')
        .includes('branch-hint'),
      'Conditional reminder should be applied to the branched message',
    );

    const originalMsg = await store.getMessage(originalId);
    assert.ok(originalMsg, 'Original message should still exist on old branch');
    const originalText = getTextParts(originalMsg!.data as UIMessage).join('');
    assert.ok(
      !originalText.includes('branch-hint'),
      `Original message should be untouched. Got: ${originalText}`,
    );
  });
});
