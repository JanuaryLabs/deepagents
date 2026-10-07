import assert from 'node:assert';
import { describe, it } from 'node:test';
import { z } from 'zod';

import { BigQuery } from '@deepagents/text2sql/bigquery';
import { ClickHouse } from '@deepagents/text2sql/clickhouse';
import { DuckDB } from '@deepagents/text2sql/duckdb';
import { Mysql } from '@deepagents/text2sql/mysql';
import { Postgres } from '@deepagents/text2sql/postgres';
import { Sqlite } from '@deepagents/text2sql/sqlite';
import { SqlServer } from '@deepagents/text2sql/sqlserver';

const idRow = z.object({ id: z.number() });
const rows = [{ id: 1 }, { id: 2 }];

type Execute = () => Promise<unknown>;

/**
 * Each adapter with the result shapes its driver's execute() can return.
 * runQuery() reads the rows out of every accepted shape and rejects any
 * other result.
 */
const adapters: Array<{
  name: string;
  create: (execute: Execute) => { runQuery: Postgres['runQuery'] };
  accepts: Record<string, unknown>;
  rejects: Record<string, unknown>;
}> = [
  {
    name: 'Sqlite',
    create: (execute) => new Sqlite({ execute, grounding: [] }),
    accepts: { array: rows, '{ rows }': { rows } },
    rejects: {
      '{ data }': { data: rows },
      '{ recordset }': { recordset: rows },
    },
  },
  {
    name: 'Postgres',
    create: (execute) => new Postgres({ execute, grounding: [] }),
    accepts: { array: rows, '{ rows }': { rows } },
    rejects: {
      '{ data }': { data: rows },
      '{ recordset }': { recordset: rows },
    },
  },
  {
    name: 'BigQuery',
    create: (execute) =>
      new BigQuery({
        execute,
        validate: async () => {},
        datasets: ['analytics'],
        grounding: [],
      }),
    accepts: { array: rows, '{ rows }': { rows } },
    rejects: { '{ data }': { data: rows } },
  },
  {
    name: 'Mysql',
    create: (execute) => new Mysql({ execute, grounding: [] }),
    accepts: {
      array: rows,
      '{ rows }': { rows },
      '[rows, fields] from mysql2': [rows, [{ name: 'id' }]],
      '[rows]': [rows],
    },
    rejects: { '{ data }': { data: rows } },
  },
  {
    name: 'SqlServer',
    create: (execute) => new SqlServer({ execute, grounding: [] }),
    accepts: {
      array: rows,
      '{ rows }': { rows },
      '{ recordset }': { recordset: rows },
      '{ recordsets }': { recordsets: [rows] },
    },
    rejects: { '{ data }': { data: rows } },
  },
  {
    name: 'ClickHouse',
    create: (execute) =>
      new ClickHouse({ execute, validate: async () => {}, grounding: [] }),
    accepts: { array: rows, '{ data }': { data: rows }, '{ rows }': { rows } },
    rejects: { '{ recordset }': { recordset: rows } },
  },
  {
    name: 'DuckDB',
    create: (execute) => new DuckDB({ execute, grounding: [] }),
    accepts: { array: rows, '{ data }': { data: rows }, '{ rows }': { rows } },
    rejects: { '{ recordset }': { recordset: rows } },
  },
];

for (const { name, create, accepts, rejects } of adapters) {
  describe(`${name} runQuery`, () => {
    for (const [shape, result] of Object.entries(accepts)) {
      it(`reads the rows of ${shape}`, async () => {
        const adapter = create(async () => result);
        assert.deepStrictEqual(await adapter.runQuery('SELECT 1', idRow), rows);
      });
    }

    for (const [shape, result] of Object.entries({
      ...rejects,
      'a string': 'not rows',
    })) {
      it(`rejects ${shape}`, async () => {
        const adapter = create(async () => result);
        await assert.rejects(
          () => adapter.runQuery('SELECT 1', idRow),
          new RegExp(`${name}.*execute\\(\\) must return an array of rows`),
        );
      });
    }
  });
}
