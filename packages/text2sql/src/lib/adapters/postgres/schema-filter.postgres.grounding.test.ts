import { Docker, TestRun } from '@zukhruf/testing/docker';
import { Postgres as TestPostgres } from '@zukhruf/testing/postgres';
import assert from 'node:assert';
import { describe, it } from 'node:test';
import pg from 'pg';
import { z } from 'zod';

import {
  Postgres,
  type PostgresAdapterOptions,
  tables,
  views,
} from '@deepagents/text2sql/postgres';

const docker = new Docker({ testRun: TestRun.fromEnvironment(process.env) });

const testPostgres = new TestPostgres({ docker });

const named = z.object({ name: z.string() });

const twoSchemas = `
  CREATE SCHEMA sales;
  CREATE TABLE public.customers (id SERIAL PRIMARY KEY, name TEXT);
  CREATE TABLE sales.orders (id SERIAL PRIMARY KEY, total NUMERIC);
  CREATE VIEW public.customer_names AS SELECT name FROM public.customers;
  CREATE VIEW sales.order_totals AS SELECT total FROM sales.orders;`;

/** The names of the `kind` fragments a fresh database built from `twoSchemas` yields. */
async function introspected(
  kind: 'table' | 'view',
  options: Pick<PostgresAdapterOptions, 'grounding' | 'schemas'>,
): Promise<string[]> {
  await using container = await testPostgres.database();

  const pool = new pg.Pool({ connectionString: container.connectionString });
  try {
    await pool.query(twoSchemas);
    const adapter = new Postgres({
      execute: (sql: string) => pool.query(sql),
      ...options,
    });
    return (await adapter.introspect())
      .filter((fragment) => fragment.name === kind)
      .map((fragment) => named.parse(fragment.data).name)
      .sort();
  } finally {
    await pool.end();
  }
}

describe('Postgres schemas option', () => {
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
      ['public.customers', 'sales.orders'],
    );
  });

  it('limits discovered views to the listed schemas', async () => {
    assert.deepStrictEqual(
      await introspected('view', { grounding: [views()], schemas: ['sales'] }),
      ['sales.order_totals'],
    );
  });
});
