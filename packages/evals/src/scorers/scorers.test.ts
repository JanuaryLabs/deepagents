import assert from 'node:assert';
import { describe, it } from 'node:test';

import {
  all,
  any,
  exactMatch,
  includes,
  jsonMatch,
  levenshtein,
  regex,
  weighted,
} from '@deepagents/evals/scorers';

describe('exactMatch', () => {
  it('returns 1.0 when output matches expected', async () => {
    const result = await exactMatch({
      input: 'q',
      output: 'hello',
      expected: 'hello',
    });
    assert.strictEqual(result.score, 1.0);
  });

  it('returns 0.0 when output does not match expected', async () => {
    const result = await exactMatch({
      input: 'q',
      output: 'hello',
      expected: 'world',
    });
    assert.strictEqual(result.score, 0.0);
  });

  it('coerces non-string expected to string', async () => {
    const result = await exactMatch({
      input: 'q',
      output: '42',
      expected: 42,
    });
    assert.strictEqual(result.score, 1.0);
  });
});

describe('includes', () => {
  it('returns 1.0 when output contains the expected substring', async () => {
    const result = await includes({
      input: 'q',
      output: 'hello world',
      expected: 'world',
    });
    assert.strictEqual(result.score, 1.0);
  });

  it('returns 0.0 when output does not contain the expected substring', async () => {
    const result = await includes({
      input: 'q',
      output: 'hello world',
      expected: 'missing',
    });
    assert.strictEqual(result.score, 0.0);
  });
});

describe('regex', () => {
  it('returns 1.0 when output matches the pattern', async () => {
    const scorer = regex(/^\d{3}-\d{4}$/);
    const result = await scorer({
      input: 'q',
      output: '123-4567',
    });
    assert.strictEqual(result.score, 1.0);
  });

  it('returns 0.0 when output does not match the pattern', async () => {
    const scorer = regex(/^\d{3}-\d{4}$/);
    const result = await scorer({
      input: 'q',
      output: 'abc-defg',
    });
    assert.strictEqual(result.score, 0.0);
  });
});

describe('levenshtein', () => {
  it('returns a high score for similar strings', async () => {
    const result = await levenshtein({
      input: 'q',
      output: 'kitten',
      expected: 'sitten',
    });
    assert.ok(result.score > 0.8, `expected score > 0.8, got ${result.score}`);
  });

  it('returns a low score for dissimilar strings', async () => {
    const result = await levenshtein({
      input: 'q',
      output: 'abcdef',
      expected: 'zyxwvu',
    });
    assert.ok(result.score < 0.2, `expected score < 0.2, got ${result.score}`);
  });

  it('returns 1.0 when both strings are empty', async () => {
    const result = await levenshtein({
      input: 'q',
      output: '',
      expected: '',
    });
    assert.strictEqual(result.score, 1.0);
  });

  it('returns 0.0 when one string is empty and the other is not', async () => {
    const result = await levenshtein({
      input: 'q',
      output: '',
      expected: 'something',
    });
    assert.strictEqual(result.score, 0.0);
  });
});

describe('jsonMatch', () => {
  it('returns 1.0 for equivalent JSON regardless of key order', async () => {
    const result = await jsonMatch({
      input: 'q',
      output: '{"b":2,"a":1}',
      expected: '{"a":1,"b":2}',
    });
    assert.strictEqual(result.score, 1.0);
  });

  it('returns 0.0 when output is invalid JSON', async () => {
    const result = await jsonMatch({
      input: 'q',
      output: 'not json',
      expected: '{"a":1}',
    });
    assert.strictEqual(result.score, 0.0);
    assert.strictEqual(result.reason, 'Failed to parse JSON');
  });
});

describe('all', () => {
  it('returns the minimum score across all scorers', async () => {
    const scorer = all(exactMatch, includes);
    const result = await scorer({
      input: 'q',
      output: 'hello world',
      expected: 'hello',
    });
    assert.strictEqual(result.score, 0.0);
  });
});

describe('any', () => {
  it('returns the maximum score across all scorers', async () => {
    const scorer = any(exactMatch, includes);
    const result = await scorer({
      input: 'q',
      output: 'hello world',
      expected: 'hello',
    });
    assert.strictEqual(result.score, 1.0);
  });
});

describe('weighted', () => {
  it('returns the weighted average of scorer results', async () => {
    const scorer = weighted({
      a: { scorer: exactMatch, weight: 2 },
      b: { scorer: includes, weight: 3 },
    });
    const result = await scorer({
      input: 'q',
      output: 'hello world',
      expected: 'hello',
    });
    const expectedScore = (0.0 * 2 + 1.0 * 3) / (2 + 3);
    assert.strictEqual(result.score, expectedScore);
  });
});
