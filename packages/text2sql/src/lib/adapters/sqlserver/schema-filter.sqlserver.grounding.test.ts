import { Docker, TestRun } from '@zukhruf/testing/docker';
import { SqlServer as TestSqlServer } from '@zukhruf/testing/sqlserver';
import sql from 'mssql';
import assert from 'node:assert';
import { describe, it } from 'node:test';
import { z } from 'zod';

import {
  SqlServer,
  type SqlServerAdapterOptions,
  tables,
  views,
} from '@deepagents/text2sql/sqlserver';

const docker = new Docker({ testRun: TestRun.fromEnvironment(process.env) });

const testSqlServer = new TestSqlServer({ docker });

const named = z.object({ name: z.string() });

// T-SQL runs CREATE SCHEMA and CREATE VIEW alone in their batch.
const twoSchemas = [
  'CREATE SCHEMA sales',
  'CREATE TABLE dbo.customers (id INT PRIMARY KEY, name NVARCHAR(100))',
  'CREATE TABLE sales.orders (id INT PRIMARY KEY, total DECIMAL(10, 2))',
  'CREATE VIEW dbo.customer_names AS SELECT name FROM dbo.customers',
  'CREATE VIEW sales.order_totals AS SELECT total FROM sales.orders',
];

/** The names of the `kind` fragments a fresh database built from `twoSchemas` yields. */
async function introspected(
  kind: 'table' | 'view',
  options: Pick<SqlServerAdapterOptions, 'grounding' | 'schemas'>,
): Promise<string[]> {
  await using database = await testSqlServer.database();

  const pool = new sql.ConnectionPool(database.connectionString);
  await pool.connect();
  try {
    for (const statement of twoSchemas) {
      await pool.request().batch(statement);
    }
    const adapter = new SqlServer({
      execute: async (text: string) =>
        (await pool.request().query(text)).recordset ?? [],
      ...options,
    });
    return (await adapter.introspect())
      .filter((fragment) => fragment.name === kind)
      .map((fragment) => named.parse(fragment.data).name)
      .sort();
  } finally {
    await pool.close();
  }
}

describe('SQL Server schemas option', () => {
  it('limits discovered tables to the listed schemas', async () => {
    assert.deepStrictEqual(
      await introspected('table', {
        grounding: [tables()],
        schemas: ['sales'],
      }),
      ['sales.orders'],
    );
  });

  it('discovers tables in every schema when no schemas are listed', async () => {
    assert.deepStrictEqual(
      await introspected('table', { grounding: [tables()] }),
      ['dbo.customers', 'sales.orders'],
    );
  });

  it('limits discovered views to the listed schemas', async () => {
    assert.deepStrictEqual(
      await introspected('view', { grounding: [views()], schemas: ['sales'] }),
      ['sales.order_totals'],
    );
  });
});
