import type { UIMessage } from 'ai';
import assert from 'node:assert';
import { describe, it } from 'node:test';

import {
  assistant,
  assistantText,
  getFragmentData,
  isFragment,
  message,
  user,
} from '@deepagents/context';

function encoded(fragment: { codec?: { encode(): unknown } }): UIMessage {
  const value = fragment.codec?.encode();
  assert.ok(value);
  return value as UIMessage;
}

describe('built-in message fragments', () => {
  it('user() works as a codec-only fragment', () => {
    const fragment = user('hello');
    assert.ok(isFragment(fragment));
    assert.ok(!('data' in fragment));
    assert.deepStrictEqual(getFragmentData(fragment), encoded(fragment));
  });

  it('message() works as a codec-only fragment', () => {
    const fragment = message('hello');
    assert.ok(isFragment(fragment));
    assert.ok(!('data' in fragment));
    assert.deepStrictEqual(getFragmentData(fragment), encoded(fragment));
  });

  it('assistant() works as a codec-only fragment', () => {
    const input: UIMessage = {
      id: 'assistant-1',
      role: 'assistant',
      parts: [{ type: 'text', text: 'hi' }],
    };
    const fragment = assistant(input);

    assert.ok(isFragment(fragment));
    assert.ok(!('data' in fragment));
    assert.deepStrictEqual(getFragmentData(fragment), encoded(fragment));
  });

  it('assistantText() works as a codec-only fragment', () => {
    const fragment = assistantText('hello', { id: 'assistant-text-1' });
    assert.ok(isFragment(fragment));
    assert.ok(!('data' in fragment));
    assert.deepStrictEqual(getFragmentData(fragment), encoded(fragment));
  });
});
