import assert from 'node:assert';
import { describe, it } from 'node:test';

import {
  DeduplicatedProducer,
  type ExtractedPair,
  PairProducer,
  toPairs,
} from '@deepagents/text2sql/synthesis';

class StaticProducer extends PairProducer {
  chunks: ExtractedPair[][];
  constructor(chunks: ExtractedPair[][]) {
    super();
    this.chunks = chunks;
  }
  async *produce() {
    for (const chunk of this.chunks) yield chunk;
  }
}

function pair(
  question: string,
  sql: string,
  overrides: Partial<ExtractedPair> = {},
): ExtractedPair {
  return { question, sql, success: true, ...overrides };
}

describe('DeduplicatedProducer', () => {
  it('sql-only deduplicates semantically identical SQL with different whitespace', async () => {
    const source = new StaticProducer([
      [
        pair('Q1', 'SELECT  id,  name  FROM  users'),
        pair('Q2', 'SELECT id, name FROM users'),
        pair('Q3', 'SELECT id,name FROM users'),
      ],
    ]);

    const dedup = new DeduplicatedProducer(source, {
      strategy: 'sql-only',
      dialect: 'postgresql',
    });

    const results = await toPairs(dedup);
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].question, 'Q1');
  });

  it('question-only deduplicates by question text', async () => {
    const source = new StaticProducer([
      [
        pair('Show users', 'SELECT * FROM users'),
        pair('Show users', 'SELECT id FROM users'),
        pair('Show orders', 'SELECT * FROM orders'),
      ],
    ]);

    const dedup = new DeduplicatedProducer(source, {
      strategy: 'question-only',
    });

    const results = await toPairs(dedup);
    assert.strictEqual(results.length, 2);
    assert.strictEqual(results[0].sql, 'SELECT * FROM users');
    assert.strictEqual(results[1].sql, 'SELECT * FROM orders');
  });

  it('exact strategy deduplicates by both question and SQL', async () => {
    const source = new StaticProducer([
      [
        pair('Show users', 'SELECT * FROM users'),
        pair('Show users', 'SELECT * FROM users'),
        pair('Show users', 'SELECT id FROM users'),
      ],
    ]);

    const dedup = new DeduplicatedProducer(source, {
      strategy: 'exact',
      dialect: 'postgresql',
    });

    const results = await toPairs(dedup);
    assert.strictEqual(results.length, 2);
  });

  it('falls back to whitespace normalization on unparseable SQL', async () => {
    const source = new StaticProducer([
      [pair('Q1', 'NOT VALID %%% stuff'), pair('Q2', 'NOT  VALID  %%%  stuff')],
    ]);

    const dedup = new DeduplicatedProducer(source, {
      strategy: 'sql-only',
      dialect: 'postgresql',
    });

    const results = await toPairs(dedup);
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].question, 'Q1');
  });

  it('first occurrence wins across chunks', async () => {
    const source = new StaticProducer([
      [pair('First', 'SELECT 1')],
      [pair('Second', 'SELECT 1')],
    ]);

    const dedup = new DeduplicatedProducer(source, {
      strategy: 'sql-only',
      dialect: 'postgresql',
    });

    const results = await toPairs(dedup);
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].question, 'First');
  });

  it('does not yield empty chunks after dedup', async () => {
    const source = new StaticProducer([
      [pair('Q1', 'SELECT 1')],
      [pair('Q2', 'SELECT 1')],
    ]);

    const dedup = new DeduplicatedProducer(source, {
      strategy: 'sql-only',
      dialect: 'postgresql',
    });

    const chunks: ExtractedPair[][] = [];
    for await (const chunk of dedup.produce()) {
      chunks.push(chunk);
    }
    assert.strictEqual(chunks.length, 1);
  });
});
