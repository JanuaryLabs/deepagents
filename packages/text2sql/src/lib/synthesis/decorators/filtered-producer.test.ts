import assert from 'node:assert';
import { describe, it } from 'node:test';

import {
  type ExtractedPair,
  FilteredProducer,
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
  sql: string,
  overrides: Partial<ExtractedPair> = {},
): ExtractedPair {
  return { question: `Q: ${sql}`, sql, success: true, ...overrides };
}

describe('FilteredProducer', () => {
  it('filters by exact table reference, not substring', async () => {
    const source = new StaticProducer([
      [
        pair('SELECT * FROM users'),
        pair("SELECT * FROM users_archive WHERE name = 'users'"),
      ],
    ]);

    const filtered = new FilteredProducer(source, {
      tables: ['users'],
      dialect: 'postgresql',
    });

    const results = await toPairs(filtered);
    assert.strictEqual(results.length, 1);
    assert.ok(results[0].sql.includes('FROM users'));
    assert.ok(!results[0].sql.includes('users_archive'));
  });

  it('table filter is case-insensitive', async () => {
    const source = new StaticProducer([
      [pair('SELECT * FROM Users'), pair('SELECT * FROM USERS')],
    ]);

    const filtered = new FilteredProducer(source, {
      tables: ['users'],
      dialect: 'postgresql',
    });

    const results = await toPairs(filtered);
    assert.strictEqual(results.length, 2);
  });

  it('rejects pairs that reference no matching table', async () => {
    const source = new StaticProducer([
      [pair('SELECT * FROM orders'), pair('SELECT * FROM users')],
    ]);

    const filtered = new FilteredProducer(source, {
      tables: ['users'],
      dialect: 'postgresql',
    });

    const results = await toPairs(filtered);
    assert.strictEqual(results.length, 1);
    assert.ok(results[0].sql.includes('users'));
  });

  it('falls back to string matching on unparseable SQL', async () => {
    const source = new StaticProducer([
      [pair('NOT VALID SQL %%% users'), pair('NOT VALID SQL %%% orders')],
    ]);

    const filtered = new FilteredProducer(source, {
      tables: ['users'],
      dialect: 'postgresql',
    });

    const results = await toPairs(filtered);
    assert.strictEqual(results.length, 1);
    assert.ok(results[0].sql.includes('users'));
  });

  it('filters unsuccessful pairs by default', async () => {
    const source = new StaticProducer([
      [
        pair('SELECT * FROM users', { success: false }),
        pair('SELECT * FROM users', { success: true }),
      ],
    ]);

    const filtered = new FilteredProducer(source, {});
    const results = await toPairs(filtered);
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].success, true);
  });

  it('keeps unsuccessful pairs when successOnly is false', async () => {
    const source = new StaticProducer([
      [pair('SELECT 1', { success: false }), pair('SELECT 2')],
    ]);

    const filtered = new FilteredProducer(source, { successOnly: false });
    const results = await toPairs(filtered);
    assert.strictEqual(results.length, 2);
  });

  it('applies custom filter predicate', async () => {
    const source = new StaticProducer([
      [pair('SELECT * FROM a'), pair('SELECT * FROM b')],
    ]);

    const filtered = new FilteredProducer(source, {
      filter: (p) => p.sql.includes('FROM a'),
    });

    const results = await toPairs(filtered);
    assert.strictEqual(results.length, 1);
  });

  it('does not yield empty chunks', async () => {
    const source = new StaticProducer([
      [pair('SELECT * FROM orders')],
      [pair('SELECT * FROM users')],
    ]);

    const filtered = new FilteredProducer(source, {
      tables: ['users'],
      dialect: 'postgresql',
    });

    const chunks: ExtractedPair[][] = [];
    for await (const chunk of filtered.produce()) {
      chunks.push(chunk);
    }
    assert.strictEqual(chunks.length, 1);
    assert.strictEqual(chunks[0].length, 1);
  });

  it('matches schema-qualified table filter against unqualified references', async () => {
    const source = new StaticProducer([
      [pair('SELECT * FROM users'), pair('SELECT * FROM orders')],
    ]);

    const filtered = new FilteredProducer(source, {
      tables: ['public.users'],
      dialect: 'postgresql',
    });

    const results = await toPairs(filtered);
    assert.strictEqual(results.length, 1);
    assert.ok(results[0].sql.includes('users'));
  });

  it('matches unqualified table filter against schema-qualified SQL', async () => {
    const source = new StaticProducer([
      [pair('SELECT * FROM public.users'), pair('SELECT * FROM orders')],
    ]);

    const filtered = new FilteredProducer(source, {
      tables: ['users'],
      dialect: 'postgresql',
    });

    const results = await toPairs(filtered);
    assert.strictEqual(results.length, 1);
    assert.ok(results[0].sql.includes('public.users'));
  });
});
