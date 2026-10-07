import { Docker, TestRun } from '@zukhruf/testing/docker';
import { Postgres as TestPostgres } from '@zukhruf/testing/postgres';
import assert from 'node:assert';
import { describe, it } from 'node:test';
import pg from 'pg';
import { z } from 'zod';

import { Postgres, tables } from '@deepagents/text2sql/postgres';

const docker = new Docker({ testRun: TestRun.fromEnvironment(process.env) });

const testPostgres = new TestPostgres({ docker });

const side = z.object({ table: z.string(), columns: z.array(z.string()) });
const relationshipData = z.object({ from: side, to: side });

type TablesConfig = Parameters<typeof tables>[0];

/** The relationships Postgres introspection reports for a fresh database built from `ddl`. */
async function relationships(
  ddl: string,
  config: TablesConfig,
): Promise<z.output<typeof relationshipData>[]> {
  await using container = await testPostgres.database();

  const pool = new pg.Pool({ connectionString: container.connectionString });
  try {
    await pool.query(ddl);
    const adapter = new Postgres({
      execute: (sql: string) => pool.query(sql),
      grounding: [tables(config)],
    });
    return (await adapter.introspect())
      .filter((fragment) => fragment.name === 'relationship')
      .map((fragment) => relationshipData.parse(fragment.data));
  } finally {
    await pool.end();
  }
}

const compositeKey = `
  CREATE TABLE warehouses (
    region TEXT,
    code TEXT,
    name TEXT,
    PRIMARY KEY (region, code)
  );
  CREATE TABLE inventory (
    id SERIAL PRIMARY KEY,
    wh_region TEXT,
    wh_code TEXT,
    FOREIGN KEY (wh_region, wh_code) REFERENCES warehouses (region, code)
  );`;

const inventoryToWarehouses = {
  from: { table: 'public.inventory', columns: ['wh_region', 'wh_code'] },
  to: { table: 'public.warehouses', columns: ['region', 'code'] },
};

describe('Postgres table grounding relationships', () => {
  it('pairs the columns of a composite foreign key by position', async () => {
    assert.deepStrictEqual(
      await relationships(compositeKey, {
        filter: ['public.inventory'],
        forward: true,
      }),
      [inventoryToWarehouses],
    );
  });

  it('pairs a composite foreign key by position when found from the referenced table', async () => {
    assert.deepStrictEqual(
      await relationships(compositeKey, {
        filter: ['public.warehouses'],
        backward: true,
      }),
      [inventoryToWarehouses],
    );
  });

  it('keeps the column order of a foreign key that lists the key columns in another order', async () => {
    // The foreign key's order (region, code) differs from the declaration
    // order of both tables and from the primary key's order (code, region).
    assert.deepStrictEqual(
      await relationships(
        `CREATE TABLE warehouses (
          code TEXT,
          region TEXT,
          PRIMARY KEY (code, region)
        );
        CREATE TABLE shipments (
          id SERIAL PRIMARY KEY,
          to_code TEXT,
          to_region TEXT,
          FOREIGN KEY (to_region, to_code) REFERENCES warehouses (region, code)
        );`,
        { filter: ['public.shipments'], forward: true },
      ),
      [
        {
          from: {
            table: 'public.shipments',
            columns: ['to_region', 'to_code'],
          },
          to: { table: 'public.warehouses', columns: ['region', 'code'] },
        },
      ],
    );
  });

  it('reports each foreign key of a table that references the same table twice', async () => {
    assert.deepStrictEqual(
      await relationships(
        `CREATE TABLE warehouses (
          region TEXT,
          code TEXT,
          PRIMARY KEY (region, code)
        );
        CREATE TABLE transfers (
          id SERIAL PRIMARY KEY,
          source_region TEXT,
          source_code TEXT,
          target_region TEXT,
          target_code TEXT,
          CONSTRAINT transfers_source FOREIGN KEY (source_region, source_code)
            REFERENCES warehouses (region, code),
          CONSTRAINT transfers_target FOREIGN KEY (target_region, target_code)
            REFERENCES warehouses (region, code)
        );`,
        { filter: ['public.transfers'], forward: true },
      ),
      [
        {
          from: {
            table: 'public.transfers',
            columns: ['source_region', 'source_code'],
          },
          to: { table: 'public.warehouses', columns: ['region', 'code'] },
        },
        {
          from: {
            table: 'public.transfers',
            columns: ['target_region', 'target_code'],
          },
          to: { table: 'public.warehouses', columns: ['region', 'code'] },
        },
      ],
    );
  });

  // archive.* repeats the public tables' names with its own foreign key.
  const sameNamesInAnotherSchema = `${compositeKey}
    CREATE SCHEMA archive;
    CREATE TABLE archive.warehouses (
      region TEXT,
      code TEXT,
      PRIMARY KEY (region, code)
    );
    CREATE TABLE archive.inventory (
      id SERIAL PRIMARY KEY,
      wh_region TEXT,
      wh_code TEXT,
      FOREIGN KEY (wh_region, wh_code) REFERENCES archive.warehouses (region, code)
    );`;

  it('reports only the foreign keys of the requested schema', async () => {
    assert.deepStrictEqual(
      await relationships(sameNamesInAnotherSchema, {
        filter: ['public.inventory'],
        forward: true,
      }),
      [inventoryToWarehouses],
    );
  });

  it('reports only the foreign keys into the requested schema when found from the referenced table', async () => {
    assert.deepStrictEqual(
      await relationships(sameNamesInAnotherSchema, {
        filter: ['public.warehouses'],
        backward: true,
      }),
      [inventoryToWarehouses],
    );
  });

  const crossSchema = `
    CREATE SCHEMA catalog;
    CREATE TABLE catalog.products (id INT PRIMARY KEY);
    CREATE TABLE orders (
      id SERIAL PRIMARY KEY,
      product_id INT REFERENCES catalog.products (id)
    );`;

  const ordersToProducts = {
    from: { table: 'public.orders', columns: ['product_id'] },
    to: { table: 'catalog.products', columns: ['id'] },
  };

  it('reports a foreign key to a table in another schema', async () => {
    assert.deepStrictEqual(
      await relationships(crossSchema, {
        filter: ['public.orders'],
        forward: true,
      }),
      [ordersToProducts],
    );
  });

  it('reports a foreign key from another schema when found from the referenced table', async () => {
    assert.deepStrictEqual(
      await relationships(crossSchema, {
        filter: ['catalog.products'],
        backward: true,
      }),
      [ordersToProducts],
    );
  });
});
