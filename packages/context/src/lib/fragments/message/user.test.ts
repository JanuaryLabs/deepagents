import type { UIMessage } from 'ai';
import assert from 'node:assert';
import { describe, it, mock } from 'node:test';

import {
  afterTurn,
  and,
  dayChanged,
  everyNTurns,
  firstN,
  getReminderRanges,
  hourChanged,
  isConditionalReminder,
  monthChanged,
  not,
  once,
  or,
  reminder,
  seasonChanged,
  stripReminders,
  stripTextByRanges,
  user,
  weekChanged,
  yearChanged,
} from '@deepagents/context';

type UserReminderMetadataRecord = {
  id: string;
  text: string;
  partIndex: number;
  start: number;
  end: number;
  mode: 'inline' | 'part';
};

function encodeMessage(fragment: ReturnType<typeof user>): UIMessage {
  const message = fragment.codec?.encode();
  assert.ok(message, 'Expected user fragment to have an encodable message');
  return message as UIMessage;
}

function getReminderMetadata(message: UIMessage): UserReminderMetadataRecord[] {
  const metadata = message.metadata as
    | { reminders?: UserReminderMetadataRecord[] }
    | undefined;
  return metadata?.reminders ?? [];
}

function getTextPart(message: UIMessage, index = 0): string {
  const part = message.parts[index];
  assert.ok(part, `Expected message part at index ${index}`);
  assert.strictEqual(part.type, 'text');
  return part.text;
}

function taggedReminder(text: string) {
  return `<system-reminder>${text}</system-reminder>`;
}

