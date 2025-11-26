import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import {
  type Relationship,
  type Table,
  applyTablesFilter,
  filterRelationshipsByTables,
  getTablesWithRelated,
} from './adapter.ts';
import { Sqlite, type SqliteAdapterOptions } from './sqlite.ts';

const table = (name: string): Table => ({ name, columns: [] });

test('applyTablesFilter seeds from filter, then keeps full connected chain of tables and relationships', () => {
  const tables = [
    table('Customer'),
    table('Order'),
    table('Product'),
    table('AuditLog'),
    table('Inventory'),
    table('Supplier'),
  ];

  const relationships: Relationship[] = [
    {
      table: 'Customer',
      from: ['id'],
      referenced_table: 'Order',
      to: ['customer_id'],
    },
    {
      table: 'Order',
      from: ['id'],
      referenced_table: 'Product',
      to: ['order_id'],
    },
    {
      table: 'Product',
      from: ['id'],
      referenced_table: 'AuditLog',
      to: ['product_id'],
    },
    {
      table: 'Inventory',
      from: ['product_id'],
      referenced_table: 'Supplier',
      to: ['id'],
    },
  ];

  const { tables: filteredTables, relationships: filteredRelationships } =
    applyTablesFilter(tables, relationships, /Customer/);

  assert.deepEqual(
    new Set(filteredTables.map((t) => t.name)),
    new Set(['Customer', 'Order', 'Product', 'AuditLog']),
  );
  assert.deepEqual(filteredRelationships, relationships.slice(0, 3));
});

test('applyTablesFilter returns empty when filter matches no tables', () => {
  const tables = [table('A'), table('B')];
  const relationships: Relationship[] = [
    { table: 'A', from: ['a'], referenced_table: 'B', to: ['b'] },
  ];

  const { tables: filteredTables, relationships: filteredRelationships } =
    applyTablesFilter(tables, relationships, /NoMatch/);

  assert.deepEqual(filteredTables, []);
  assert.deepEqual(filteredRelationships, []);
});

test('applyTablesFilter with list seed keeps union of connected components', () => {
  const tables = [table('A'), table('B'), table('C'), table('D'), table('E')];
  const relationships: Relationship[] = [
    { table: 'A', from: ['a'], referenced_table: 'B', to: ['b'] },
    { table: 'B', from: ['b'], referenced_table: 'C', to: ['c'] },
    { table: 'D', from: ['d'], referenced_table: 'E', to: ['e'] },
  ];

  const { tables: filteredTables, relationships: filteredRelationships } =
    applyTablesFilter(tables, relationships, ['A', 'D']);

  assert.deepEqual(
    new Set(filteredTables.map((t) => t.name)),
    new Set(['A', 'B', 'C', 'D', 'E']),
  );
  assert.deepEqual(new Set(filteredRelationships), new Set(relationships));
});

test('getTablesWithRelated returns transitive closure for multiple matches', () => {
  const tables = [table('A'), table('B'), table('C'), table('D')];
  const relationships: Relationship[] = [
    { table: 'A', from: ['a'], referenced_table: 'B', to: ['b'] },
    { table: 'B', from: ['b'], referenced_table: 'C', to: ['c'] },
    { table: 'C', from: ['c'], referenced_table: 'D', to: ['d'] },
  ];

  const result = getTablesWithRelated(tables, relationships, ['A', 'D']);
  assert.deepEqual(new Set(result), new Set(['A', 'B', 'C', 'D']));
});

test('filterRelationshipsByTables keeps edges that touch an allowed table', () => {
  const relationships: Relationship[] = [
    { table: 'A', from: ['a'], referenced_table: 'B', to: ['b'] },
    { table: 'C', from: ['c'], referenced_table: 'A', to: ['a'] },
    { table: 'X', from: ['x'], referenced_table: 'Y', to: ['y'] },
  ];

  const allowed = new Set(['A']);
  const filtered = filterRelationshipsByTables(relationships, allowed);
  assert.deepEqual(filtered, relationships.slice(0, 2));
});

test('filterRelationshipsByTables returns original list when allowed set is undefined', () => {
  const relationships: Relationship[] = [
    { table: 'A', from: ['a'], referenced_table: 'B', to: ['b'] },
  ];
  const filtered = filterRelationshipsByTables(relationships, undefined);
  assert.deepEqual(filtered, relationships);
});

test('filterRelationshipsByTables returns empty list when allowed set is empty', () => {
  const relationships: Relationship[] = [
    { table: 'A', from: ['a'], referenced_table: 'B', to: ['b'] },
  ];
  const filtered = filterRelationshipsByTables(relationships, new Set());
  assert.deepEqual(filtered, []);
});

test('getTablesWithRelated returns [] when list seed is empty', () => {
  const tables = [table('A'), table('B')];
  const relationships: Relationship[] = [
    { table: 'A', from: ['a'], referenced_table: 'B', to: ['b'] },
  ];

  const result = getTablesWithRelated(tables, relationships, []);
  assert.deepEqual(result, []);
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
