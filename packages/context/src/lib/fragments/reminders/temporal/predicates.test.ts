import type { UIMessage } from 'ai';
import assert from 'node:assert';
import { describe, it, mock } from 'node:test';

import {
  type WhenContext,
  afterTurn,
  and,
  dayChanged,
  hourChanged,
  monthChanged,
  not,
  seasonChanged,
  weekChanged,
  yearChanged,
} from '@deepagents/context';

function wctx(
  partial: Partial<WhenContext> & { turn: number; content: string },
): WhenContext {
  return {
    branch: 'main',
    chat: { id: 'test-chat', userId: 'test-user', createdAt: 0, updatedAt: 0 },
    messageCount: 0,
    currentMessage: {
      id: 'test-msg',
      role: 'user',
      parts: [{ type: 'text', text: partial.content }],
    },
    ...partial,
  };
}

function useFakeTime<T>(iso: string, fn: () => T): T {
  mock.timers.enable({ apis: ['Date'] });
  mock.timers.setTime(new Date(iso).getTime());
  let result: T;
  try {
    result = fn();
  } catch (e) {
    mock.timers.reset();
    throw e;
  }
  if (result instanceof Promise) {
    return result.finally(() => mock.timers.reset()) as T;
  }
  mock.timers.reset();
  return result;
}

describe('dayChanged', () => {
  it('fires on first turn when lastMessageAt is undefined', () => {
    useFakeTime('2026-03-27T12:00:00Z', () => {
      assert.strictEqual(dayChanged()(wctx({ turn: 1, content: '' })), true);
    });
  });

  it('does not fire when still the same day', () => {
    useFakeTime('2026-03-27T23:00:00Z', () => {
      assert.strictEqual(
        dayChanged()(
          wctx({
            turn: 2,
            content: '',
            lastMessageAt: new Date('2026-03-27T12:00:00Z').getTime(),
          }),
        ),
        false,
      );
    });
  });

  it('fires when the day has changed', () => {
    useFakeTime('2026-03-28T01:00:00Z', () => {
      assert.strictEqual(
        dayChanged()(
          wctx({
            turn: 2,
            content: '',
            lastMessageAt: new Date('2026-03-27T23:00:00Z').getTime(),
          }),
        ),
        true,
      );
    });
  });

  it('respects timezone for day boundary', () => {
    useFakeTime('2026-03-27T16:00:00Z', () => {
      assert.strictEqual(
        dayChanged({ tz: 'Asia/Tokyo' })(
          wctx({
            turn: 2,
            content: '',
            lastMessageAt: new Date('2026-03-27T14:00:00Z').getTime(),
          }),
        ),
        true,
        'In Tokyo: now=2026-03-28 01:00, prev=2026-03-27 23:00 => day changed',
      );
    });
  });
});

describe('hourChanged', () => {
  it('fires on first turn', () => {
    useFakeTime('2026-03-27T12:00:00Z', () => {
      assert.strictEqual(hourChanged()(wctx({ turn: 1, content: '' })), true);
    });
  });

  it('does not fire within the same hour', () => {
    useFakeTime('2026-03-27T12:45:00Z', () => {
      assert.strictEqual(
        hourChanged()(
          wctx({
            turn: 2,
            content: '',
            lastMessageAt: new Date('2026-03-27T12:10:00Z').getTime(),
          }),
        ),
        false,
      );
    });
  });

  it('fires when the hour has changed', () => {
    useFakeTime('2026-03-27T13:05:00Z', () => {
      assert.strictEqual(
        hourChanged()(
          wctx({
            turn: 2,
            content: '',
            lastMessageAt: new Date('2026-03-27T12:55:00Z').getTime(),
          }),
        ),
        true,
      );
    });
  });
});

describe('monthChanged', () => {
  it('fires on first turn', () => {
    useFakeTime('2026-03-15T12:00:00Z', () => {
      assert.strictEqual(monthChanged()(wctx({ turn: 1, content: '' })), true);
    });
  });

  it('does not fire within the same month', () => {
    useFakeTime('2026-03-28T12:00:00Z', () => {
      assert.strictEqual(
        monthChanged()(
          wctx({
            turn: 2,
            content: '',
            lastMessageAt: new Date('2026-03-01T12:00:00Z').getTime(),
          }),
        ),
        false,
      );
    });
  });

  it('fires when the month has changed', () => {
    useFakeTime('2026-04-01T00:05:00Z', () => {
      assert.strictEqual(
        monthChanged()(
          wctx({
            turn: 2,
            content: '',
            lastMessageAt: new Date('2026-03-31T23:55:00Z').getTime(),
          }),
        ),
        true,
      );
    });
  });
});

