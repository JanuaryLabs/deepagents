import type { UIMessage } from 'ai';
import assert from 'node:assert';
import { describe, it } from 'node:test';

import {
  ContextEngine,
  ENVIRONMENT_REMINDER_METADATA_KEY,
  InMemoryContextStore,
  XmlRenderer,
  assistantText,
  environmentReminder,
  getEnvironmentSnapshot,
  user,
} from '@deepagents/context';

function getTextParts(message: UIMessage): string[] {
  return message.parts
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text);
}

function getLastUserMessage(messages: UIMessage[]): UIMessage {
  const lastUser = [...messages]
    .reverse()
    .find((message) => message.role === 'user');
  assert.ok(lastUser, 'expected a user message');
  return lastUser;
}

describe('environmentReminder', () => {
  it('injects full environmental block on first turn', async () => {
    const store = new InMemoryContextStore();
    const engine = new ContextEngine({ store, chatId: 'env-1', userId: 'u1' });

    const fakeNow = new Date('2026-03-27T14:30:00.000Z');
    engine.set(environmentReminder({ getNow: () => fakeNow }), user('hello'));
    await engine.save();

    const { messages } = await engine.resolve({ renderer: new XmlRenderer() });
    const text = getTextParts(messages[0]).join('');

    assert.ok(text.includes('2026-03-27'), 'should include date');
    assert.ok(text.includes('Friday'), 'should include day of week');
    assert.ok(text.includes('March'), 'should include month');
    assert.ok(text.includes('2026'), 'should include year');
    assert.ok(text.includes('English (US)'), 'should include language');
    assert.ok(text.includes('Spring'), 'should include season');
    assert.ok(text.includes('UTC'), 'should include timezone');
    assert.ok(
      !text.includes('Changes since last environment snapshot'),
      'first turn should not include a change summary',
    );
  });

  it('persists the environment snapshot in user message metadata', async () => {
    const store = new InMemoryContextStore();
    const engine = new ContextEngine({ store, chatId: 'env-2', userId: 'u1' });

    engine.set(
      environmentReminder({
        getNow: () => new Date('2026-03-27T14:30:00.000Z'),
      }),
      user('turn 1'),
    );
    await engine.save();

    const storedMessages = await store.getMessages('env-2');
    const storedUser = storedMessages.find(
      (message) => message.name === 'user',
    );
    assert.ok(storedUser, 'expected a stored user message');

    const storedData = storedUser.data as UIMessage;
    const snapshot = getEnvironmentSnapshot(storedData);

    assert.ok(snapshot, 'expected an environment snapshot in metadata');
    assert.strictEqual(snapshot.timeZone, 'UTC');
    assert.strictEqual(snapshot.language, 'English (US)');
    assert.strictEqual(snapshot.dateKey, '2026-03-27');
    assert.strictEqual(snapshot.dayOfWeek, 'Friday');
    assert.strictEqual(snapshot.month, 'March');
    assert.strictEqual(snapshot.year, 2026);
    assert.strictEqual(snapshot.season, 'Spring');
    assert.strictEqual(
      snapshot.timestamp,
      new Date('2026-03-27T14:30:00.000Z').getTime(),
    );
    assert.ok(
      snapshot.currentDateTime.includes('14:30:00'),
      `expected time in formatted datetime. Got: ${snapshot.currentDateTime}`,
    );
    assert.ok(
      (storedData.metadata as Record<string, unknown>)?.[
        ENVIRONMENT_REMINDER_METADATA_KEY
      ],
      'expected raw metadata entry on the stored user message',
    );
  });

  it('does not include a diff summary when the environment snapshot has not changed', async () => {
    const store = new InMemoryContextStore();
    const engine = new ContextEngine({ store, chatId: 'env-3', userId: 'u1' });

    const fixedNow = new Date('2026-03-27T14:30:00.000Z');
    engine.set(environmentReminder({ getNow: () => fixedNow }), user('turn 1'));
    await engine.save();

    engine.set(assistantText('reply 1'));
    await engine.save();

    engine.set(environmentReminder({ getNow: () => fixedNow }), user('turn 2'));
    await engine.save();

    const { messages } = await engine.resolve({ renderer: new XmlRenderer() });
    const lastUser = getLastUserMessage(messages);
    const text = getTextParts(lastUser).join('');

    assert.ok(
      !text.includes('Changes since last environment snapshot'),
      'same environment should not trigger a diff summary',
    );
  });

  it('describes exact changed fields when the date shifts between user turns', async () => {
    const store = new InMemoryContextStore();
    const engine = new ContextEngine({ store, chatId: 'env-4', userId: 'u1' });

    engine.set(
      environmentReminder({
        getNow: () => new Date('2026-03-27T23:30:00.000Z'),
      }),
      user('turn 1'),
    );
    await engine.save();

    engine.set(assistantText('reply'));
    await engine.save();

    engine.set(
      environmentReminder({
        getNow: () => new Date('2026-03-28T00:30:00.000Z'),
      }),
      user('turn 2'),
    );
    await engine.save();

    const { messages } = await engine.resolve({ renderer: new XmlRenderer() });
    const lastUser = getLastUserMessage(messages);
    const text = getTextParts(lastUser).join('');

    assert.ok(
      text.includes('Changes since last environment snapshot'),
      'should include a diff summary',
    );
    assert.ok(
      text.includes('date: 2026-03-27 -> 2026-03-28'),
      `expected date diff. Got: ${text}`,
    );
    assert.ok(
      text.includes('day of week: Friday -> Saturday'),
      `expected day-of-week diff. Got: ${text}`,
    );
  });

  it('detects diffs from persisted metadata across engine instances', async () => {
    const store = new InMemoryContextStore();

    const engine1 = new ContextEngine({
      store,
      chatId: 'env-cross',
      userId: 'u1',
    });
    engine1.set(
      environmentReminder({
        getNow: () => new Date('2026-03-27T14:30:00.000Z'),
      }),
      user('turn 1'),
    );
    await engine1.save();

    engine1.set(assistantText('reply'));
    await engine1.save();

    const engine2 = new ContextEngine({
      store,
      chatId: 'env-cross',
      userId: 'u1',
    });
    engine2.set(
      environmentReminder({
        getNow: () => new Date('2026-03-28T14:30:00.000Z'),
      }),
      user('turn 2'),
    );
    await engine2.save();

    const { messages } = await engine2.resolve({ renderer: new XmlRenderer() });
    const lastUser = getLastUserMessage(messages);
    const text = getTextParts(lastUser).join('');

    assert.ok(
      text.includes('date: 2026-03-27 -> 2026-03-28'),
      'new engine instance should compare against persisted user metadata',
    );
  });

  it('reports season changes explicitly', async () => {
    const store = new InMemoryContextStore();
    const engine = new ContextEngine({
      store,
      chatId: 'env-season-diff',
      userId: 'u1',
    });

    engine.set(
      environmentReminder({
        getNow: () => new Date('2026-05-31T12:00:00.000Z'),
      }),
      user('turn 1'),
    );
    await engine.save();

    engine.set(assistantText('reply'));
    await engine.save();

    engine.set(
      environmentReminder({
        getNow: () => new Date('2026-06-01T12:00:00.000Z'),
      }),
      user('turn 2'),
    );
    await engine.save();

    const { messages } = await engine.resolve({ renderer: new XmlRenderer() });
    const lastUser = getLastUserMessage(messages);
    const text = getTextParts(lastUser).join('');

    assert.ok(
      text.includes('season: Spring -> Summer'),
      `expected season diff. Got: ${text}`,
    );
  });

  it('computes seasons correctly', async () => {
    const cases: Array<{ date: string; expected: string }> = [
      { date: '2026-01-15T00:00:00.000Z', expected: 'Winter' },
      { date: '2026-04-15T00:00:00.000Z', expected: 'Spring' },
      { date: '2026-07-15T00:00:00.000Z', expected: 'Summer' },
      { date: '2026-10-15T00:00:00.000Z', expected: 'Fall' },
      { date: '2026-12-01T00:00:00.000Z', expected: 'Winter' },
    ];

    for (const { date, expected } of cases) {
      const store = new InMemoryContextStore();
      const engine = new ContextEngine({
        store,
        chatId: `season-${date}`,
        userId: 'u1',
      });

      engine.set(
        environmentReminder({ getNow: () => new Date(date) }),
        user('hello'),
      );
      await engine.save();

      const { messages } = await engine.resolve({
        renderer: new XmlRenderer(),
      });
      const text = getTextParts(messages[0]).join('');

      assert.ok(
        text.includes(expected),
        `${date} should be ${expected}. Got: ${text}`,
      );
    }
  });

  it('is double-resolve safe after save', async () => {
    const store = new InMemoryContextStore();
    const engine = new ContextEngine({
      store,
      chatId: 'env-double',
      userId: 'u1',
    });

    engine.set(
      environmentReminder({
        getNow: () => new Date('2026-06-15T12:00:00.000Z'),
      }),
      user('hello'),
    );
    await engine.save();

    const renderer = new XmlRenderer();
    const result1 = await engine.resolve({ renderer });
    const result2 = await engine.resolve({ renderer });

    const text1 = getTextParts(result1.messages[0]).join('');
    const text2 = getTextParts(result2.messages[0]).join('');

    const count1 = (text1.match(/TimeZone is always in/g) || []).length;
    const count2 = (text2.match(/TimeZone is always in/g) || []).length;

    assert.strictEqual(count1, 1, 'first resolve should have 1 block');
    assert.strictEqual(count2, 1, 'second resolve should still have 1 block');
  });

  it('respects custom language and timezone', async () => {
    const store = new InMemoryContextStore();
    const engine = new ContextEngine({
      store,
      chatId: 'env-custom',
      userId: 'u1',
    });

    engine.set(
      environmentReminder({
        language: 'Arabic (SA)',
        timeZone: 'Asia/Riyadh',
        getNow: () => new Date('2026-03-27T14:00:00.000Z'),
      }),
      user('hello'),
    );
    await engine.save();

    const { messages } = await engine.resolve({ renderer: new XmlRenderer() });
    const text = getTextParts(messages[0]).join('');

    assert.ok(text.includes('Arabic (SA)'), 'should include custom language');
    assert.ok(text.includes('Asia/Riyadh'), 'should include custom timezone');
  });

  it('reports language and timezone changes explicitly', async () => {
    const store = new InMemoryContextStore();
    const engine = new ContextEngine({
      store,
      chatId: 'env-config-diff',
      userId: 'u1',
    });

    engine.set(
      environmentReminder({
        language: 'English (US)',
        timeZone: 'UTC',
        getNow: () => new Date('2026-03-27T14:00:00.000Z'),
      }),
      user('turn 1'),
    );
    await engine.save();

    engine.set(assistantText('reply'));
    await engine.save();

    engine.set(
      environmentReminder({
        language: 'Arabic (SA)',
        timeZone: 'Asia/Riyadh',
        getNow: () => new Date('2026-03-27T14:00:00.000Z'),
      }),
      user('turn 2'),
    );
    await engine.save();

    const { messages } = await engine.resolve({ renderer: new XmlRenderer() });
    const lastUser = getLastUserMessage(messages);
    const text = getTextParts(lastUser).join('');

    assert.ok(
      text.includes('time zone: UTC -> Asia/Riyadh'),
      `expected timezone diff. Got: ${text}`,
    );
    assert.ok(
      text.includes('language: English (US) -> Arabic (SA)'),
      `expected language diff. Got: ${text}`,
    );
  });
});
