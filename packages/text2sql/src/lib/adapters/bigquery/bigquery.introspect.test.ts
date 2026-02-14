import assert from 'node:assert';
import { describe, it } from 'node:test';

import {
  BigQuery,
  constraints,
  indexes,
  info,
  rowCount,
  tables,
  views,
} from '@deepagents/text2sql/bigquery';

type SqlResponder = (sql: string) => unknown;

function createExecuteStub(responder: SqlResponder) {
  const calls: string[] = [];
  const execute = (sql: string) => {
    calls.push(sql);
    if (/\bcount\s*\(/i.test(sql)) {
      throw new Error(`Unexpected COUNT() query in introspection: ${sql}`);
    }
    return responder(sql);
  };
  return { execute, calls };
}

function requireOne<T>(items: T[], message: string): T {
  if (items.length !== 1) {
    throw new Error(`${message}. Expected 1, got ${items.length}`);
  }
  return items[0]!;
}

describe('BigQuery adapter', () => {
  it('introspects tables, views, constraints, relationships, rowCount, and indexes end-to-end', async () => {
    const { execute, calls } = createExecuteStub((sql) => {
      // Tables listing
      if (
        sql.includes('analytics.INFORMATION_SCHEMA.TABLES') &&
        sql.includes("WHERE table_type = 'BASE TABLE'")
      ) {
        return [{ table_name: 'orders' }, { table_name: 'users' }];
      }

      // Views listing
      if (
        sql.includes('analytics.INFORMATION_SCHEMA.TABLES') &&
        sql.includes("table_type IN ('VIEW', 'MATERIALIZED VIEW')") &&
        sql.includes('SELECT table_name')
      ) {
        return [{ table_name: 'active_users' }, { table_name: 'orders_mv' }];
      }

      // View definition
      if (
        sql.includes('analytics.INFORMATION_SCHEMA.TABLES') &&
        sql.includes('SELECT ddl') &&
        sql.includes("table_name = 'active_users'")
      ) {
        return [
          {
            ddl: 'CREATE VIEW `analytics.active_users` AS SELECT id, email FROM `analytics.users`',
          },
        ];
      }

      if (
        sql.includes('analytics.INFORMATION_SCHEMA.TABLES') &&
        sql.includes('SELECT ddl') &&
        sql.includes("table_name = 'orders_mv'")
      ) {
        return [
          {
            ddl: 'CREATE MATERIALIZED VIEW `analytics.orders_mv` AS SELECT order_id, user_id FROM `analytics.orders`',
          },
        ];
      }

      // View columns
      if (
        sql.includes('analytics.INFORMATION_SCHEMA.COLUMNS') &&
        sql.includes('SELECT column_name, data_type') &&
        sql.includes("table_name = 'active_users'")
      ) {
        return [
          { column_name: 'id', data_type: 'INT64' },
          { column_name: 'email', data_type: 'STRING' },
        ];
      }

      if (
        sql.includes('analytics.INFORMATION_SCHEMA.COLUMNS') &&
        sql.includes('SELECT column_name, data_type') &&
        sql.includes("table_name = 'orders_mv'")
      ) {
        return [
          { column_name: 'order_id', data_type: 'INT64' },
          { column_name: 'user_id', data_type: 'INT64' },
        ];
      }

      // Table columns (flattened nested field paths)
      if (
        sql.includes('analytics.INFORMATION_SCHEMA.COLUMN_FIELD_PATHS') &&
        sql.includes("WHERE f.table_name = 'orders'")
      ) {
        return [
          { field_path: 'order_id', data_type: 'INT64', ordinal_position: 1 },
          { field_path: 'user_id', data_type: 'INT64', ordinal_position: 2 },
          {
            field_path: 'created_at',
            data_type: 'TIMESTAMP',
            ordinal_position: 3,
          },
          { field_path: 'user', data_type: 'STRUCT', ordinal_position: 4 },
          {
            field_path: 'user.address.city',
            data_type: 'STRING',
            ordinal_position: 4,
          },
        ];
      }

      if (
        sql.includes('analytics.INFORMATION_SCHEMA.COLUMN_FIELD_PATHS') &&
        sql.includes("WHERE f.table_name = 'users'")
      ) {
        return [
          { field_path: 'id', data_type: 'INT64', ordinal_position: 1 },
          { field_path: 'email', data_type: 'STRING', ordinal_position: 2 },
        ];
      }

      // FK discovery for TableGrounding
      if (
        sql.includes('analytics.INFORMATION_SCHEMA.TABLE_CONSTRAINTS') &&
        sql.includes('JOIN') &&
        sql.includes('KEY_COLUMN_USAGE') &&
        sql.includes("tc.constraint_type = 'FOREIGN KEY'") &&
        sql.includes("tc.table_name = 'orders'")
      ) {
        return [
          {
            constraint_name: 'orders.fk_user',
            column_name: 'user_id',
            ordinal_position: 1,
            position_in_unique_constraint: 1,
          },
          {
            constraint_name: 'orders.fk_external',
            column_name: 'external_user_id',
            ordinal_position: 1,
            position_in_unique_constraint: 1,
          },
        ];
      }

      if (
        sql.includes('analytics.INFORMATION_SCHEMA.TABLE_CONSTRAINTS') &&
        sql.includes("tc.constraint_type = 'FOREIGN KEY'") &&
        sql.includes("tc.table_name = 'users'")
      ) {
        return [];
      }

      // FK referenced table lookup
      if (
        sql.includes('analytics.INFORMATION_SCHEMA.CONSTRAINT_COLUMN_USAGE') &&
        sql.includes("constraint_name = 'orders.fk_user'")
      ) {
        return [{ table_schema: 'analytics', table_name: 'users' }];
      }

      if (
        sql.includes('analytics.INFORMATION_SCHEMA.CONSTRAINT_COLUMN_USAGE') &&
        sql.includes("constraint_name = 'orders.fk_external'")
      ) {
        return [{ table_schema: 'other', table_name: 'users' }];
      }

      // PK constraint name + columns (referenced side)
      if (
        sql.includes('analytics.INFORMATION_SCHEMA.TABLE_CONSTRAINTS') &&
        sql.includes("constraint_type = 'PRIMARY KEY'") &&
        sql.includes("table_name = 'users'") &&
        sql.includes('LIMIT 1')
      ) {
        return [{ constraint_name: 'users.pk$' }];
      }

      if (
        sql.includes('analytics.INFORMATION_SCHEMA.KEY_COLUMN_USAGE') &&
        sql.includes("constraint_name = 'users.pk$'") &&
        sql.includes("table_name = 'users'")
      ) {
        return [{ column_name: 'id', ordinal_position: 1 }];
      }

      // Column metadata for constraints (NOT NULL / DEFAULT)
      if (
        sql.includes('analytics.INFORMATION_SCHEMA.COLUMNS') &&
        sql.includes('SELECT column_name, is_nullable, column_default') &&
        sql.includes("table_name = 'orders'")
      ) {
        return [
          { column_name: 'order_id', is_nullable: 'NO', column_default: null },
          { column_name: 'user_id', is_nullable: 'NO', column_default: null },
          {
            column_name: 'created_at',
            is_nullable: 'YES',
            column_default: null,
          },
          { column_name: 'user', is_nullable: 'YES', column_default: null },
        ];
      }

      if (
        sql.includes('analytics.INFORMATION_SCHEMA.COLUMNS') &&
        sql.includes('SELECT column_name, is_nullable, column_default') &&
        sql.includes("table_name = 'users'")
      ) {
        return [
          { column_name: 'id', is_nullable: 'NO', column_default: null },
          { column_name: 'email', is_nullable: 'YES', column_default: null },
        ];
      }

      // PK/FK key columns for constraints grounding
      if (
        sql.includes('analytics.INFORMATION_SCHEMA.TABLE_CONSTRAINTS') &&
        sql.includes("tc.constraint_type IN ('PRIMARY KEY', 'FOREIGN KEY')") &&
        sql.includes("tc.table_name = 'orders'")
      ) {
        return [
          {
            constraint_name: 'orders.pk$',
            constraint_type: 'PRIMARY KEY',
            column_name: 'order_id',
            ordinal_position: 1,
            position_in_unique_constraint: null,
          },
          {
            constraint_name: 'orders.fk_user',
            constraint_type: 'FOREIGN KEY',
            column_name: 'user_id',
            ordinal_position: 1,
            position_in_unique_constraint: 1,
          },
          {
            constraint_name: 'orders.fk_external',
            constraint_type: 'FOREIGN KEY',
            column_name: 'external_user_id',
            ordinal_position: 1,
            position_in_unique_constraint: 1,
          },
        ];
      }

      if (
        sql.includes('analytics.INFORMATION_SCHEMA.TABLE_CONSTRAINTS') &&
        sql.includes("tc.constraint_type IN ('PRIMARY KEY', 'FOREIGN KEY')") &&
        sql.includes("tc.table_name = 'users'")
      ) {
        return [
          {
            constraint_name: 'users.pk$',
            constraint_type: 'PRIMARY KEY',
            column_name: 'id',
            ordinal_position: 1,
            position_in_unique_constraint: null,
          },
        ];
      }

      // Row counts (metadata-only)
      if (
        sql.includes('analytics.INFORMATION_SCHEMA.TABLE_STORAGE') &&
        sql.includes("table_name = 'orders'")
      ) {
        return [{ total_rows: 1200 }];
      }

      if (
        sql.includes('analytics.INFORMATION_SCHEMA.TABLE_STORAGE') &&
        sql.includes("table_name = 'users'")
      ) {
        return [{ total_rows: 50 }];
      }

      // Index hints (partition/clustering)
      if (
        sql.includes('analytics.INFORMATION_SCHEMA.COLUMNS') &&
        sql.includes('clustering_ordinal_position') &&
        sql.includes("table_name = 'orders'")
      ) {
        return [
          {
            column_name: 'created_at',
            is_partitioning_column: 'YES',
            clustering_ordinal_position: 2,
          },
          {
            column_name: 'user_id',
            is_partitioning_column: 'NO',
            clustering_ordinal_position: 1,
          },
        ];
      }

      if (
        sql.includes('analytics.INFORMATION_SCHEMA.COLUMNS') &&
        sql.includes('clustering_ordinal_position') &&
        sql.includes("table_name = 'users'")
      ) {
        return [];
      }

      throw new Error(
        `Unexpected SQL in BigQuery introspection stub:\\n${sql}`,
      );
    });

    const adapter = new BigQuery({
      datasets: ['analytics'],
      execute,
      validate: async () => undefined,
      grounding: [
        info(),
        tables({ forward: true }),
        views(),
        constraints(),
        rowCount(),
        indexes(),
      ],
    });

    const fragments = await adapter.introspect();

    const dialect = fragments.find((f) => f.name === 'dialectInfo');
    assert.deepStrictEqual(dialect?.data, { dialect: 'bigquery' });

    const tableFrags = fragments.filter((f) => f.name === 'table');
    const orders = requireOne(
      tableFrags.filter((t) => t.data.name === 'analytics.orders'),
      'Expected orders table fragment',
    );

    const users = requireOne(
      tableFrags.filter((t) => t.data.name === 'analytics.users'),
      'Expected users table fragment',
    );

    // Nested field paths are flattened as dot-delimited column names.
    const ordersColumnNames = orders.data.columns.map((c) => c.data.name);
    assert.ok(
      ordersColumnNames.includes('user.address.city'),
      'Expected flattened nested field path column user.address.city',
    );

    // Constraints annotate columns (PK/FK/NOT NULL) and skip out-of-scope FK targets.
    const usersId = requireOne(
      users.data.columns.filter((c) => c.data.name === 'id'),
      'Expected users.id column fragment',
    );
    assert.strictEqual(usersId.data.pk, true);

    const ordersUserId = requireOne(
      orders.data.columns.filter((c) => c.data.name === 'user_id'),
      'Expected orders.user_id column fragment',
    );
    assert.strictEqual(ordersUserId.data.notNull, true);
    assert.strictEqual(ordersUserId.data.fk, 'analytics.users.id');

    // Row count + sizeHint come from metadata-only grounding.
    assert.strictEqual(orders.data.rowCount, 1200);
    assert.strictEqual(orders.data.sizeHint, 'medium');
    assert.strictEqual(users.data.rowCount, 50);
    assert.strictEqual(users.data.sizeHint, 'tiny');

    // Partition/clustering columns are treated as "indexed".
    const ordersCreatedAt = requireOne(
      orders.data.columns.filter((c) => c.data.name === 'created_at'),
      'Expected orders.created_at column fragment',
    );
    assert.strictEqual(ordersCreatedAt.data.indexed, true);
    assert.strictEqual(ordersUserId.data.indexed, true);

    // Views include materialized views and definitions.
    const viewFrags = fragments.filter((f) => f.name === 'view');
    const activeUsers = requireOne(
      viewFrags.filter((v) => v.data.name === 'analytics.active_users'),
      'Expected active_users view fragment',
    );
    const ordersMv = requireOne(
      viewFrags.filter((v) => v.data.name === 'analytics.orders_mv'),
      'Expected orders_mv materialized view fragment',
    );
    assert.ok(activeUsers.data.definition?.includes('CREATE VIEW'));
    assert.ok(ordersMv.data.definition?.includes('CREATE MATERIALIZED VIEW'));

    // Relationship fragments are produced when FK metadata exists.
    const relationshipFrags = fragments.filter(
      (f) => f.name === 'relationship',
    );
    const rel = requireOne(
      relationshipFrags,
      'Expected exactly one relationship fragment',
    );
    assert.deepStrictEqual(rel.data, {
      from: { table: 'analytics.orders', columns: ['user_id'] },
      to: { table: 'analytics.users', columns: ['id'] },
      cardinality: 'many-to-one',
    });

    // Sanity: rowCount grounding must never issue COUNT(*).
    assert.ok(calls.length > 0);
  });
});
