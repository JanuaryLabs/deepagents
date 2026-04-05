import type { UIMessage } from 'ai';
import assert from 'node:assert';
import { describe, it, mock } from 'node:test';

import {
  ContextEngine,
  InMemoryContextStore,
  XmlRenderer,
  assistantText,
  dateReminder,
  localeReminder,
  monthReminder,
  seasonReminder,
  temporalReminder,
  timeReminder,
  user,
  yearReminder,
} from '@deepagents/context';

import { getTextParts } from '../../text.ts';

function getLastUserMessage(messages: UIMessage[]): UIMessage {
  const lastUser = [...messages]
    .reverse()
    .find((message) => message.role === 'user');
  assert.ok(lastUser, 'expected a user message');
  return lastUser;
}

async function useFakeTime<T>(
  iso: string,
  fn: () => T | Promise<T>,
): Promise<T> {
  mock.timers.enable({ apis: ['Date'] });
  mock.timers.setTime(new Date(iso).getTime());
  try {
    return await fn();
  } finally {
    mock.timers.reset();
  }
}

describe('dateReminder', () => {
  it('injects date and day of week on first turn', async () => {
    await useFakeTime('2026-03-27T14:30:00.000Z', async () => {
      const store = new InMemoryContextStore();
      const engine = new ContextEngine({
        store,
        chatId: 'date-1',
        userId: 'u1',
      });

      engine.set(dateReminder(), user('hello'));
      await engine.save();

      const { messages } = await engine.resolve({
        renderer: new XmlRenderer(),
      });
      const parts = getTextParts(getLastUserMessage(messages));

      const datePart = parts.find((p) => p.includes('Date:'));
      assert.ok(datePart, 'should have a date part');
      assert.ok(datePart.includes('2026-03-27'), 'should include date');
      assert.ok(datePart.includes('Friday'), 'should include day of week');
      assert.ok(
        !datePart.includes('->'),
        'first turn should not include a diff',
      );
    });
  });

  it('skips when same day', async () => {
    await useFakeTime('2026-03-27T14:00:00.000Z', async () => {
      const store = new InMemoryContextStore();
      const engine = new ContextEngine({
        store,
        chatId: 'date-skip',
        userId: 'u1',
      });

      engine.set(dateReminder(), user('turn 1'));
      await engine.save();

      engine.set(assistantText('reply'));
      await engine.save();

      mock.timers.setTime(new Date('2026-03-27T20:00:00.000Z').getTime());

      engine.set(dateReminder(), user('turn 2'));
      await engine.save();

      const { messages } = await engine.resolve({
        renderer: new XmlRenderer(),
      });
      const lastUser = getLastUserMessage(messages);
      const allText = getTextParts(lastUser).join('');

      assert.ok(
        !allText.includes('Date:'),
        `Same-day should skip date reminder. Got: ${allText}`,
      );
    });
  });

  it('produces diff when day changes', async () => {
    await useFakeTime('2026-03-27T23:30:00.000Z', async () => {
      const store = new InMemoryContextStore();
      const engine = new ContextEngine({
        store,
        chatId: 'date-diff',
        userId: 'u1',
      });

      engine.set(dateReminder(), user('turn 1'));
      await engine.save();

      engine.set(assistantText('reply'));
      await engine.save();

      mock.timers.setTime(new Date('2026-03-28T00:30:00.000Z').getTime());

      engine.set(dateReminder(), user('turn 2'));
      await engine.save();

      const { messages } = await engine.resolve({
        renderer: new XmlRenderer(),
      });
      const lastUser = getLastUserMessage(messages);
      const allText = getTextParts(lastUser).join('');

      assert.ok(
        allText.includes('date: 2026-03-27 -> 2026-03-28'),
        `expected date diff. Got: ${allText}`,
      );
      assert.ok(
        allText.includes('day of week: Friday -> Saturday'),
        `expected day-of-week diff. Got: ${allText}`,
      );
    });
  });

  it('respects custom timezone', async () => {
    await useFakeTime('2026-03-27T16:00:00.000Z', async () => {
      const store = new InMemoryContextStore();
      const engine = new ContextEngine({
        store,
        chatId: 'date-tz',
        userId: 'u1',
      });

      engine.set(dateReminder({ tz: 'Asia/Tokyo' }), user('hello'));
      await engine.save();

      const { messages } = await engine.resolve({
        renderer: new XmlRenderer(),
      });
      const parts = getTextParts(getLastUserMessage(messages));
      const datePart = parts.find((p) => p.includes('Date:'));

      assert.ok(datePart, 'should have a date part');
      assert.ok(
        datePart.includes('2026-03-28'),
        `In Tokyo at UTC 16:00, date should be 2026-03-28. Got: ${datePart}`,
      );
    });
  });
});

