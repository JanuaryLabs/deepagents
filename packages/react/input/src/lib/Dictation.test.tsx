import { cleanup, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import {
  Dictation,
  insertTranscript,
  useDictationContext,
} from '@deepagents/react-input/browser';

function ReadsDictation() {
  useDictationContext('ReadsDictation');
  return null;
}

function fieldWithCursor(value: string, cursor: number) {
  const form = document.createElement('form');
  const field = document.createElement('textarea');
  form.append(field);
  document.body.append(form);
  field.value = value;
  field.setSelectionRange(cursor, cursor);
  const inputs: string[] = [];
  form.addEventListener('input', () => {
    inputs.push(field.value);
  });
  return { field, inputs, [Symbol.dispose]: () => form.remove() };
}

describe('Dictation without a composer', () => {
  it('offers no dictation in a browser without a recorder', async () => {
    using stack = new DisposableStack();
    stack.defer(cleanup);

    render(
      <Dictation.Root
        transcribe={async () => ({ text: 'never heard' })}
        onTranscript={() => undefined}
      >
        <textarea aria-label="Anything else relevant?" />
        <Dictation.Toggle
          render={(props, dictation) => (
            <button {...props}>
              {dictation.status === 'unavailable'
                ? `Dictation unavailable: ${dictation.reason}`
                : `Dictation ${dictation.status}`}
            </button>
          )}
        />
        <Dictation.Cancel render={<button>Cancel dictation</button>} />
      </Dictation.Root>,
    );

    const toggle = await screen.findByRole('button', {
      name: 'Dictation unavailable: unsupported',
    });
    expect(toggle).toBeDisabled();
    expect(toggle).toHaveAttribute('data-status', 'unavailable');
    expect(
      screen.getByRole('button', { name: 'Cancel dictation' }),
    ).toBeDisabled();
  });

  it.each([
    ['Dictation.Toggle', <Dictation.Toggle key="toggle" />],
    ['Dictation.Cancel', <Dictation.Cancel key="cancel" />],
    ['ReadsDictation', <ReadsDictation key="hook" />],
  ])('%s needs Dictation.Root', (name, part) => {
    using stack = new DisposableStack();
    stack.defer(cleanup);

    expect(() => render(part)).toThrow(
      `${name} must be used inside Dictation.Root.`,
    );
  });
});

describe('insertTranscript', () => {
  it('puts the text at the cursor, with a space after a word', () => {
    using fixture = fieldWithCursor('Fever and cough', 9);

    insertTranscript(fixture.field, 'a dry');

    expect(fixture.field.value).toBe('Fever and a dry cough');
    expect(fixture.inputs).toEqual(['Fever and a dry cough']);
  });

  it('adds no space after whitespace', () => {
    using fixture = fieldWithCursor('Fever ', 6);

    insertTranscript(fixture.field, 'and cough');

    expect(fixture.field.value).toBe('Fever and cough');
  });

  it('adds no space at the start of an empty field', () => {
    using fixture = fieldWithCursor('', 0);

    insertTranscript(fixture.field, '  Fever since Monday  ');

    expect(fixture.field.value).toBe('Fever since Monday');
  });

  it('inserts nothing for an empty transcript', () => {
    using fixture = fieldWithCursor('Fever', 5);

    insertTranscript(fixture.field, '   ');

    expect(fixture.field.value).toBe('Fever');
    expect(fixture.inputs).toEqual([]);
  });
});
