import assert from 'node:assert';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { Dataset, dataset } from '@deepagents/evals/dataset';

describe('dataset', () => {
  const tempDirs: string[] = [];

  async function makeTempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'evals-dataset-'));
    tempDirs.push(dir);
    return dir;
  }

  after(async () => {
    await Promise.all(
      tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it('inline array yields all elements in order', async () => {
    const items = [1, 2, 3, 4, 5];
    const ds = dataset(items);
    const result: number[] = [];
    for await (const item of ds) {
      result.push(item);
    }
    assert.deepStrictEqual(result, [1, 2, 3, 4, 5]);
  });

  it('JSON file loads correctly', async () => {
    const dir = await makeTempDir();
    const filePath = join(dir, 'data.json');
    const data = [
      { id: 1, name: 'alice' },
      { id: 2, name: 'bob' },
    ];
    await writeFile(filePath, JSON.stringify(data));

    const result = await dataset<{ id: number; name: string }>(
      filePath,
    ).toArray();
    assert.deepStrictEqual(result, data);
  });

  it('JSONL file loads correctly', async () => {
    const dir = await makeTempDir();
    const filePath = join(dir, 'data.jsonl');
    const lines = [
      JSON.stringify({ q: 'hello', a: 'world' }),
      JSON.stringify({ q: 'foo', a: 'bar' }),
      '',
      JSON.stringify({ q: 'baz', a: 'qux' }),
    ];
    await writeFile(filePath, lines.join('\n'));

    const result = await dataset<{ q: string; a: string }>(filePath).toArray();
    assert.deepStrictEqual(result, [
      { q: 'hello', a: 'world' },
      { q: 'foo', a: 'bar' },
      { q: 'baz', a: 'qux' },
    ]);
  });

  it('CSV file loads with headers', async () => {
    const dir = await makeTempDir();
    const filePath = join(dir, 'data.csv');
    const csv = ['name,age,city', 'alice,30,nyc', 'bob,25,sf'].join('\n');
    await writeFile(filePath, csv);

    const result = await dataset(filePath).toArray();
    assert.deepStrictEqual(result, [
      { name: 'alice', age: '30', city: 'nyc' },
      { name: 'bob', age: '25', city: 'sf' },
    ]);
  });

  it('map transforms elements', async () => {
    const ds = dataset([1, 2, 3]).map((n) => n * 10);
    const result = await ds.toArray();
    assert.deepStrictEqual(result, [10, 20, 30]);
  });

  it('filter excludes elements', async () => {
    const ds = dataset([1, 2, 3, 4, 5, 6]).filter((n) => n % 2 === 0);
    const result = await ds.toArray();
    assert.deepStrictEqual(result, [2, 4, 6]);
  });

  it('limit caps output', async () => {
    const ds = dataset([10, 20, 30, 40, 50]).limit(3);
    const result = await ds.toArray();
    assert.deepStrictEqual(result, [10, 20, 30]);
  });

  it('shuffle yields all elements with same length and same set', async () => {
    const original = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const ds = dataset(original).shuffle();
    const result = await ds.toArray();

    assert.strictEqual(result.length, original.length);
    assert.deepStrictEqual(
      [...result].sort((a, b) => a - b),
      original,
    );
  });

  it('sample(n) yields exactly n elements', async () => {
    const original = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const n = 4;
    const ds = dataset(original).sample(n);
    const result = await ds.toArray();

    assert.strictEqual(result.length, n);
    for (const item of result) {
      assert.ok(
        original.includes(item),
        `sampled item ${item} not in original`,
      );
    }
    const unique = new Set(result);
    assert.strictEqual(unique.size, n, 'sampled items should be unique');
  });

  it('chaining: dataset().filter().map().limit() works', async () => {
    const ds = dataset([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
      .filter((n) => n > 3)
      .map((n) => n * 2)
      .limit(5);

    const result = await ds.toArray();
    assert.deepStrictEqual(result, [8, 10, 12, 14, 16]);
  });

  it('nonexistent file throws with path in error message', async () => {
    const fakePath = '/tmp/nonexistent-evals-dataset/missing.json';
    const ds = dataset(fakePath);
    await assert.rejects(
      async () => ds.toArray(),
      (err: Error) => {
        assert.ok(
          err.message.includes(fakePath) || err.message.includes('nonexistent'),
          `expected path in error but got: ${err.message}`,
        );
        return true;
      },
    );
  });

  it('toArray() collects all elements', async () => {
    const items = ['a', 'b', 'c', 'd'];
    const result = await dataset(items).toArray();
    assert.deepStrictEqual(result, items);
    assert.ok(Array.isArray(result));
  });
});
