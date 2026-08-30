import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildBaseOutputAnswer,
  createInitialAnswer,
  inputSchema,
  outputSchema,
  prepareOptions,
  validateAnswer,
} from './schemas.ts';

test('normalizes choice-like inputs without accepting query choices', () => {
  const parsed = inputSchema.parse({
    questions: [
      {
        type: 'single-select',
        question: 'Which timeframe?',
        options: [{ label: 'Last 30 days' }],
      },
    ],
  });

  assert.equal(parsed.questions[0].type, 'choice');
  assert.equal(
    inputSchema.safeParse({
      questions: [
        {
          type: 'query_choice',
          question: 'Which country?',
          source: 'countries.ts',
          labelColumn: 'country',
        },
      ],
    }).success,
    false,
  );
});

test('validates Limerence choice and custom-answer states', () => {
  const question = inputSchema.parse({
    questions: [
      {
        type: 'choice',
        question: 'Which timeframe?',
        options: [{ label: 'Last 30 days' }],
      },
    ],
  }).questions[0];
  const answer = createInitialAnswer(question);

  assert.equal(
    validateAnswer(answer),
    'Select an option or add your own answer.',
  );
  assert.equal(
    validateAnswer({ ...answer, isOther: true }),
    'Add your custom answer for the "Other" option.',
  );
  assert.equal(
    validateAnswer({ ...answer, isOther: true, customText: 'Last year' }),
    null,
  );
});

test('builds Limerence-shaped answers without memory metadata', () => {
  const [single, multiple] = inputSchema.parse({
    questions: [
      {
        type: 'choice',
        question: 'Which timeframe?',
        options: [{ label: 'Last 30 days', value: '30d' }],
      },
      {
        type: 'choice',
        question: 'Which priorities?',
        multiSelect: true,
        options: [{ label: 'Quality', value: 'quality' }],
      },
    ],
  }).questions;

  const output = outputSchema.parse({
    answers: [
      buildBaseOutputAnswer(
        single,
        {
          ...createInitialAnswer(single),
          selected: '30d',
          notes: 'Use completed periods.',
        },
        prepareOptions(single),
      ),
      buildBaseOutputAnswer(
        multiple,
        {
          ...createInitialAnswer(multiple),
          selectedMulti: ['quality'],
          customText: 'Speed',
        },
        prepareOptions(multiple),
      ),
    ],
  });

  assert.deepEqual(output, {
    answers: [
      {
        type: 'choice',
        question: 'Which timeframe?',
        multiSelect: false,
        choice: { label: 'Last 30 days', value: '30d' },
        freeText: undefined,
        notes: 'Use completed periods.',
      },
      {
        type: 'choice',
        question: 'Which priorities?',
        multiSelect: true,
        choices: [
          { label: 'Quality', value: 'quality' },
          { label: 'Other', value: 'Speed' },
        ],
        freeText: 'Speed',
        notes: undefined,
      },
    ],
  });
  assert.equal('memoryHint' in output, false);
});