describe('timeReminder', () => {
  it('injects time on first turn', async () => {
    await useFakeTime('2026-03-27T14:30:00.000Z', async () => {
      const store = new InMemoryContextStore();
      const engine = new ContextEngine({
        store,
        chatId: 'time-1',
        userId: 'u1',
      });

      engine.set(timeReminder(), user('hello'));
      await engine.save();

      const { messages } = await engine.resolve({
        renderer: new XmlRenderer(),
      });
      const parts = getTextParts(getLastUserMessage(messages));
      const timePart = parts.find((p) => p.includes('Time:'));

      assert.ok(timePart, 'should have a time part');
      assert.ok(timePart.includes('14:30:00'), 'should include time');
    });
  });

  it('skips within the same hour', async () => {
    await useFakeTime('2026-03-27T14:00:00.000Z', async () => {
      const store = new InMemoryContextStore();
      const engine = new ContextEngine({
        store,
        chatId: 'time-skip',
        userId: 'u1',
      });

      engine.set(timeReminder(), user('turn 1'));
      await engine.save();

      engine.set(assistantText('reply'));
      await engine.save();

      mock.timers.setTime(new Date('2026-03-27T14:45:00.000Z').getTime());

      engine.set(timeReminder(), user('turn 2'));
      await engine.save();

      const { messages } = await engine.resolve({
        renderer: new XmlRenderer(),
      });
      const lastUser = getLastUserMessage(messages);
      const allText = getTextParts(lastUser).join('');

      assert.ok(
        !allText.includes('Time:'),
        `Same-hour should skip time reminder. Got: ${allText}`,
      );
    });
  });

  it('produces diff when hour changes', async () => {
    await useFakeTime('2026-03-27T14:55:00.000Z', async () => {
      const store = new InMemoryContextStore();
      const engine = new ContextEngine({
        store,
        chatId: 'time-diff',
        userId: 'u1',
      });

      engine.set(timeReminder(), user('turn 1'));
      await engine.save();

      engine.set(assistantText('reply'));
      await engine.save();

      mock.timers.setTime(new Date('2026-03-27T15:05:00.000Z').getTime());

      engine.set(timeReminder(), user('turn 2'));
      await engine.save();

      const { messages } = await engine.resolve({
        renderer: new XmlRenderer(),
      });
      const lastUser = getLastUserMessage(messages);
      const allText = getTextParts(lastUser).join('');

      assert.ok(
        allText.includes('hour: 14 -> 15'),
        `expected hour diff. Got: ${allText}`,
      );
    });
  });
});

