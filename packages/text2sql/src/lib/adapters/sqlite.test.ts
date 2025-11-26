import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import type { Table } from './adapter.ts';
import { Sqlite, type SqliteAdapterOptions } from './sqlite.ts';

test('getTables should return table names and columns from a real sqlite database', async () => {
  const ddl = [
    `CREATE TABLE A(id INTEGER PRIMARY KEY, value TEXT);`,
    `CREATE TABLE B(id INTEGER PRIMARY KEY);`,
  ];

  const { adapter, db } = await init_db(ddl);
  try {
    const tables = (await adapter.getTables()) as Table[];

    assert.equal(tables.length, 2);
    assert.deepEqual(
      tables.map((t: Table) => t.name),
      ['A', 'B'],
    );
    const aTable = tables.find((t) => t.name === 'A');
    if (!aTable) throw new Error('expected table A to be present');
    assert.deepEqual(
      aTable.columns.map((c) => c.name),
      ['id', 'value'],
    );
    assert.equal(aTable.columns[0].isPrimaryKey, true);
  } finally {
    db.close();
  }
});

test('resolveTables should include related tables via foreign_key_list using a real sqlite db', async () => {
  const ddl = [
    `CREATE TABLE C(id INTEGER PRIMARY KEY);`,
    `CREATE TABLE B(id INTEGER PRIMARY KEY, c_id INTEGER, FOREIGN KEY(c_id) REFERENCES C(id));`,
    `CREATE TABLE A(id INTEGER PRIMARY KEY, b_id INTEGER, FOREIGN KEY(b_id) REFERENCES B(id));`,
    `CREATE TABLE D(id INTEGER PRIMARY KEY);`,
  ];

  const { adapter, db } = await init_db(ddl);
  try {
    const resolvedForA = await adapter.resolveTables(['A']);
    const resolvedForD = await adapter.resolveTables(['D']);

    assert.deepEqual(new Set(resolvedForA), new Set(['A', 'B', 'C']));
    assert.deepEqual(resolvedForD, ['D']);
  } finally {
    db.close();
  }
});

test('resolveTables accepts RegExp and returns empty for no matches using a real sqlite db', async () => {
  const ddl = [
    `CREATE TABLE Customer(id INTEGER PRIMARY KEY);`,
    `CREATE TABLE "Order"(id INTEGER PRIMARY KEY);`,
  ];

  const { adapter, db } = await init_db(ddl);
  try {
    const matches = await adapter.resolveTables(/Cust/);
    assert.deepEqual(matches, ['Customer']);

    const none = await adapter.resolveTables(/NoSuchTable/);
    assert.deepEqual(none, []);
  } finally {
    db.close();
  }
});

test('tables option filters tables and relationships', async () => {
  const ddl = [
    `CREATE TABLE Agreement(id INTEGER PRIMARY KEY, customer_id INTEGER, FOREIGN KEY(customer_id) REFERENCES Customer(id));`,
    `CREATE TABLE Customer(id INTEGER PRIMARY KEY);`,
    `CREATE TABLE AuditLog(id INTEGER PRIMARY KEY);`,
  ];

  const { adapter, db } = await init_db(ddl, {
    tables: /Agreement/,
  });

  try {
    const tables = (await adapter.getTables()) as Table[];
    assert.deepEqual(
      new Set(tables.map((t) => t.name)),
      new Set(['Agreement', 'Customer']),
    );

    const relationships = await adapter.getRelationships(
      tables.map((t) => t.name),
    );
    assert.equal(relationships.length, 1);
    assert.deepEqual(relationships[0], {
      table: 'Agreement',
      from: ['customer_id'],
      referenced_table: 'Customer',
      to: ['id'],
    });
  } finally {
    db.close();
  }
});

test('tables option keeps connected tables even if they do not directly match', async () => {
  const ddl = [
    `CREATE TABLE A(id INTEGER PRIMARY KEY, b_id INTEGER, FOREIGN KEY(b_id) REFERENCES B(id));`,
    `CREATE TABLE B(id INTEGER PRIMARY KEY);`,
  ];

  const { adapter, db } = await init_db(ddl, { tables: ['A'] });

  try {
    const tables = (await adapter.getTables()) as Table[];
    assert.deepEqual(new Set(tables.map((t) => t.name)), new Set(['A', 'B']));

    const relationships = await adapter.getRelationships(
      tables.map((t) => t.name),
    );
    assert.deepEqual(relationships, [
      {
        table: 'A',
        from: ['b_id'],
        referenced_table: 'B',
        to: ['id'],
      },
    ]);
  } finally {
    db.close();
  }
});

