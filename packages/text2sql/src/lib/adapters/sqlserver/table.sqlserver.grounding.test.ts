import { Docker, TestRun } from '@zukhruf/testing/docker';
import { SqlServer as TestSqlServer } from '@zukhruf/testing/sqlserver';
import sql from 'mssql';
import assert from 'node:assert';
import { describe, it } from 'node:test';
import { z } from 'zod';

import { SqlServer, tables } from '@deepagents/text2sql/sqlserver';

const docker = new Docker({ testRun: TestRun.fromEnvironment(process.env) });

const testSqlServer = new TestSqlServer({ docker });

const side = z.object({ table: z.string(), columns: z.array(z.string()) });
const relationshipData = z.object({ from: side, to: side });

type TablesConfig = Parameters<typeof tables>[0];

/**
 * The relationships SQL Server introspection reports for a fresh database
 * built from `ddl`. T-SQL runs CREATE SCHEMA alone in its batch, so each
 * statement is its own batch.
 */
async function relationships(
  ddl: string[],
  config: TablesConfig,
): Promise<z.output<typeof relationshipData>[]> {
  await using database = await testSqlServer.database();

  const pool = new sql.ConnectionPool(database.connectionString);
  await pool.connect();
  try {
    for (const statement of ddl) {
      await pool.request().batch(statement);
    }
    const adapter = new SqlServer({
      execute: async (text: string) =>
        (await pool.request().query(text)).recordset ?? [],
      grounding: [tables(config)],
    });
    return (await adapter.introspect())
      .filter((fragment) => fragment.name === 'relationship')
      .map((fragment) => relationshipData.parse(fragment.data));
  } finally {
    await pool.close();
  }
}

const compositeKey = [
  `CREATE TABLE warehouses (
    region NVARCHAR(20),
    code NVARCHAR(20),
    name NVARCHAR(100),
    CONSTRAINT PK_warehouses PRIMARY KEY (region, code)
  )`,
  `CREATE TABLE inventory (
    id INT PRIMARY KEY,
    wh_region NVARCHAR(20),
    wh_code NVARCHAR(20),
    CONSTRAINT FK_inventory_warehouses FOREIGN KEY (wh_region, wh_code)
      REFERENCES warehouses (region, code)
  )`,
];

const inventoryToWarehouses = {
  from: { table: 'dbo.inventory', columns: ['wh_region', 'wh_code'] },
  to: { table: 'dbo.warehouses', columns: ['region', 'code'] },
};

