import { type ToolUIPart, type UIMessage, isStaticToolUIPart } from 'ai';
import assert from 'node:assert';
import { describe, it } from 'node:test';

import {
  type UserReminderMetadata,
  everyNTurns,
  getReminderRanges,
  hint,
  isConditionalReminder,
  once,
  reminder,
  stripReminders,
  stripTextByRanges,
  user,
} from '@deepagents/context';

type OutputAvailableToolPart = ToolUIPart & {
  state: 'output-available';
  output: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUIMessage(value: unknown): value is UIMessage {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    (value.role === 'system' ||
      value.role === 'user' ||
      value.role === 'assistant') &&
    Array.isArray(value.parts)
  );
}

function isReminderMetadata(value: unknown): value is UserReminderMetadata {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.text === 'string' &&
    (value.target === 'user' || value.target === 'tool-output') &&
    typeof value.partIndex === 'number' &&
    typeof value.start === 'number' &&
    typeof value.end === 'number' &&
    (value.mode === 'inline' ||
      value.mode === 'part' ||
      value.mode === 'tool-output')
  );
}

function getMetadata(message: UIMessage): Record<string, unknown> {
  return isRecord(message.metadata) ? message.metadata : {};
}

function isOutputAvailableToolPart(
  part: UIMessage['parts'][number] | undefined,
): part is OutputAvailableToolPart {
  return (
    part !== undefined &&
    isStaticToolUIPart(part) &&
    part.state === 'output-available'
  );
}

function getToolOutput(message: UIMessage, index = 0): unknown {
  const part = message.parts[index];
  assert.ok(
    isOutputAvailableToolPart(part),
    `Expected output-available tool part at index ${index}`,
  );
  return part.output;
}

function encodeMessage(fragment: ReturnType<typeof user>): UIMessage {
  const message = fragment.codec?.encode();
  assert.ok(
    isUIMessage(message),
    'Expected user fragment to have an encodable UIMessage',
  );
  return message;
}

function decodeMessage(fragment: ReturnType<typeof user>): UIMessage {
  const message = fragment.codec?.decode();
  assert.ok(
    isUIMessage(message),
    'Expected user fragment to decode to a UIMessage',
  );
  return message;
}

function getReminderMetadata(message: UIMessage): UserReminderMetadata[] {
  const reminders = getMetadata(message).reminders;
  if (!Array.isArray(reminders)) {
    return [];
  }
  return reminders.filter(isReminderMetadata);
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
    const partMode = true;
    const fragment = user(
      'body',
      reminder('before', { asPart: partMode }),
      reminder('after', { asPart: partMode }),
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
    const existingReminder: UserReminderMetadata = {
      id: 'existing-reminder',
      text: 'existing',
      target: 'user',
      partIndex: 0,
      start: 0,
      end: 8,
      mode: 'part',
    };
    const content: UIMessage & { role: 'user' } = {
      id: 'msg-with-metadata',
      role: 'user',
      metadata: {
        source: 'seed',
        reminders: [existingReminder],
      },
      parts: [{ type: 'text', text: 'payload' }],
    };

    const fragment = user(content, reminder('new-reminder'));
    const message = encodeMessage(fragment);
    const metadata = getMetadata(message);
    const reminders = getReminderMetadata(message);

    assert.strictEqual(message.id, 'msg-with-metadata');
    assert.strictEqual(message.role, 'user');
    assert.deepStrictEqual(
      {
        source: metadata?.source,
        existingReminder: reminders[0],
        reminderCount: reminders.length,
      },
      {
        source: 'seed',
        existingReminder,
        reminderCount: 2,
      },
    );

    const appendedReminder = reminders[1];
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
    const metadata = getMetadata(message);

    assert.ok(
      getTextPart(message).includes(taggedReminder('structured-hint')),
      'factory reminder text should still be injected',
    );
    assert.deepStrictEqual(metadata?.environmentReminder, {
      version: 1,
      snapshot: { dateKey: '2026-03-27' },
    });
    assert.strictEqual(getReminderMetadata(message).length, 1);
  });
});