describe('yearChanged', () => {
  it('fires on first turn', () => {
    useFakeTime('2026-06-15T12:00:00Z', () => {
      assert.strictEqual(yearChanged()(wctx({ turn: 1, content: '' })), true);
    });
  });

  it('does not fire within the same year', () => {
    useFakeTime('2026-12-31T12:00:00Z', () => {
      assert.strictEqual(
        yearChanged()(
          wctx({
            turn: 2,
            content: '',
            lastMessageAt: new Date('2026-01-01T12:00:00Z').getTime(),
          }),
        ),
        false,
      );
    });
  });

  it('fires when the year has changed', () => {
    useFakeTime('2027-01-01T00:05:00Z', () => {
      assert.strictEqual(
        yearChanged()(
          wctx({
            turn: 2,
            content: '',
            lastMessageAt: new Date('2026-12-31T23:55:00Z').getTime(),
          }),
        ),
        true,
      );
    });
  });
});

describe('seasonChanged', () => {
  it('fires on first turn', () => {
    useFakeTime('2026-06-15T12:00:00Z', () => {
      assert.strictEqual(seasonChanged()(wctx({ turn: 1, content: '' })), true);
    });
  });

  it('does not fire within the same season', () => {
    useFakeTime('2026-07-15T12:00:00Z', () => {
      assert.strictEqual(
        seasonChanged()(
          wctx({
            turn: 2,
            content: '',
            lastMessageAt: new Date('2026-06-15T12:00:00Z').getTime(),
          }),
        ),
        false,
        'June and July are both Summer',
      );
    });
  });

  it('fires when the season changes (Spring -> Summer)', () => {
    useFakeTime('2026-06-01T12:00:00Z', () => {
      assert.strictEqual(
        seasonChanged()(
          wctx({
            turn: 2,
            content: '',
            lastMessageAt: new Date('2026-05-31T12:00:00Z').getTime(),
          }),
        ),
        true,
        'May is Spring, June is Summer',
      );
    });
  });
});

describe('weekChanged', () => {
  it('fires on first turn', () => {
    useFakeTime('2026-03-25T12:00:00Z', () => {
      assert.strictEqual(weekChanged()(wctx({ turn: 1, content: '' })), true);
    });
  });

  it('does not fire within the same week', () => {
    useFakeTime('2026-03-26T12:00:00Z', () => {
      assert.strictEqual(
        weekChanged()(
          wctx({
            turn: 2,
            content: '',
            lastMessageAt: new Date('2026-03-24T12:00:00Z').getTime(),
          }),
        ),
        false,
        'Tue Mar 24 and Thu Mar 26 are same ISO week',
      );
    });
  });

  it('fires when the week changes', () => {
    useFakeTime('2026-04-06T12:00:00Z', () => {
      assert.strictEqual(
        weekChanged()(
          wctx({
            turn: 2,
            content: '',
            lastMessageAt: new Date('2026-03-27T12:00:00Z').getTime(),
          }),
        ),
        true,
        'Mar 27 (Fri) and Apr 6 (Mon) are different ISO weeks',
      );
    });
  });
});

describe('temporal predicate composition', () => {
  it('composes dayChanged with afterTurn', async () => {
    await useFakeTime('2026-03-28T12:00:00Z', async () => {
      const pred = and(dayChanged(), afterTurn(3));

      assert.strictEqual(
        await pred(
          wctx({
            turn: 2,
            content: '',
            lastMessageAt: new Date('2026-03-27T12:00:00Z').getTime(),
          }),
        ),
        false,
        'turn 2 + day changed => false (afterTurn(3) fails)',
      );

      assert.strictEqual(
        await pred(
          wctx({
            turn: 4,
            content: '',
            lastMessageAt: new Date('2026-03-27T12:00:00Z').getTime(),
          }),
        ),
        true,
        'turn 4 + day changed => true',
      );
    });
  });

  it('composes hourChanged with not()', async () => {
    await useFakeTime('2026-03-27T13:05:00Z', async () => {
      const pred = not(hourChanged());

      assert.strictEqual(
        await pred(
          wctx({
            turn: 2,
            content: '',
            lastMessageAt: new Date('2026-03-27T12:55:00Z').getTime(),
          }),
        ),
        false,
        'hour changed => not() inverts to false',
      );
    });
  });
});