describe('monthReminder', () => {
  it('injects month on first turn', async () => {
    await useFakeTime('2026-03-15T12:00:00.000Z', async () => {
      const store = new InMemoryContextStore();
      const engine = new ContextEngine({
        store,
        chatId: 'month-1',
        userId: 'u1',
      });

      engine.set(monthReminder(), user('hello'));
      await engine.save();

      const { messages } = await engine.resolve({
        renderer: new XmlRenderer(),
      });
      const parts = getTextParts(getLastUserMessage(messages));
      const monthPart = parts.find((p) => p.includes('Month:'));

      assert.ok(monthPart, 'should have a month part');
      assert.ok(monthPart.includes('March'), 'should include month name');
    });
  });

  it('produces diff when month changes', async () => {
    await useFakeTime('2026-03-31T23:55:00.000Z', async () => {
      const store = new InMemoryContextStore();
      const engine = new ContextEngine({
        store,
        chatId: 'month-diff',
        userId: 'u1',
      });

      engine.set(monthReminder(), user('turn 1'));
      await engine.save();

      engine.set(assistantText('reply'));
      await engine.save();

      mock.timers.setTime(new Date('2026-04-01T00:05:00.000Z').getTime());

      engine.set(monthReminder(), user('turn 2'));
      await engine.save();

      const { messages } = await engine.resolve({
        renderer: new XmlRenderer(),
      });
      const lastUser = getLastUserMessage(messages);
      const allText = getTextParts(lastUser).join('');

      assert.ok(
        allText.includes('month: March -> April'),
        `expected month diff. Got: ${allText}`,
      );
    });
  });
});

describe('yearReminder', () => {
  it('injects year on first turn', async () => {
    await useFakeTime('2026-06-15T12:00:00.000Z', async () => {
      const store = new InMemoryContextStore();
      const engine = new ContextEngine({
        store,
        chatId: 'year-1',
        userId: 'u1',
      });

      engine.set(yearReminder(), user('hello'));
      await engine.save();

      const { messages } = await engine.resolve({
        renderer: new XmlRenderer(),
      });
      const parts = getTextParts(getLastUserMessage(messages));
      const yearPart = parts.find((p) => p.includes('Year:'));

      assert.ok(yearPart, 'should have a year part');
      assert.ok(yearPart.includes('2026'), 'should include year');
    });
  });

  it('produces diff when year changes', async () => {
    await useFakeTime('2026-12-31T23:55:00.000Z', async () => {
      const store = new InMemoryContextStore();
      const engine = new ContextEngine({
        store,
        chatId: 'year-diff',
        userId: 'u1',
      });

      engine.set(yearReminder(), user('turn 1'));
      await engine.save();

      engine.set(assistantText('reply'));
      await engine.save();

      mock.timers.setTime(new Date('2027-01-01T00:05:00.000Z').getTime());

      engine.set(yearReminder(), user('turn 2'));
      await engine.save();

      const { messages } = await engine.resolve({
        renderer: new XmlRenderer(),
      });
      const lastUser = getLastUserMessage(messages);
      const allText = getTextParts(lastUser).join('');

      assert.ok(
        allText.includes('year: 2026 -> 2027'),
        `expected year diff. Got: ${allText}`,
      );
    });
  });
});

describe('seasonReminder', () => {
  it('injects season on first turn', async () => {
    await useFakeTime('2026-07-15T12:00:00.000Z', async () => {
      const store = new InMemoryContextStore();
      const engine = new ContextEngine({
        store,
        chatId: 'season-1',
        userId: 'u1',
      });

      engine.set(seasonReminder(), user('hello'));
      await engine.save();

      const { messages } = await engine.resolve({
        renderer: new XmlRenderer(),
      });
      const parts = getTextParts(getLastUserMessage(messages));
      const seasonPart = parts.find((p) => p.includes('Season:'));

      assert.ok(seasonPart, 'should have a season part');
      assert.ok(seasonPart.includes('Summer'), 'should include season');
    });
  });

  it('produces diff when season changes', async () => {
    await useFakeTime('2026-05-31T23:55:00.000Z', async () => {
      const store = new InMemoryContextStore();
      const engine = new ContextEngine({
        store,
        chatId: 'season-diff',
        userId: 'u1',
      });

      engine.set(seasonReminder(), user('turn 1'));
      await engine.save();

      engine.set(assistantText('reply'));
      await engine.save();

      mock.timers.setTime(new Date('2026-06-01T00:05:00.000Z').getTime());

      engine.set(seasonReminder(), user('turn 2'));
      await engine.save();

      const { messages } = await engine.resolve({
        renderer: new XmlRenderer(),
      });
      const lastUser = getLastUserMessage(messages);
      const allText = getTextParts(lastUser).join('');

      assert.ok(
        allText.includes('season: Spring -> Summer'),
        `expected season diff. Got: ${allText}`,
      );
    });
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
      await useFakeTime(date, async () => {
        const store = new InMemoryContextStore();
        const engine = new ContextEngine({
          store,
          chatId: `season-${date}`,
          userId: 'u1',
        });

        engine.set(seasonReminder(), user('hello'));
        await engine.save();

        const { messages } = await engine.resolve({
          renderer: new XmlRenderer(),
        });
        const allText = getTextParts(getLastUserMessage(messages)).join('');

        assert.ok(
          allText.includes(expected),
          `${date} should be ${expected}. Got: ${allText}`,
        );
      });
    }
  });
});