describe('user codec contract', () => {
  it('decode and encode return the same message with inline reminders', () => {
    const fragment = user('hello', reminder('secret'));
    const decoded = decodeMessage(fragment);
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
      reminder('r2', { asPart: false }),
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
    const decoded = decodeMessage(fragment);

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
    const partMode = true;
    const fragment = user(
      {
        id: 'msg-1',
        role: 'user',
        metadata: { source: 'seed' },
        parts: [{ type: 'text', text: 'Deploy now.' }],
      },
      reminder('inline-reminder'),
      reminder('part-reminder', { asPart: partMode }),
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

    assert.deepStrictEqual(stripped.metadata, { source: 'seed' });

    assert.deepStrictEqual(
      message.parts.map((part) =>
        part.type === 'text' ? part.text : part.type,
      ),
      [`Deploy now.${encodedInlineReminder}`, 'part-reminder'],
    );
    assert.ok(getMetadata(message).reminders);
  });

  it('strips reminders across multiple text parts and keeps non-reminder text', () => {
    const partMode = true;
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
      reminder('standalone-part', { asPart: partMode }),
    );
    const message = encodeMessage(fragment);
    const stripped = stripReminders(message);

    assert.deepStrictEqual(
      stripped.parts.map((part) =>
        part.type === 'text' ? part.text : part.type,
      ),
      ['first', 'second'],
    );

    assert.deepStrictEqual(stripped.metadata, { source: 'seed' });
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

    assert.deepStrictEqual(stripped.metadata, { source: 'seed' });
  });

  it('strips user reminders and tool-output reminders from string and envelope outputs', () => {
    const userFragment = user('Deploy now.', reminder('user-reminder'));
    const userMessage = encodeMessage(userFragment);

    const stringReminder = taggedReminder('string-tool-reminder');
    const stringToolMessage: UIMessage = {
      id: 'assistant-string-tool-reminder',
      role: 'assistant',
      parts: [
        {
          type: 'tool-bash',
          toolCallId: 'tool-string',
          state: 'output-available',
          input: {},
          output: `stdout${stringReminder}`,
        },
      ],
      metadata: {
        reminders: [
          {
            id: 'tool-string-reminder',
            text: 'string-tool-reminder',
            target: 'tool-output',
            partIndex: 0,
            start: 'stdout'.length,
            end: 'stdout'.length + stringReminder.length,
            mode: 'tool-output',
          },
        ],
      },
    };

    const envelopeToolMessage: UIMessage = {
      id: 'assistant-envelope-tool-reminder',
      role: 'assistant',
      parts: [
        {
          type: 'tool-sql',
          toolCallId: 'tool-envelope',
          state: 'output-available',
          input: {},
          output: {
            result: { rows: [{ id: 1 }] },
            systemReminder: 'object-tool-reminder',
          },
        },
      ],
      metadata: {
        reminders: [
          {
            id: 'tool-envelope-reminder',
            text: 'object-tool-reminder',
            target: 'tool-output',
            partIndex: 0,
            start: 0,
            end: 0,
            mode: 'tool-output',
          },
        ],
      },
    };

    const strippedUser = stripReminders(userMessage);
    const strippedStringTool = stripReminders(stringToolMessage);
    const strippedEnvelopeTool = stripReminders(envelopeToolMessage);

    assert.strictEqual(getTextPart(strippedUser), 'Deploy now.');
    assert.strictEqual(strippedUser.metadata, undefined);

    assert.strictEqual(getToolOutput(strippedStringTool), 'stdout');
    assert.strictEqual(strippedStringTool.metadata, undefined);

    assert.deepStrictEqual(getToolOutput(strippedEnvelopeTool), {
      rows: [{ id: 1 }],
    });
    assert.strictEqual(strippedEnvelopeTool.metadata, undefined);
  });

  it('treats old reminder metadata without target as a user reminder', () => {
    const encodedReminder = taggedReminder('legacy-reminder');
    const message: UIMessage = {
      id: 'legacy-reminder-metadata',
      role: 'user',
      parts: [{ type: 'text', text: `body${encodedReminder}` }],
      metadata: {
        reminders: [
          {
            id: 'legacy-reminder',
            text: 'legacy-reminder',
            partIndex: 0,
            start: 'body'.length,
            end: 'body'.length + encodedReminder.length,
            mode: 'inline',
          },
        ],
      },
    };

    const stripped = stripReminders(message);

    assert.strictEqual(getTextPart(stripped), 'body');
    assert.strictEqual(stripped.metadata, undefined);
  });
});

describe('reminder scheduling', () => {
  describe('reminder() returns ContextFragment when when is provided', () => {
    it('returns a ContextFragment with conditional reminder metadata', () => {
      const fragment = reminder('every-third', { when: everyNTurns(3) });
      assert.ok(isConditionalReminder(fragment));
      assert.strictEqual(fragment.name, 'reminder');
      assert.strictEqual(typeof fragment.metadata?.reminder, 'object');
      assert.strictEqual(fragment.metadata?.reminder.target, 'user');
    });

    it('returns a UserReminder without when', () => {
      const r = reminder('plain');
      assert.ok(!('name' in r), 'Should be a UserReminder, not a fragment');
      assert.strictEqual(r.text, 'plain');
      assert.strictEqual(r.asPart, false);
    });

    it('stores asPart in fragment metadata when when is provided', () => {
      const partMode = true;
      const fragment = reminder('text', {
        when: everyNTurns(3),
        asPart: partMode,
      });
      assert.ok(isConditionalReminder(fragment));
      assert.strictEqual(fragment.metadata.reminder.asPart, true);
    });

    it('stores explicit tool-output target in conditional reminder metadata', () => {
      const fragment = reminder('text', {
        when: everyNTurns(1),
        target: 'tool-output',
      });
      assert.ok(isConditionalReminder(fragment));
      assert.strictEqual(fragment.metadata.reminder.target, 'tool-output');
    });

    it('stores callback text in fragment metadata when when is provided', () => {
      const cb = (ctx: { turn?: number }) => `turn ${ctx.turn}`;
      const fragment = reminder(cb, { when: once() });
      assert.ok(isConditionalReminder(fragment));
      assert.strictEqual(typeof fragment.metadata.reminder.text, 'function');
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

  describe('reminder() asPart defaults (immediate path)', () => {
    it('fragment input defaults asPart to false', () => {
      const r = reminder(hint('Check indexes'));
      assert.ok(!('name' in r), 'Should be a UserReminder, not a fragment');
      assert.strictEqual(
        r.asPart,
        false,
        'Immediate fragment reminders should default inline',
      );
    });

    it('explicit asPart: false keeps fragment reminders inline', () => {
      const r = reminder(hint('Inline hint'), { asPart: false });
      assert.ok(!('name' in r));
      assert.strictEqual(
        r.asPart,
        false,
        'Caller-provided asPart should be honored',
      );
    });

    it('explicit part mode overrides the string default', () => {
      const partMode = true;
      const r = reminder('plain', { asPart: partMode });
      assert.ok(!('name' in r));
      assert.strictEqual(
        r.asPart,
        true,
        'String input defaults to false but caller can override to part mode',
      );
    });
  });
});
