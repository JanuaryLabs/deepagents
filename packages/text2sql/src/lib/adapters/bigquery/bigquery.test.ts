import assert from 'node:assert';
import { describe, it } from 'node:test';

import { BigQuery } from '@deepagents/text2sql/bigquery';

describe('BigQuery adapter class', () => {
  const validOpts = {
    execute: async () => [],
    validate: async () => undefined as void,
    datasets: ['analytics'],
    grounding: [],
  };

  describe('constructor validation', () => {
    it('throws when execute is missing', () => {
      assert.throws(
        () => new BigQuery({ ...validOpts, execute: undefined as any }),
        /requires an execute/,
      );
    });

    it('throws when validate is missing', () => {
      assert.throws(
        () => new BigQuery({ ...validOpts, validate: undefined as any }),
        /requires a validate/,
      );
    });

    it('throws when datasets is empty', () => {
      assert.throws(
        () => new BigQuery({ ...validOpts, datasets: [] }),
        /non-empty datasets/,
      );
    });

    it('trims whitespace from dataset names', () => {
      const adapter = new BigQuery({
        ...validOpts,
        datasets: ['  analytics  '],
      });
      assert.deepStrictEqual(adapter.datasets, ['analytics']);
    });

    it('filters empty-string datasets after trim', () => {
      assert.throws(
        () => new BigQuery({ ...validOpts, datasets: ['  ', ''] }),
        /non-empty datasets/,
      );
    });
  });

  describe('defaultSchema', () => {
    it('returns the dataset name when exactly one dataset', () => {
      const adapter = new BigQuery({ ...validOpts, datasets: ['analytics'] });
      assert.strictEqual(adapter.defaultSchema, 'analytics');
    });

    it('returns undefined when multiple datasets', () => {
      const adapter = new BigQuery({ ...validOpts, datasets: ['a', 'b'] });
      assert.strictEqual(adapter.defaultSchema, undefined);
    });
  });

  describe('infoSchemaView', () => {
    it('builds unqualified path without projectId', () => {
      const adapter = new BigQuery({ ...validOpts });
      assert.strictEqual(
        adapter.infoSchemaView('analytics', 'TABLES'),
        '`analytics.INFORMATION_SCHEMA.TABLES`',
      );
    });

    it('builds project-qualified path with projectId', () => {
      const adapter = new BigQuery({ ...validOpts, projectId: 'my-project' });
      assert.strictEqual(
        adapter.infoSchemaView('analytics', 'COLUMNS'),
        '`my-project.analytics.INFORMATION_SCHEMA.COLUMNS`',
      );
    });
  });

  describe('runQuery', () => {
    it('returns rows directly when execute returns an array', async () => {
      const rows = [{ id: 1 }, { id: 2 }];
      const adapter = new BigQuery({ ...validOpts, execute: async () => rows });
      const result = await adapter.runQuery('SELECT 1');
      assert.deepStrictEqual(result, rows);
    });

    it('unwraps rows when execute returns {rows:[...]}', async () => {
      const rows = [{ id: 1 }];
      const adapter = new BigQuery({
        ...validOpts,
        execute: async () => ({ rows }),
      });
      const result = await adapter.runQuery('SELECT 1');
      assert.deepStrictEqual(result, rows);
    });

    it('throws when execute returns neither array nor {rows:[...]}', async () => {
      const adapter = new BigQuery({
        ...validOpts,
        execute: async () => 'bad',
      });
      await assert.rejects(
        () => adapter.runQuery('SELECT 1'),
        /must return an array of rows/,
      );
    });
  });

  describe('validate', () => {
    it('returns undefined on successful validation', async () => {
      const adapter = new BigQuery({ ...validOpts });
      const result = await adapter.validate('SELECT 1');
      assert.strictEqual(result, undefined);
    });

    it('formats Error instances into structured JSON', async () => {
      const adapter = new BigQuery({
        ...validOpts,
        validate: async () => {
          throw new Error('syntax error at position 5');
        },
      });
      const result = await adapter.validate('SELECT bad');
      assert.ok(typeof result === 'string');
      const parsed = JSON.parse(result as string);
      assert.strictEqual(parsed.error, 'syntax error at position 5');
      assert.strictEqual(parsed.error_type, 'BIGQUERY_ERROR');
      assert.strictEqual(parsed.sql_attempted, adapter.format('SELECT bad'));
    });

    it('formats string errors', async () => {
      const adapter = new BigQuery({
        ...validOpts,
        validate: async () => {
          throw 'raw string error';
        },
      });
      const result = await adapter.validate('SELECT x');
      const parsed = JSON.parse(result as string);
      assert.strictEqual(parsed.error, 'raw string error');
    });

    it('formats object errors with message property', async () => {
      const adapter = new BigQuery({
        ...validOpts,
        validate: async () => {
          throw { message: 'obj error' };
        },
      });
      const result = await adapter.validate('SELECT x');
      const parsed = JSON.parse(result as string);
      assert.strictEqual(parsed.error, 'obj error');
    });
  });

  describe('quoteIdentifier', () => {
    it('wraps simple name in backticks', () => {
      const adapter = new BigQuery({ ...validOpts });
      assert.strictEqual(adapter.quoteIdentifier('orders'), '`orders`');
    });

    it('splits dotted paths and wraps each segment', () => {
      const adapter = new BigQuery({ ...validOpts });
      assert.strictEqual(
        adapter.quoteIdentifier('analytics.orders'),
        '`analytics`.`orders`',
      );
    });

    it('escapes backticks within segment names', () => {
      const adapter = new BigQuery({ ...validOpts });
      assert.strictEqual(adapter.quoteIdentifier('my`table'), '`my``table`');
    });
  });

  describe('buildSampleRowsQuery', () => {
    it('builds query without projectId', () => {
      const adapter = new BigQuery({ ...validOpts });
      const sql = adapter.buildSampleRowsQuery(
        'analytics.orders',
        undefined,
        10,
      );
      assert.strictEqual(sql, 'SELECT * FROM `analytics`.`orders` LIMIT 10');
    });

    it('builds query with projectId', () => {
      const adapter = new BigQuery({ ...validOpts, projectId: 'proj' });
      const sql = adapter.buildSampleRowsQuery(
        'analytics.orders',
        undefined,
        5,
      );
      assert.strictEqual(
        sql,
        'SELECT * FROM `proj`.`analytics`.`orders` LIMIT 5',
      );
    });

    it('uses specific columns when provided', () => {
      const adapter = new BigQuery({ ...validOpts });
      const sql = adapter.buildSampleRowsQuery(
        'analytics.orders',
        ['id', 'name'],
        10,
      );
      assert.strictEqual(
        sql,
        'SELECT `id`, `name` FROM `analytics`.`orders` LIMIT 10',
      );
    });

    it('does not double-qualify when tableName already has 3 segments', () => {
      const adapter = new BigQuery({ ...validOpts, projectId: 'proj' });
      const sql = adapter.buildSampleRowsQuery(
        'proj.analytics.orders',
        undefined,
        10,
      );
      assert.strictEqual(
        sql,
        'SELECT * FROM `proj`.`analytics`.`orders` LIMIT 10',
      );
    });
  });
});