describe('localeReminder', () => {
  it('injects language and timezone on first turn', async () => {
    const store = new InMemoryContextStore();
    const engine = new ContextEngine({
      store,
      chatId: 'locale-1',
      userId: 'u1',
    });

    engine.set(
      localeReminder({ language: 'Arabic (SA)', timeZone: 'Asia/Riyadh' }),
      user('hello'),
    );
    await engine.save();

    const { messages } = await engine.resolve({ renderer: new XmlRenderer() });
    const parts = getTextParts(getLastUserMessage(messages));
    const localePart = parts.find((p) => p.includes('Language:'));

    assert.ok(localePart, 'should have a locale part');
    assert.ok(localePart.includes('Arabic (SA)'), 'should include language');
    assert.ok(localePart.includes('Asia/Riyadh'), 'should include timezone');
    assert.ok(
      !localePart.includes('->'),
      'first turn should not include a diff',
    );
  });

  it('skips when locale has not changed', async () => {
    const store = new InMemoryContextStore();
    const engine = new ContextEngine({
      store,
      chatId: 'locale-skip',
      userId: 'u1',
    });

    engine.set(localeReminder(), user('turn 1'));
    await engine.save();

    engine.set(assistantText('reply'));
    await engine.save();

    engine.set(localeReminder(), user('turn 2'));
    await engine.save();

    const { messages } = await engine.resolve({ renderer: new XmlRenderer() });
    const lastUser = getLastUserMessage(messages);
    const allText = getTextParts(lastUser).join('');

    assert.ok(
      !allText.includes('Language:'),
      `Same locale should skip. Got: ${allText}`,
    );
  });

  it('produces diff when locale changes', async () => {
    const store = new InMemoryContextStore();
    const engine = new ContextEngine({
      store,
      chatId: 'locale-diff',
      userId: 'u1',
    });

    engine.set(
      localeReminder({ language: 'English (US)', timeZone: 'UTC' }),
      user('turn 1'),
    );
    await engine.save();

    engine.set(assistantText('reply'));
    await engine.save();

    engine.set(
      localeReminder({ language: 'Arabic (SA)', timeZone: 'Asia/Riyadh' }),
      user('turn 2'),
    );
    await engine.save();

    const { messages } = await engine.resolve({ renderer: new XmlRenderer() });
    const lastUser = getLastUserMessage(messages);
    const allText = getTextParts(lastUser).join('');

    assert.ok(
      allText.includes('language: English (US) -> Arabic (SA)'),
      `expected language diff. Got: ${allText}`,
    );
    assert.ok(
      allText.includes('timezone: UTC -> Asia/Riyadh'),
      `expected timezone diff. Got: ${allText}`,
    );
  });

  it('persists locale in metadata for cross-turn comparison', async () => {
    const store = new InMemoryContextStore();
    const engine = new ContextEngine({
      store,
      chatId: 'locale-meta',
      userId: 'u1',
    });

    engine.set(
      localeReminder({ language: 'French', timeZone: 'Europe/Paris' }),
      user('bonjour'),
    );
    await engine.save();

    const storedMessages = await store.getMessages('locale-meta');
    const storedUser = storedMessages.find((m) => m.name === 'user');
    assert.ok(storedUser, 'expected a stored user message');

    const metadata = (storedUser.data as UIMessage).metadata as
      | Record<string, unknown>
      | undefined;
    const locale = metadata?.locale as
      | { language: string; timeZone: string }
      | undefined;

    assert.ok(locale, 'expected locale metadata');
    assert.strictEqual(locale.language, 'French');
    assert.strictEqual(locale.timeZone, 'Europe/Paris');
  });

  it('diffs across engine instances', async () => {
    const store = new InMemoryContextStore();

    const engine1 = new ContextEngine({
      store,
      chatId: 'locale-cross',
      userId: 'u1',
    });
    engine1.set(
      localeReminder({ language: 'English (US)', timeZone: 'UTC' }),
      user('turn 1'),
    );
    await engine1.save();

    engine1.set(assistantText('reply'));
    await engine1.save();

    const engine2 = new ContextEngine({
      store,
      chatId: 'locale-cross',
      userId: 'u1',
    });
    engine2.set(
      localeReminder({ language: 'Arabic (SA)', timeZone: 'Asia/Riyadh' }),
      user('turn 2'),
    );
    await engine2.save();

    const { messages } = await engine2.resolve({ renderer: new XmlRenderer() });
    const lastUser = getLastUserMessage(messages);
    const allText = getTextParts(lastUser).join('');

    assert.ok(
      allText.includes('language: English (US) -> Arabic (SA)'),
      `new engine instance should produce locale diff. Got: ${allText}`,
    );
    assert.ok(
      allText.includes('timezone: UTC -> Asia/Riyadh'),
      `new engine instance should produce timezone diff. Got: ${allText}`,
    );
  });
});