function messageWithLocale(metadata: Record<string, unknown>): UIMessage {
  return {
    id: 'prev',
    role: 'user',
    parts: [{ type: 'text', text: 'turn 1' }],
    metadata,
  };
}

const JAPANESE_TOKYO = { language: 'Japanese', timeZone: 'Asia/Tokyo' };

function inTokyoCrossingWindow(
  lastMessage: UIMessage,
  fn: (ctx: WhenContext) => void,
): void {
  useFakeTime('2026-03-27T16:00:00Z', () => {
    fn(
      wctx({
        turn: 2,
        content: '',
        lastMessageAt: new Date('2026-03-27T14:00:00Z').getTime(),
        lastMessage,
      }),
    );
  });
}

describe('predicate metadata-fallback', () => {
  it('dayChanged() honors locale metadata when no options provided', () => {
    inTokyoCrossingWindow(
      messageWithLocale({ locale: JAPANESE_TOKYO }),
      (ctx) => {
        assert.strictEqual(
          dayChanged()(ctx),
          true,
          'Tokyo crosses midnight (UTC 14:00 = Tokyo 23:00 -> UTC 16:00 = Tokyo 01:00 next day) while UTC stays on 2026-03-27. A UTC-using predicate would return false.',
        );
      },
    );
  });

  it('dayChanged({ tz }) overrides locale metadata when both are present', () => {
    useFakeTime('2026-03-28T06:00:00Z', () => {
      const lastMessage = messageWithLocale({ locale: JAPANESE_TOKYO });

      assert.strictEqual(
        dayChanged({ tz: 'America/New_York' })(
          wctx({
            turn: 2,
            content: '',
            lastMessageAt: new Date('2026-03-28T03:00:00Z').getTime(),
            lastMessage,
          }),
        ),
        true,
        'NYC crosses midnight (UTC 03:00 = NYC 23:00 prev day -> UTC 06:00 = NYC 02:00) while Tokyo (12:00 -> 15:00) and UTC (both 03-28) stay on the same day. If options.tz did not override metadata, predicate would use Tokyo and return false.',
      );
    });
  });

  it('hourChanged() honors locale metadata (proves wiring is shared across predicates)', () => {
    useFakeTime('2026-03-27T15:00:00Z', () => {
      const lastMessage = messageWithLocale({
        locale: { language: 'Hindi', timeZone: 'Asia/Kolkata' },
      });

      assert.strictEqual(
        hourChanged()(
          wctx({
            turn: 2,
            content: '',
            lastMessageAt: new Date('2026-03-27T14:30:00Z').getTime(),
            lastMessage,
          }),
        ),
        false,
        'Kolkata is UTC+5:30 (half-hour offset). UTC hour 14 -> 15 (changed) but Kolkata hour 20 -> 20 (same). A UTC-using predicate would return true; metadata-aware predicate must return false.',
      );
    });
  });

  it('empty-string tz falls through to metadata', () => {
    inTokyoCrossingWindow(
      messageWithLocale({ locale: JAPANESE_TOKYO }),
      (ctx) => {
        assert.strictEqual(
          dayChanged({ tz: '' })(ctx),
          true,
          'Empty-string tz is falsy under `if (options?.tz)` so resolveTz should fall through to metadata. Same Tokyo-crosses-midnight setup as the no-options test.',
        );
      },
    );
  });

  it('invalid locale metadata shape falls back to UTC', () => {
    inTokyoCrossingWindow(
      messageWithLocale({ locale: { language: 'Japanese' } }),
      (ctx) => {
        assert.strictEqual(
          dayChanged()(ctx),
          false,
          'metadata.locale missing timeZone => getLocaleFromMessage returns null => resolveTz falls back to UTC. UTC stays on 2026-03-27 across the window, so predicate must not fire.',
        );
      },
    );
  });
});
