import assert from 'node:assert';
import { describe, it } from 'node:test';
import pg from 'pg';

import { withPostgresContainer } from '@deepagents/test';
import {
  Postgres,
  columnValues,
  constraints,
  tables,
} from '@deepagents/text2sql/postgres';

type ColumnData = { name: string; values?: string[] };
type ColumnFragment = { name: 'column'; data: ColumnData };
type TableFragmentData = { name: string; columns: ColumnFragment[] };
type Fragment = { name: string; data?: unknown };

function findColumn(
  fragments: readonly Fragment[],
  tableName: string,
  columnName: string,
): ColumnData | undefined {
  const tableFragment = fragments.find(
    (f) =>
      f.name === 'table' &&
      (f.data as TableFragmentData)?.name === `public.${tableName}`,
  );
  return (tableFragment?.data as TableFragmentData | undefined)?.columns.find(
    (c) => c.data.name === columnName,
  )?.data;
}

async function withPgAdapter(
  ddl: string,
  fn: (fragments: readonly Fragment[]) => Promise<void>,
): Promise<void> {
  await withPostgresContainer(async (container) => {
    const pool = new pg.Pool({
      connectionString: container.connectionString,
    });
    try {
      await pool.query(ddl);
      const adapter = new Postgres({
        execute: (sql: string) => pool.query(sql),
        grounding: [tables(), constraints(), columnValues()],
      });
      await fn(await adapter.introspect());
    } finally {
      await pool.end();
    }
  });
}

describe('PostgresColumnValuesGrounding', () => {
  it('extracts enum values from CHECK (col IN (...)) normalized to ANY(ARRAY[...])', async () => {
    await withPgAdapter(
      `CREATE TABLE tasks (
        id SERIAL PRIMARY KEY,
        status TEXT CHECK (status IN ('todo', 'in_progress', 'done'))
      )`,
      async (fragments) => {
        const status = findColumn(fragments, 'tasks', 'status');
        assert.ok(status, 'tasks.status column should be present in fragments');
        assert.deepStrictEqual(status.values, ['todo', 'in_progress', 'done']);
      },
    );
  });

  it('extracts enum values from CHECK with OR-chained equality', async () => {
    await withPgAdapter(
      `CREATE TABLE flags (
        id SERIAL PRIMARY KEY,
        state TEXT CHECK (state = 'on' OR state = 'off' OR state = 'auto')
      )`,
      async (fragments) => {
        const state = findColumn(fragments, 'flags', 'state');
        assert.ok(state, 'flags.state column should be present in fragments');
        assert.deepStrictEqual(state.values, ['on', 'off', 'auto']);
      },
    );
  });

  it('does not produce values for non-enum CHECK shapes (numeric range)', async () => {
    await withPgAdapter(
      `CREATE TABLE people (
        id SERIAL PRIMARY KEY,
        age INTEGER CHECK (age >= 0 AND age <= 150)
      )`,
      async (fragments) => {
        const age = findColumn(fragments, 'people', 'age');
        assert.ok(age, 'people.age column should be present in fragments');
        assert.strictEqual(age.values, undefined);
      },
    );
  });
});