describe('temporalReminder', () => {
  it('returns an array of 5 temporal atom fragments', () => {
    const fragments = temporalReminder();
    assert.ok(Array.isArray(fragments), 'should return an array');
    assert.strictEqual(fragments.length, 5, 'should have 5 temporal atoms');
  });

  it('injects all temporal data on first turn', async () => {
    await useFakeTime('2026-03-27T14:30:00.000Z', async () => {
      const store = new InMemoryContextStore();
      const engine = new ContextEngine({
        store,
        chatId: 'temp-all',
        userId: 'u1',
      });

      engine.set(...temporalReminder(), user('hello'));
      await engine.save();

      const { messages } = await engine.resolve({
        renderer: new XmlRenderer(),
      });
      const allText = getTextParts(getLastUserMessage(messages)).join(' ');

      assert.ok(allText.includes('2026-03-27'), 'should include date');
      assert.ok(allText.includes('Friday'), 'should include day');
      assert.ok(allText.includes('14:30:00'), 'should include time');
      assert.ok(allText.includes('March'), 'should include month');
      assert.ok(allText.includes('2026'), 'should include year');
      assert.ok(allText.includes('Spring'), 'should include season');
      assert.ok(
        !allText.includes('Language:'),
        'should not include locale (not part of temporalReminder)',
      );
    });
  });

  it('each atom fires independently on its own schedule', async () => {
    await useFakeTime('2026-03-27T14:00:00.000Z', async () => {
      const store = new InMemoryContextStore();
      const engine = new ContextEngine({
        store,
        chatId: 'temp-independent',
        userId: 'u1',
      });

      engine.set(...temporalReminder(), user('turn 1'));
      await engine.save();

      engine.set(assistantText('reply'));
      await engine.save();

      mock.timers.setTime(new Date('2026-03-27T15:30:00.000Z').getTime());

      engine.set(...temporalReminder(), user('turn 2'));
      await engine.save();

      const { messages } = await engine.resolve({
        renderer: new XmlRenderer(),
      });
      const lastUser = getLastUserMessage(messages);
      const allText = getTextParts(lastUser).join(' ');

      assert.ok(
        allText.includes('Time:'),
        'hour changed, timeReminder should fire',
      );
      assert.ok(
        !allText.includes('Date:'),
        'same day, dateReminder should not fire',
      );
      assert.ok(
        !allText.includes('Month:'),
        'same month, monthReminder should not fire',
      );
    });
  });

  it('passes custom timezone to all atoms', async () => {
    await useFakeTime('2026-03-27T16:00:00.000Z', async () => {
      const store = new InMemoryContextStore();
      const engine = new ContextEngine({
        store,
        chatId: 'temp-tz',
        userId: 'u1',
      });

      engine.set(
        ...temporalReminder({ tz: 'Asia/Tokyo' }),
        localeReminder({ language: 'Japanese', timeZone: 'Asia/Tokyo' }),
        user('hello'),
      );
      await engine.save();

      const { messages } = await engine.resolve({
        renderer: new XmlRenderer(),
      });
      const allText = getTextParts(getLastUserMessage(messages)).join(' ');

      assert.ok(
        allText.includes('2026-03-28'),
        `In Tokyo at UTC 16:00, date should be 2026-03-28. Got: ${allText}`,
      );
      assert.ok(allText.includes('Japanese'), 'should include custom language');
      assert.ok(
        allText.includes('Asia/Tokyo'),
        'should include custom timezone',
      );
    });
  });

  it('each atom adds a separate text part (asPart)', async () => {
    await useFakeTime('2026-03-27T14:30:00.000Z', async () => {
      const store = new InMemoryContextStore();
      const engine = new ContextEngine({
        store,
        chatId: 'temp-parts',
        userId: 'u1',
      });

      engine.set(...temporalReminder(), user('hello'));
      await engine.save();

      const { messages } = await engine.resolve({
        renderer: new XmlRenderer(),
      });
      const parts = getTextParts(getLastUserMessage(messages));

      assert.ok(
        parts.length > 1,
        `Expected multiple parts from atom reminders. Got ${parts.length} part(s)`,
      );
      assert.strictEqual(parts[0], 'hello', 'first part should be user text');
    });
  });

  it('diffs across engine instances', async () => {
    await useFakeTime('2026-03-27T14:30:00.000Z', async () => {
      const store = new InMemoryContextStore();

      const engine1 = new ContextEngine({
        store,
        chatId: 'temp-cross',
        userId: 'u1',
      });
      engine1.set(...temporalReminder(), user('turn 1'));
      await engine1.save();

      engine1.set(assistantText('reply'));
      await engine1.save();

      mock.timers.setTime(new Date('2026-03-28T14:30:00.000Z').getTime());

      const engine2 = new ContextEngine({
        store,
        chatId: 'temp-cross',
        userId: 'u1',
      });
      engine2.set(...temporalReminder(), user('turn 2'));
      await engine2.save();

      const { messages } = await engine2.resolve({
        renderer: new XmlRenderer(),
      });
      const lastUser = getLastUserMessage(messages);
      const allText = getTextParts(lastUser).join(' ');

      assert.ok(
        allText.includes('date: 2026-03-27 -> 2026-03-28'),
        `new engine instance should produce diff. Got: ${allText}`,
      );
    });
  });

  it('is double-resolve safe after save', async () => {
    await useFakeTime('2026-06-15T12:00:00.000Z', async () => {
      const store = new InMemoryContextStore();
      const engine = new ContextEngine({
        store,
        chatId: 'temp-double',
        userId: 'u1',
      });

      engine.set(...temporalReminder(), user('hello'));
      await engine.save();

      const renderer = new XmlRenderer();
      const result1 = await engine.resolve({ renderer });
      const result2 = await engine.resolve({ renderer });

      const text1 = getTextParts(getLastUserMessage(result1.messages)).join('');
      const text2 = getTextParts(getLastUserMessage(result2.messages)).join('');

      const count1 = (text1.match(/Date:/g) || []).length;
      const count2 = (text2.match(/Date:/g) || []).length;

      assert.strictEqual(count1, 1, 'first resolve should have 1 date block');
      assert.strictEqual(
        count2,
        1,
        'second resolve should still have 1 date block',
      );
    });
  });
});