describe('user reminders', () => {
  it('adds inline tagged reminder metadata with expected ranges', () => {
    const fragment = user('hello', reminder('keep responses concise'));
    const message = encodeMessage(fragment);

    const encodedReminder = taggedReminder('keep responses concise');
    assert.strictEqual(message.role, 'user');
    assert.strictEqual(getTextPart(message), `hello${encodedReminder}`);

    const metadata = getReminderMetadata(message);
    assert.strictEqual(metadata.length, 1);

    const reminderMeta = metadata[0];
    assert.ok(reminderMeta.id, 'Reminder metadata should include an id');
    assert.deepStrictEqual(
      {
        text: reminderMeta.text,
        partIndex: reminderMeta.partIndex,
        start: reminderMeta.start,
        end: reminderMeta.end,
        mode: reminderMeta.mode,
      },
      {
        text: 'keep responses concise',
        partIndex: 0,
        start: 5,
        end: 5 + encodedReminder.length,
        mode: 'inline',
      },
    );
  });

  it('applies multiple inline reminders in call order with append-only ranges', () => {
    const fragment = user(
      'x',
      reminder('first'),
      reminder('second'),
      reminder('third'),
    );
    const message = encodeMessage(fragment);

    const first = taggedReminder('first');
    const second = taggedReminder('second');
    const third = taggedReminder('third');
    assert.strictEqual(getTextPart(message), `x${first}${second}${third}`);

    const metadata = getReminderMetadata(message);
    assert.strictEqual(metadata.length, 3);
    assert.deepStrictEqual(
      metadata.map(({ text, partIndex, start, end, mode }) => ({
        text,
        partIndex,
        start,
        end,
        mode,
      })),
      [
        {
          text: 'first',
          partIndex: 0,
          start: 1,
          end: 1 + first.length,
          mode: 'inline',
        },
        {
          text: 'second',
          partIndex: 0,
          start: 1 + first.length,
          end: 1 + first.length + second.length,
          mode: 'inline',
        },
        {
          text: 'third',
          partIndex: 0,
          start: 1 + first.length + second.length,
          end: 1 + first.length + second.length + third.length,
          mode: 'inline',
        },
      ],
    );
  });

  it('supports asPart reminders and records part index ranges', () => {
    const fragment = user(
      'body',
      reminder('before', { asPart: true }),
      reminder('after', { asPart: true }),
    );
    const message = encodeMessage(fragment);

    assert.deepStrictEqual(
      message.parts.map((part) =>
        part.type === 'text' ? part.text : part.type,
      ),
      ['body', 'before', 'after'],
    );

    const metadata = getReminderMetadata(message);
    assert.strictEqual(metadata.length, 2);
    assert.deepStrictEqual(
      metadata.map(({ text, partIndex, start, end, mode }) => ({
        text,
        partIndex,
        start,
        end,
        mode,
      })),
      [
        {
          text: 'before',
          partIndex: 1,
          start: 0,
          end: 'before'.length,
          mode: 'part',
        },
        {
          text: 'after',
          partIndex: 2,
          start: 0,
          end: 'after'.length,
          mode: 'part',
        },
      ],
    );
  });

  it('appends inline reminders to the last text part in multi-part messages', () => {
    const fragment = user(
      {
        id: 'multi-text',
        role: 'user',
        parts: [
          { type: 'text', text: 'first' },
          { type: 'text', text: 'second' },
        ],
      },
      reminder('only-last-part'),
    );
    const message = encodeMessage(fragment);
    const encodedReminder = taggedReminder('only-last-part');

    assert.strictEqual(getTextPart(message, 0), 'first');
    assert.strictEqual(getTextPart(message, 1), `second${encodedReminder}`);

    const metadata = getReminderMetadata(message);
    assert.strictEqual(metadata.length, 1);
    assert.deepStrictEqual(
      {
        partIndex: metadata[0].partIndex,
        start: metadata[0].start,
        end: metadata[0].end,
        mode: metadata[0].mode,
      },
      {
        partIndex: 1,
        start: 'second'.length,
        end: 'second'.length + encodedReminder.length,
        mode: 'inline',
      },
    );
  });

  it('merges reminder metadata with existing metadata and keeps user role', () => {
    const existingReminder = {
      id: 'existing-reminder',
      text: 'existing',
      partIndex: 0,
      start: 0,
      end: 8,
      mode: 'part' as const,
    };

    const fragment = user(
      {
        id: 'msg-with-metadata',
        role: 'assistant',
        metadata: {
          source: 'seed',
          reminders: [existingReminder],
        },
        parts: [{ type: 'text', text: 'payload' }],
      } as unknown as UIMessage & { role: 'user' },
      reminder('new-reminder'),
    );
    const message = encodeMessage(fragment);
    const metadata = message.metadata as
      | {
          source?: string;
          reminders?: UserReminderMetadataRecord[];
        }
      | undefined;

    assert.strictEqual(message.id, 'msg-with-metadata');
    assert.strictEqual(message.role, 'user');
    assert.deepStrictEqual(
      {
        source: metadata?.source,
        existingReminder: metadata?.reminders?.[0],
        reminderCount: metadata?.reminders?.length,
      },
      {
        source: 'seed',
        existingReminder,
        reminderCount: 2,
      },
    );

    const appendedReminder = metadata?.reminders?.[1];
    assert.ok(appendedReminder?.id, 'Appended reminder should include id');
    assert.deepStrictEqual(
      {
        text: appendedReminder?.text,
        partIndex: appendedReminder?.partIndex,
        mode: appendedReminder?.mode,
      },
      {
        text: 'new-reminder',
        partIndex: 0,
        mode: 'inline',
      },
    );
  });

  it('rejects empty reminder text', () => {
    assert.throws(() => reminder(''), /Reminder text must not be empty/);
    assert.throws(() => reminder('   '), /Reminder text must not be empty/);
  });

  it('merges metadata returned from reminder factories', () => {
    const fragment = user(
      'payload',
      reminder(() => ({
        text: 'structured-hint',
        metadata: {
          environmentReminder: {
            version: 1,
            snapshot: { dateKey: '2026-03-27' },
          },
        },
      })),
    );
    const message = encodeMessage(fragment);
    const metadata = message.metadata as
      | {
          environmentReminder?: Record<string, unknown>;
          reminders?: UserReminderMetadataRecord[];
        }
      | undefined;

    assert.ok(
      getTextPart(message).includes(taggedReminder('structured-hint')),
      'factory reminder text should still be injected',
    );
    assert.deepStrictEqual(metadata?.environmentReminder, {
      version: 1,
      snapshot: { dateKey: '2026-03-27' },
    });
    assert.strictEqual(metadata?.reminders?.length, 1);
  });
});

