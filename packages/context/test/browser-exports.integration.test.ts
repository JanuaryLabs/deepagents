import type { UIMessage } from 'ai';
import assert from 'node:assert';
import { describe, it } from 'node:test';

import {
  XmlRenderer,
  applyUserRemindersToMessage,
  fromFragment,
  getReminderRanges,
  identity,
  render,
  stripReminders,
  stripTextByRanges,
  term,
  toFragment,
  user,
} from '@deepagents/context/browser';

describe('browser export path', () => {
  it('renders browser-safe fragments through the browser entrypoint', () => {
    const output = render(
      'instructions',
      identity({ name: 'Mo', role: 'Engineer' }),
      term('LTV', 'Lifetime Value'),
    );

    assert.ok(output.includes('<instructions>'));
    assert.ok(output.includes('<identity>'));
    assert.ok(output.includes('<term>'));
  });

  it('supports reminder metadata helpers through browser entrypoint', () => {
    const message = user('Deploy now.').codec?.encode() as {
      parts: Array<{ type: string; text?: string }>;
      metadata?: Record<string, unknown>;
    };
    applyUserRemindersToMessage(message as unknown as UIMessage, [
      {
        text: 'Ask for confirmation before destructive actions',
        asPart: false,
        target: 'user',
      },
    ]);

    const ranges = getReminderRanges(message.metadata);
    assert.strictEqual(ranges.length, 1);

    const textPart = message.parts[0];
    assert.strictEqual(textPart.type, 'text');

    if (textPart.type === 'text') {
      const stripped = stripTextByRanges(textPart.text ?? '', ranges);
      assert.strictEqual(stripped, 'Deploy now.');
    }
  });

  it('strips reminders from messages through browser entrypoint', () => {
    const partMode = true;
    const message = user('Ship now.').codec?.encode() as UIMessage;
    applyUserRemindersToMessage(message, [
      { text: 'hidden-inline', asPart: false, target: 'user' },
      { text: 'hidden-part', asPart: partMode, target: 'user' },
    ]);

    const stripped = stripReminders(message);

    assert.deepStrictEqual(
      stripped.parts.map((part) =>
        part.type === 'text' ? (part.text ?? '') : part.type,
      ),
      ['Ship now.'],
    );
    const strippedMetadata = stripped.metadata as
      | { reminders?: unknown }
      | undefined;
    assert.strictEqual(strippedMetadata?.reminders, undefined);
  });

  it('exposes renderer classes from browser entrypoint', () => {
    const renderer = new XmlRenderer();
    const result = renderer.render([term('ARR', 'Annual Recurring Revenue')]);

    assert.ok(result.includes('<term>'));
    assert.ok(result.includes('<name>ARR</name>'));
  });

  it('exposes serialized fragment conversion helpers from browser entrypoint', () => {
    const fragment = toFragment({
      type: 'term',
      name: 'ARR',
      definition: 'Annual Recurring Revenue',
    });

    assert.deepStrictEqual(fromFragment(fragment), {
      type: 'term',
      name: 'ARR',
      definition: 'Annual Recurring Revenue',
    });
  });
});
