import type { UIMessage } from 'ai';
import assert from 'node:assert';
import { describe, it } from 'node:test';

import {
  getReminderRanges,
  reminder,
  stripReminders,
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