describe('user codec contract', () => {
  it('decode and encode return the same message with inline reminders', () => {
    const fragment = user('hello', reminder('secret'));
    const decoded = fragment.codec?.decode() as UIMessage;
    const encoded = encodeMessage(fragment);

    assert.strictEqual(
      decoded,
      encoded,
      'decode and encode should return the same reference',
    );
    assert.ok(
      getTextPart(decoded).includes('secret'),
      'inline reminders should be baked into the message',
    );
  });

  it('multiple encode calls return the same reference', () => {
    const fragment = user(
      'hi',
      reminder('r1'),
      reminder('r2', { asPart: true }),
    );
    const first = encodeMessage(fragment);
    const second = encodeMessage(fragment);

    assert.strictEqual(
      first,
      second,
      'encode should return the same object each call',
    );
  });

  it('decode preserves inline reminders and metadata', () => {
    const fragment = user('payload', reminder('injected'));
    const decoded = fragment.codec?.decode() as UIMessage;

    const text = getTextPart(decoded);
    assert.ok(text.includes('payload'), 'original content should be present');
    assert.ok(
      text.includes(taggedReminder('injected')),
      'reminder should be baked in',
    );

    const metadata = getReminderMetadata(decoded);
    assert.strictEqual(metadata.length, 1);
    assert.strictEqual(metadata[0].text, 'injected');
  });

  it('fragments created with the same content are independent', () => {
    const a = user('msg', reminder('a'));
    const b = user('msg', reminder('b'));

    const aMsg = encodeMessage(a);
    const bMsg = encodeMessage(b);

    assert.ok(getTextPart(aMsg).includes('a'));
    assert.ok(!getTextPart(aMsg).includes(taggedReminder('b')));
    assert.ok(getTextPart(bMsg).includes('b'));
    assert.ok(!getTextPart(bMsg).includes(taggedReminder('a')));
  });
});

describe('reminder range helpers', () => {
  it('returns reminder ranges from metadata and defaults to an empty array', () => {
    assert.deepStrictEqual(getReminderRanges(undefined), []);
    assert.deepStrictEqual(getReminderRanges({}), []);

    const ranges = [{ partIndex: 2, start: 10, end: 20 }];
    assert.deepStrictEqual(getReminderRanges({ reminders: ranges }), ranges);
  });

  it('strips text by ranges and preserves non-reminder content', () => {
    const encodedReminder = taggedReminder('keep responses concise');
    const text = `hello${encodedReminder}`;
    const visibleText = stripTextByRanges(text, [
      { start: 5, end: 5 + encodedReminder.length },
    ]);

    assert.strictEqual(visibleText, 'hello');
  });

  it('normalizes out-of-bounds and overlapping ranges', () => {
    const result = stripTextByRanges('0123456789', [
      { start: 8, end: 50 },
      { start: -5, end: 2 },
      { start: 1, end: 4 },
    ]);
    assert.strictEqual(result, '4567');
  });

  it('trims trailing whitespace after stripping ranges', () => {
    const result = stripTextByRanges('abc   ', [{ start: 0, end: 1 }]);
    assert.strictEqual(result, 'bc');
  });

  it('strips reminders from a message and removes reminder metadata', () => {
    const fragment = user(
      {
        id: 'msg-1',
        role: 'user',
        metadata: { source: 'seed' },
        parts: [{ type: 'text', text: 'Deploy now.' }],
      },
      reminder('inline-reminder'),
      reminder('part-reminder', { asPart: true }),
    );
    const message = encodeMessage(fragment);
    const encodedInlineReminder = taggedReminder('inline-reminder');

    assert.deepStrictEqual(
      message.parts.map((part) =>
        part.type === 'text' ? part.text : part.type,
      ),
      [`Deploy now.${encodedInlineReminder}`, 'part-reminder'],
    );

    const stripped = stripReminders(message);
    assert.notStrictEqual(stripped, message);

    assert.deepStrictEqual(
      stripped.parts.map((part) =>
        part.type === 'text' ? part.text : part.type,
      ),
      ['Deploy now.'],
    );

    const strippedMetadata = stripped.metadata as
      | { source?: string; reminders?: unknown }
      | undefined;
    assert.deepStrictEqual(strippedMetadata, { source: 'seed' });

    assert.deepStrictEqual(
      message.parts.map((part) =>
        part.type === 'text' ? part.text : part.type,
      ),
      [`Deploy now.${encodedInlineReminder}`, 'part-reminder'],
    );
    const originalMetadata = message.metadata as
      | { source?: string; reminders?: unknown }
      | undefined;
    assert.ok(originalMetadata?.reminders);
  });

  it('strips reminders across multiple text parts and keeps non-reminder text', () => {
    const fragment = user(
      {
        id: 'msg-multi-part-strip',
        role: 'user',
        metadata: { source: 'seed' },
        parts: [
          { type: 'text', text: 'first' },
          { type: 'text', text: 'second' },
        ],
      },
      reminder('inline-tail'),
      reminder('standalone-part', { asPart: true }),
    );
    const message = encodeMessage(fragment);
    const stripped = stripReminders(message);

    assert.deepStrictEqual(
      stripped.parts.map((part) =>
        part.type === 'text' ? part.text : part.type,
      ),
      ['first', 'second'],
    );

    const metadata = stripped.metadata as
      | { source?: string; reminders?: unknown }
      | undefined;
    assert.deepStrictEqual(metadata, { source: 'seed' });
  });

  it('removes metadata object when reminders is the only metadata key', () => {
    const message: UIMessage = {
      id: 'only-reminder-metadata',
      role: 'user',
      parts: [{ type: 'text', text: 'clean text' }],
      metadata: {
        reminders: [{ partIndex: 0, start: 0, end: 0 }],
      },
    };

    const stripped = stripReminders(message);
    assert.strictEqual(stripped.metadata, undefined);
  });

  it('leaves content unchanged when reminder ranges target missing part indexes', () => {
    const message: UIMessage = {
      id: 'missing-index-ranges',
      role: 'user',
      parts: [{ type: 'text', text: 'plain text' }],
      metadata: {
        source: 'seed',
        reminders: [{ partIndex: 9, start: 0, end: 50 }],
      },
    };

    const stripped = stripReminders(message);
    assert.deepStrictEqual(
      stripped.parts.map((part) =>
        part.type === 'text' ? part.text : part.type,
      ),
      ['plain text'],
    );

    const metadata = stripped.metadata as
      | { source?: string; reminders?: unknown }
      | undefined;
    assert.deepStrictEqual(metadata, { source: 'seed' });
  });
});

