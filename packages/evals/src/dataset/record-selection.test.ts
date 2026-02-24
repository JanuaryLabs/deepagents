import assert from 'node:assert';
import { describe, it } from 'node:test';

import { dataset } from '@deepagents/evals/dataset';

import {
  filterRecordsByIndex,
  parseRecordSelection,
  pickFromArray,
} from './record-selection.ts';

describe('parseRecordSelection', () => {
  it('empty string returns empty set', () => {
    const result = parseRecordSelection('');
    assert.strictEqual(result.indexes.size, 0);
    assert.strictEqual(result.normalized, '');
  });

  it('whitespace-only returns empty set', () => {
    const result = parseRecordSelection('   ');
    assert.strictEqual(result.indexes.size, 0);
  });

  it('single number parses to 0-based index', () => {
    const result = parseRecordSelection('3');
    assert.deepStrictEqual(result.indexes, new Set([2]));
    assert.strictEqual(result.normalized, '3');
  });

  it('range expands to 0-based indexes', () => {
    const result = parseRecordSelection('2-5');
    assert.deepStrictEqual(result.indexes, new Set([1, 2, 3, 4]));
    assert.strictEqual(result.normalized, '2,3,4,5');
  });

  it('mixed single and range values', () => {
    const result = parseRecordSelection('1,3,5-8');
    assert.deepStrictEqual(result.indexes, new Set([0, 2, 4, 5, 6, 7]));
    assert.strictEqual(result.normalized, '1,3,5,6,7,8');
  });

  it('deduplicates overlapping values', () => {
    const result = parseRecordSelection('3,2-4');
    assert.deepStrictEqual(result.indexes, new Set([1, 2, 3]));
    assert.strictEqual(result.normalized, '2,3,4');
  });

  it('throws on invalid token', () => {
    assert.throws(() => parseRecordSelection('abc'), /Invalid record token/);
  });

  it('throws on reversed range', () => {
    assert.throws(
      () => parseRecordSelection('5-2'),
      /Range end must be >= range start/,
    );
  });

  it('throws on zero', () => {
    assert.throws(
      () => parseRecordSelection('0'),
      /Record numbers must be >= 1/,
    );
  });
});

describe('pickFromArray', () => {
  it('empty set returns all items', () => {
    const items = ['a', 'b', 'c'];
    assert.deepStrictEqual(pickFromArray(items, new Set()), items);
  });

  it('filters to specified indexes', () => {
    const items = ['a', 'b', 'c', 'd', 'e'];
    const result = pickFromArray(items, new Set([0, 2, 4]));
    assert.deepStrictEqual(result, ['a', 'c', 'e']);
  });

  it('out-of-range indexes are silently skipped', () => {
    const items = ['a', 'b'];
    const result = pickFromArray(items, new Set([0, 5, 10]));
    assert.deepStrictEqual(result, ['a']);
  });
});

describe('filterRecordsByIndex', () => {
  async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
    const result: T[] = [];
    for await (const item of source) result.push(item);
    return result;
  }

  it('empty set yields all items', async () => {
    const source = dataset([1, 2, 3]);
    const result = await collect(filterRecordsByIndex(source, new Set()));
    assert.deepStrictEqual(result, [1, 2, 3]);
  });

  it('filters to specified indexes', async () => {
    const source = dataset(['a', 'b', 'c', 'd', 'e']);
    const result = await collect(filterRecordsByIndex(source, new Set([1, 3])));
    assert.deepStrictEqual(result, ['b', 'd']);
  });

  it('out-of-range indexes are silently skipped', async () => {
    const source = dataset([10, 20, 30]);
    const result = await collect(
      filterRecordsByIndex(source, new Set([0, 10])),
    );
    assert.deepStrictEqual(result, [10]);
  });
});

describe('Dataset.pick', () => {
  it('empty set yields all items', async () => {
    const result = await dataset([1, 2, 3]).pick(new Set()).toArray();
    assert.deepStrictEqual(result, [1, 2, 3]);
  });

  it('picks specific indexes', async () => {
    const result = await dataset(['a', 'b', 'c', 'd'])
      .pick(new Set([0, 3]))
      .toArray();
    assert.deepStrictEqual(result, ['a', 'd']);
  });

  it('out-of-range indexes are silently skipped', async () => {
    const result = await dataset([1, 2])
      .pick(new Set([0, 5]))
      .toArray();
    assert.deepStrictEqual(result, [1]);
  });

  it('chains with other Dataset methods', async () => {
    const result = await dataset([10, 20, 30, 40, 50])
      .pick(new Set([1, 2, 4]))
      .map((n) => n * 2)
      .toArray();
    assert.deepStrictEqual(result, [40, 60, 100]);
  });

  it('integrates with parseRecordSelection', async () => {
    const { indexes } = parseRecordSelection('2,4-5');
    const result = await dataset(['a', 'b', 'c', 'd', 'e'])
      .pick(indexes)
      .toArray();
    assert.deepStrictEqual(result, ['b', 'd', 'e']);
  });
});