describe('SQL Server table grounding relationships', () => {
  // archive.* repeats the dbo tables and their constraint names. SQL Server
  // keeps constraint names unique per schema only.
  const sameNamesInAnotherSchema = [
    ...compositeKey,
    'CREATE SCHEMA archive',
    `CREATE TABLE archive.warehouses (
      region NVARCHAR(20),
      code NVARCHAR(20),
      CONSTRAINT PK_warehouses PRIMARY KEY (region, code)
    )`,
    `CREATE TABLE archive.inventory (
      id INT PRIMARY KEY,
      wh_region NVARCHAR(20),
      wh_code NVARCHAR(20),
      CONSTRAINT FK_inventory_warehouses FOREIGN KEY (wh_region, wh_code)
        REFERENCES archive.warehouses (region, code)
    )`,
  ];

  it('reports only the foreign keys of the requested schema when another schema repeats the constraint names', async () => {
    assert.deepStrictEqual(
      await relationships(sameNamesInAnotherSchema, {
        filter: ['dbo.inventory'],
        forward: true,
      }),
      [inventoryToWarehouses],
    );
  });

  it('reports only the foreign keys into the requested schema when another schema repeats the constraint names', async () => {
    assert.deepStrictEqual(
      await relationships(sameNamesInAnotherSchema, {
        filter: ['dbo.warehouses'],
        backward: true,
      }),
      [inventoryToWarehouses],
    );
  });

  // The foreign keys reference a plain unique index (CREATE UNIQUE INDEX),
  // not a UNIQUE or PRIMARY KEY constraint. archive.* repeats the table and
  // index names.
  const uniqueIndexKey = [
    'CREATE TABLE products (id INT PRIMARY KEY, sku NVARCHAR(20) NOT NULL)',
    'CREATE UNIQUE INDEX UX_products_sku ON products (sku)',
    `CREATE TABLE order_lines (
      id INT PRIMARY KEY,
      sku NVARCHAR(20),
      CONSTRAINT FK_order_lines_products FOREIGN KEY (sku)
        REFERENCES products (sku)
    )`,
    'CREATE SCHEMA archive',
    'CREATE TABLE archive.products (id INT PRIMARY KEY, sku NVARCHAR(20) NOT NULL)',
    'CREATE UNIQUE INDEX UX_products_sku ON archive.products (sku)',
    `CREATE TABLE archive.order_lines (
      id INT PRIMARY KEY,
      sku NVARCHAR(20),
      CONSTRAINT FK_order_lines_products FOREIGN KEY (sku)
        REFERENCES archive.products (sku)
    )`,
  ];

  const orderLinesToProducts = {
    from: { table: 'dbo.order_lines', columns: ['sku'] },
    to: { table: 'dbo.products', columns: ['sku'] },
  };

  it('reports a foreign key that references a unique index', async () => {
    assert.deepStrictEqual(
      await relationships(uniqueIndexKey, {
        filter: ['dbo.order_lines'],
        forward: true,
      }),
      [orderLinesToProducts],
    );
  });

  it('reports a foreign key that references a unique index when found from the referenced table', async () => {
    assert.deepStrictEqual(
      await relationships(uniqueIndexKey, {
        filter: ['dbo.products'],
        backward: true,
      }),
      [orderLinesToProducts],
    );
  });

  it('pairs the columns of a composite foreign key by position', async () => {
    assert.deepStrictEqual(
      await relationships(compositeKey, {
        filter: ['dbo.inventory'],
        forward: true,
      }),
      [inventoryToWarehouses],
    );
  });

  it('pairs a composite foreign key by position when found from the referenced table', async () => {
    assert.deepStrictEqual(
      await relationships(compositeKey, {
        filter: ['dbo.warehouses'],
        backward: true,
      }),
      [inventoryToWarehouses],
    );
  });

  it('reports each foreign key of a table that references the same table twice', async () => {
    assert.deepStrictEqual(
      await relationships(
        [
          `CREATE TABLE warehouses (
            region NVARCHAR(20),
            code NVARCHAR(20),
            CONSTRAINT PK_warehouses PRIMARY KEY (region, code)
          )`,
          `CREATE TABLE transfers (
            id INT PRIMARY KEY,
            source_region NVARCHAR(20),
            source_code NVARCHAR(20),
            target_region NVARCHAR(20),
            target_code NVARCHAR(20),
            CONSTRAINT transfers_source FOREIGN KEY (source_region, source_code)
              REFERENCES warehouses (region, code),
            CONSTRAINT transfers_target FOREIGN KEY (target_region, target_code)
              REFERENCES warehouses (region, code)
          )`,
        ],
        { filter: ['dbo.transfers'], forward: true },
      ),
      [
        {
          from: {
            table: 'dbo.transfers',
            columns: ['source_region', 'source_code'],
          },
          to: { table: 'dbo.warehouses', columns: ['region', 'code'] },
        },
        {
          from: {
            table: 'dbo.transfers',
            columns: ['target_region', 'target_code'],
          },
          to: { table: 'dbo.warehouses', columns: ['region', 'code'] },
        },
      ],
    );
  });

  const crossSchema = [
    'CREATE SCHEMA catalog',
    'CREATE TABLE catalog.products (id INT PRIMARY KEY)',
    `CREATE TABLE orders (
      id INT PRIMARY KEY,
      product_id INT REFERENCES catalog.products (id)
    )`,
  ];

  const ordersToProducts = {
    from: { table: 'dbo.orders', columns: ['product_id'] },
    to: { table: 'catalog.products', columns: ['id'] },
  };

  it('reports a foreign key to a table in another schema', async () => {
    assert.deepStrictEqual(
      await relationships(crossSchema, {
        filter: ['dbo.orders'],
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