test('tables regex seed pulls entire chain of related tables (Customer -> Order -> Product -> AuditLog)', async () => {
  const ddl = [
    `CREATE TABLE Customer(id INTEGER PRIMARY KEY);`,
    `CREATE TABLE "Order"(id INTEGER PRIMARY KEY, customer_id INTEGER, FOREIGN KEY(customer_id) REFERENCES Customer(id));`,
    `CREATE TABLE Product(id INTEGER PRIMARY KEY, order_id INTEGER, FOREIGN KEY(order_id) REFERENCES "Order"(id));`,
    `CREATE TABLE AuditLog(id INTEGER PRIMARY KEY, product_id INTEGER, FOREIGN KEY(product_id) REFERENCES Product(id));`,
    `CREATE TABLE Unrelated(id INTEGER PRIMARY KEY);`,
  ];

  const { adapter, db } = await init_db(ddl, { tables: /Customer/ });
  try {
    const tables = await adapter.getTables();
    assert.deepEqual(
      new Set(tables.map((t) => t.name)),
      new Set(['Customer', 'Order', 'Product', 'AuditLog']),
    );

    const relationships = await adapter.getRelationships(
      tables.map((t) => t.name),
    );
    const edges = relationships.map((r) => `${r.table}->${r.referenced_table}`);
    assert.deepEqual(
      new Set(edges),
      new Set([
        'Order->Customer',
        'Product->Order',
        'AuditLog->Product',
      ]),
    );
  } finally {
    db.close();
  }
});

test('tables list seed merges multiple connected components', async () => {
  const ddl = [
    `CREATE TABLE A(id INTEGER PRIMARY KEY, b_id INTEGER, FOREIGN KEY(b_id) REFERENCES B(id));`,
    `CREATE TABLE B(id INTEGER PRIMARY KEY, c_id INTEGER, FOREIGN KEY(c_id) REFERENCES C(id));`,
    `CREATE TABLE C(id INTEGER PRIMARY KEY);`,
    `CREATE TABLE D(id INTEGER PRIMARY KEY, e_id INTEGER, FOREIGN KEY(e_id) REFERENCES E(id));`,
    `CREATE TABLE E(id INTEGER PRIMARY KEY);`,
  ];

  const { adapter, db } = await init_db(ddl, { tables: ['A', 'E'] });
  try {
    const tables = await adapter.getTables();
    assert.deepEqual(
      new Set(tables.map((t) => t.name)),
      new Set(['A', 'B', 'C', 'D', 'E']),
    );

    const relationships = await adapter.getRelationships(
      tables.map((t) => t.name),
    );
    const edges = new Set(
      relationships.map((r) => `${r.table}->${r.referenced_table}`),
    );
    assert.deepEqual(
      edges,
      new Set(['A->B', 'B->C', 'D->E']),
    );
  } finally {
    db.close();
  }
});

test('tables filter with no matches returns empty tables and relationships', async () => {
  const ddl = [
    `CREATE TABLE A(id INTEGER PRIMARY KEY, b_id INTEGER, FOREIGN KEY(b_id) REFERENCES B(id));`,
    `CREATE TABLE B(id INTEGER PRIMARY KEY);`,
  ];

  const { adapter, db } = await init_db(ddl, { tables: /NoMatch/ });
  try {
    const tables = await adapter.getTables();
    assert.deepEqual(tables, []);

    const relationships = await adapter.getRelationships(
      tables.map((t) => t.name),
    );
    assert.deepEqual(relationships, []);
  } finally {
    db.close();
  }
});

test('tables filter with empty array returns empty tables and relationships', async () => {
  const ddl = [
    `CREATE TABLE A(id INTEGER PRIMARY KEY, b_id INTEGER, FOREIGN KEY(b_id) REFERENCES B(id));`,
    `CREATE TABLE B(id INTEGER PRIMARY KEY);`,
  ];

  const { adapter, db } = await init_db(ddl, { tables: [] });
  try {
    const tables = await adapter.getTables();
    assert.deepEqual(tables, []);

    const relationships = await adapter.getRelationships(
      tables.map((t) => t.name),
    );
    assert.deepEqual(relationships, []);
  } finally {
    db.close();
  }
});

/**
 * Create an in-memory sqlite database, apply DDL, and return a Sqlite adapter bound to it
 * along with the DatabaseSync instance for cleanup.
 */
async function init_db(
  ddl: string | string[],
  options: Partial<SqliteAdapterOptions> = {},
) {
  const db = new DatabaseSync(':memory:');

  // enable foreign keys
  try {
    db.exec('PRAGMA foreign_keys = ON;');
  } catch {
    // ignore — best effort
  }

  if (Array.isArray(ddl)) {
    for (const stmt of ddl) {
      db.exec(stmt);
    }
  } else if (typeof ddl === 'string') {
    db.exec(ddl);
  }

  const adapter = new Sqlite({
    ...options,
    execute: options.execute ?? ((sql: string) => db.prepare(sql).all()),
  });
  return { adapter, db };
}