describe('reminder scheduling', () => {
  describe('reminder() returns ContextFragment when when is provided', () => {
    it('returns a ContextFragment with conditional reminder metadata', () => {
      const fragment = reminder('every-third', { when: everyNTurns(3) });
      assert.ok(isConditionalReminder(fragment));
      assert.strictEqual(fragment.name, 'reminder');
      assert.strictEqual(typeof fragment.metadata?.reminder, 'object');
    });

    it('returns a UserReminder without when', () => {
      const r = reminder('plain');
      assert.ok(!('name' in r), 'Should be a UserReminder, not a fragment');
      assert.strictEqual(r.text, 'plain');
      assert.strictEqual(r.asPart, false);
    });

    it('stores asPart in fragment metadata when when is provided', () => {
      const fragment = reminder('text', {
        when: everyNTurns(3),
        asPart: true,
      });
      assert.ok(isConditionalReminder(fragment));
      const config = (fragment.metadata as { reminder: { asPart: boolean } })
        .reminder;
      assert.strictEqual(config.asPart, true);
    });

    it('stores callback text in fragment metadata when when is provided', () => {
      const cb = (ctx: { turn?: number }) => `turn ${ctx.turn}`;
      const fragment = reminder(cb, { when: once() });
      assert.ok(isConditionalReminder(fragment));
      const config = (fragment.metadata as { reminder: { text: unknown } })
        .reminder;
      assert.strictEqual(typeof config.text, 'function');
    });

    it('rejects empty string text even with when', () => {
      assert.throws(
        () => reminder('', { when: once() }),
        /Reminder text must not be empty/,
      );
    });

    it('isConditionalReminder returns false for non-reminder fragments', () => {
      assert.strictEqual(
        isConditionalReminder({ name: 'role', data: 'helpful' }),
        false,
      );
      assert.strictEqual(isConditionalReminder({ name: 'reminder' }), false);
    });
  });

  describe('when predicates', () => {
    it('everyNTurns fires on turns divisible by N', () => {
      const pred = everyNTurns(3);
      assert.strictEqual(pred({ turn: 1 }), false);
      assert.strictEqual(pred({ turn: 2 }), false);
      assert.strictEqual(pred({ turn: 3 }), true);
      assert.strictEqual(pred({ turn: 6 }), true);
      assert.strictEqual(pred({ turn: 7 }), false);
    });

    it('once fires only on turn 1', () => {
      const pred = once();
      assert.strictEqual(pred({ turn: 1 }), true);
      assert.strictEqual(pred({ turn: 2 }), false);
      assert.strictEqual(pred({ turn: 10 }), false);
    });

    it('firstN fires on first N turns', () => {
      const pred = firstN(3);
      assert.strictEqual(pred({ turn: 1 }), true);
      assert.strictEqual(pred({ turn: 3 }), true);
      assert.strictEqual(pred({ turn: 4 }), false);
    });

    it('afterTurn fires only after turn N', () => {
      const pred = afterTurn(5);
      assert.strictEqual(pred({ turn: 5 }), false);
      assert.strictEqual(pred({ turn: 6 }), true);
      assert.strictEqual(pred({ turn: 10 }), true);
    });

    it('custom predicate', () => {
      const pred = ({ turn }: { turn: number }) => turn === 4;
      assert.strictEqual(pred({ turn: 3 }), false);
      assert.strictEqual(pred({ turn: 4 }), true);
      assert.strictEqual(pred({ turn: 5 }), false);
    });

    it('and() combines with AND logic', () => {
      const pred = and(everyNTurns(3), afterTurn(5));
      assert.strictEqual(pred({ turn: 3 }), false);
      assert.strictEqual(pred({ turn: 6 }), true);
      assert.strictEqual(pred({ turn: 7 }), false);
      assert.strictEqual(pred({ turn: 9 }), true);
    });

    it('or() combines with OR logic', () => {
      const pred = or(once(), everyNTurns(5));
      assert.strictEqual(pred({ turn: 1 }), true);
      assert.strictEqual(pred({ turn: 2 }), false);
      assert.strictEqual(pred({ turn: 5 }), true);
      assert.strictEqual(pred({ turn: 10 }), true);
    });

    it('not() inverts a predicate', () => {
      const pred = not(firstN(2));
      assert.strictEqual(pred({ turn: 1 }), false);
      assert.strictEqual(pred({ turn: 2 }), false);
      assert.strictEqual(pred({ turn: 3 }), true);
    });
  });

  describe('temporal predicates', () => {
    function useFakeTime<T>(iso: string, fn: () => T): T {
      mock.timers.enable({ apis: ['Date'] });
      mock.timers.setTime(new Date(iso).getTime());
      try {
        return fn();
      } finally {
        mock.timers.reset();
      }
    }

    describe('dayChanged', () => {
      it('fires on first turn when lastMessageAt is undefined', () => {
        useFakeTime('2026-03-27T12:00:00Z', () => {
          assert.strictEqual(dayChanged()({ turn: 1 }), true);
        });
      });

      it('does not fire when still the same day', () => {
        useFakeTime('2026-03-27T23:00:00Z', () => {
          assert.strictEqual(
            dayChanged()({
              turn: 2,
              lastMessageAt: new Date('2026-03-27T12:00:00Z').getTime(),
            }),
            false,
          );
        });
      });

      it('fires when the day has changed', () => {
        useFakeTime('2026-03-28T01:00:00Z', () => {
          assert.strictEqual(
            dayChanged()({
              turn: 2,
              lastMessageAt: new Date('2026-03-27T23:00:00Z').getTime(),
            }),
            true,
          );
        });
      });

      it('respects timezone for day boundary', () => {
        useFakeTime('2026-03-27T16:00:00Z', () => {
          assert.strictEqual(
            dayChanged('Asia/Tokyo')({
              turn: 2,
              lastMessageAt: new Date('2026-03-27T14:00:00Z').getTime(),
            }),
            true,
            'In Tokyo: now=2026-03-28 01:00, prev=2026-03-27 23:00 => day changed',
          );
        });
      });
    });

    describe('hourChanged', () => {
      it('fires on first turn', () => {
        useFakeTime('2026-03-27T12:00:00Z', () => {
          assert.strictEqual(hourChanged()({ turn: 1 }), true);
        });
      });

      it('does not fire within the same hour', () => {
        useFakeTime('2026-03-27T12:45:00Z', () => {
          assert.strictEqual(
            hourChanged()({
              turn: 2,
              lastMessageAt: new Date('2026-03-27T12:10:00Z').getTime(),
            }),
            false,
          );
        });
      });

      it('fires when the hour has changed', () => {
        useFakeTime('2026-03-27T13:05:00Z', () => {
          assert.strictEqual(
            hourChanged()({
              turn: 2,
              lastMessageAt: new Date('2026-03-27T12:55:00Z').getTime(),
            }),
            true,
          );
        });
      });
    });

    describe('monthChanged', () => {
      it('fires on first turn', () => {
        useFakeTime('2026-03-15T12:00:00Z', () => {
          assert.strictEqual(monthChanged()({ turn: 1 }), true);
        });
      });

      it('does not fire within the same month', () => {
        useFakeTime('2026-03-28T12:00:00Z', () => {
          assert.strictEqual(
            monthChanged()({
              turn: 2,
              lastMessageAt: new Date('2026-03-01T12:00:00Z').getTime(),
            }),
            false,
          );
        });
      });

      it('fires when the month has changed', () => {
        useFakeTime('2026-04-01T00:05:00Z', () => {
          assert.strictEqual(
            monthChanged()({
              turn: 2,
              lastMessageAt: new Date('2026-03-31T23:55:00Z').getTime(),
            }),
            true,
          );
        });
      });
    });

    describe('yearChanged', () => {
      it('fires on first turn', () => {
        useFakeTime('2026-06-15T12:00:00Z', () => {
          assert.strictEqual(yearChanged()({ turn: 1 }), true);
        });
      });

      it('does not fire within the same year', () => {
        useFakeTime('2026-12-31T12:00:00Z', () => {
          assert.strictEqual(
            yearChanged()({
              turn: 2,
              lastMessageAt: new Date('2026-01-01T12:00:00Z').getTime(),
            }),
            false,
          );
        });
      });

      it('fires when the year has changed', () => {
        useFakeTime('2027-01-01T00:05:00Z', () => {
          assert.strictEqual(
            yearChanged()({
              turn: 2,
              lastMessageAt: new Date('2026-12-31T23:55:00Z').getTime(),
            }),
            true,
          );
        });
      });
    });

    describe('seasonChanged', () => {
      it('fires on first turn', () => {
        useFakeTime('2026-06-15T12:00:00Z', () => {
          assert.strictEqual(seasonChanged()({ turn: 1 }), true);
        });
      });

      it('does not fire within the same season', () => {
        useFakeTime('2026-07-15T12:00:00Z', () => {
          assert.strictEqual(
            seasonChanged()({
              turn: 2,
              lastMessageAt: new Date('2026-06-15T12:00:00Z').getTime(),
            }),
            false,
            'June and July are both Summer',
          );
        });
      });

      it('fires when the season changes (Spring -> Summer)', () => {
        useFakeTime('2026-06-01T12:00:00Z', () => {
          assert.strictEqual(
            seasonChanged()({
              turn: 2,
              lastMessageAt: new Date('2026-05-31T12:00:00Z').getTime(),
            }),
            true,
            'May is Spring, June is Summer',
          );
        });
      });
    });

    describe('weekChanged', () => {
      it('fires on first turn', () => {
        useFakeTime('2026-03-25T12:00:00Z', () => {
          assert.strictEqual(weekChanged()({ turn: 1 }), true);
        });
      });

      it('does not fire within the same week', () => {
        useFakeTime('2026-03-26T12:00:00Z', () => {
          assert.strictEqual(
            weekChanged()({
              turn: 2,
              lastMessageAt: new Date('2026-03-24T12:00:00Z').getTime(),
            }),
            false,
            'Tue Mar 24 and Thu Mar 26 are same ISO week',
          );
        });
      });

      it('fires when the week changes', () => {
        useFakeTime('2026-04-06T12:00:00Z', () => {
          assert.strictEqual(
            weekChanged()({
              turn: 2,
              lastMessageAt: new Date('2026-03-27T12:00:00Z').getTime(),
            }),
            true,
            'Mar 27 (Fri) and Apr 6 (Mon) are different ISO weeks',
          );
        });
      });
    });

    describe('composition', () => {
      it('composes dayChanged with afterTurn', () => {
        useFakeTime('2026-03-28T12:00:00Z', () => {
          const pred = and(dayChanged(), afterTurn(3));

          assert.strictEqual(
            pred({
              turn: 2,
              lastMessageAt: new Date('2026-03-27T12:00:00Z').getTime(),
            }),
            false,
            'turn 2 + day changed => false (afterTurn(3) fails)',
          );

          assert.strictEqual(
            pred({
              turn: 4,
              lastMessageAt: new Date('2026-03-27T12:00:00Z').getTime(),
            }),
            true,
            'turn 4 + day changed => true',
          );
        });
      });

      it('composes hourChanged with not()', () => {
        useFakeTime('2026-03-27T13:05:00Z', () => {
          const pred = not(hourChanged());

          assert.strictEqual(
            pred({
              turn: 2,
              lastMessageAt: new Date('2026-03-27T12:55:00Z').getTime(),
            }),
            false,
            'hour changed => not() inverts to false',
          );
        });
      });
    });
  });
});
