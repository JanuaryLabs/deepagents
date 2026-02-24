import type { UIMessage } from 'ai';
import assert from 'node:assert';
import { describe, it } from 'node:test';

import {
  getReminderRanges,
  reminder,
  stripTextByRanges,
  user,
} from '@deepagents/context';

type UserReminderMetadataRecord = {
  id: string;
  text: string;
  partIndex: number;
  start: number;
  end: number;
  mode: 'inline' | 'part';
};

function decodeMessage(fragment: ReturnType<typeof user>): UIMessage {
  const message = fragment.codec?.decode();
  assert.ok(message, 'Expected user fragment to have a decodable message');
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
    const message = decodeMessage(fragment);

    const encodedReminder = taggedReminder('keep responses concise');
    assert.strictEqual(message.role, 'user');
    assert.strictEqual(getTextPart(message), `hello${encodedReminder}`);

    const metadata = getReminderMetadata(message);
    assert.strictEqual(metadata.length, 1);

    const reminderMeta = metadata[0];
    assert.ok(reminderMeta.id, 'Reminder metadata should include an id');
    assert.strictEqual(reminderMeta.text, 'keep responses concise');
    assert.strictEqual(reminderMeta.partIndex, 0);
    assert.strictEqual(reminderMeta.start, 5);
    assert.strictEqual(reminderMeta.end, 5 + encodedReminder.length);
    assert.strictEqual(reminderMeta.mode, 'inline');
  });

  it('applies multiple inline reminders in call order with append-only ranges', () => {
    const fragment = user(
      'x',
      reminder('first'),
      reminder('second'),
      reminder('third'),
    );
    const message = decodeMessage(fragment);

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
    const message = decodeMessage(fragment);

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
      },
      reminder('new-reminder'),
    );
    const message = decodeMessage(fragment);
    const metadata = message.metadata as
      | {
          source?: string;
          reminders?: UserReminderMetadataRecord[];
        }
      | undefined;

    assert.strictEqual(message.id, 'msg-with-metadata');
    assert.strictEqual(message.role, 'user');
    assert.strictEqual(metadata?.source, 'seed');
    assert.strictEqual(metadata?.reminders?.length, 2);
    assert.deepStrictEqual(metadata?.reminders?.[0], existingReminder);

    const appendedReminder = metadata?.reminders?.[1];
    assert.ok(appendedReminder?.id, 'Appended reminder should include id');
    assert.strictEqual(appendedReminder?.text, 'new-reminder');
    assert.strictEqual(appendedReminder?.partIndex, 0);
    assert.strictEqual(appendedReminder?.mode, 'inline');
  });

  it('rejects empty reminder text', () => {
    assert.throws(() => reminder(''), /Reminder text must not be empty/);
    assert.throws(() => reminder('   '), /Reminder text must not be empty/);
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
});
