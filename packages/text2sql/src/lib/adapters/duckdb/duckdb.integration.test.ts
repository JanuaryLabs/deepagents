import { DuckDBInstance } from '@duckdb/node-api';
import assert from 'node:assert/strict';
import { it } from 'node:test';

import {
  FileIndexLock,
  Text2Sql,
  Text2SqlValidationError,
} from '@deepagents/text2sql';
import {
  DuckDB,
  columnStats,
  columnValues,
  constraints,
  indexes,
  info,
  rowCount,
  tables,
  views,
} from '@deepagents/text2sql/duckdb';

it('executes grounded DuckDB friendly SQL through the public adapter', async () => {
  const instance = await DuckDBInstance.create(':memory:');
  const connection = await instance.connect();

  try {
    await connection.run(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY,
        name VARCHAR NOT NULL,
        secret VARCHAR
      );
      INSERT INTO users VALUES (1, 'Ada', 'hidden');
    `);

    const execute = async (sql: string) => {
      const reader = await connection.runAndReadAll(sql);
      return reader.getRowObjectsJson();
    };
    const adapter = new DuckDB({ execute, grounding: [tables()] });

    assert.deepEqual(
      await adapter.execute('FROM users SELECT * EXCLUDE (secret)'),
      [{ id: 1, name: 'Ada' }],
    );
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
});

it('supports native DuckDB pivot and as-of join syntax', async () => {
  const instance = await DuckDBInstance.create(':memory:');
  const connection = await instance.connect();

  try {
    await connection.run(`
      CREATE TABLE sales (region VARCHAR, quarter VARCHAR, amount INTEGER);
      INSERT INTO sales VALUES ('north', 'Q1', 10), ('north', 'Q2', 15);

      CREATE TABLE trades (symbol VARCHAR, ts TIMESTAMP);
      CREATE TABLE prices (symbol VARCHAR, ts TIMESTAMP, price DECIMAL(10, 2));
      INSERT INTO trades VALUES ('ACME', TIMESTAMP '2026-01-01 10:05:00');
      INSERT INTO prices VALUES
        ('ACME', TIMESTAMP '2026-01-01 10:00:00', 42.50),
        ('ACME', TIMESTAMP '2026-01-01 10:10:00', 43.00);
    `);

    const execute = async (sql: string) => {
      const reader = await connection.runAndReadAll(sql);
      return reader.getRowObjectsJson();
    };
    const adapter = new DuckDB({ execute, grounding: [tables()] });

    assert.deepEqual(
      await adapter.execute(`
        PIVOT sales
        ON quarter IN ('Q1', 'Q2')
        USING sum(amount)
        GROUP BY region
      `),
      [{ region: 'north', Q1: '10', Q2: '15' }],
    );
    assert.deepEqual(
      await adapter.execute(`
        SELECT trades.symbol, prices.price
        FROM trades
        ASOF JOIN prices
          ON trades.symbol = prices.symbol AND trades.ts >= prices.ts
      `),
      [{ symbol: 'ACME', price: '42.50' }],
    );

    await assert.rejects(
      adapter.execute('PIVOT sales ON quarter USING sum(amount)'),
      { name: 'SQLReadOnlyError' },
    );
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
});

it('enforces DuckDB read-only and grounded-scope policy before execution', async () => {
  const instance = await DuckDBInstance.create(':memory:');
  const connection = await instance.connect();

  try {
    await connection.run(`
      CREATE TABLE users (id INTEGER, name VARCHAR);
      CREATE TABLE secrets (value VARCHAR);
      CREATE SEQUENCE ids;
      CREATE MACRO hidden_count() AS (SELECT count(*) FROM secrets);
      ATTACH ':memory:' AS other;
      CREATE TABLE other.main.users (id INTEGER);
      INSERT INTO users VALUES (1, 'Ada');
      INSERT INTO secrets VALUES ('hidden');
      INSERT INTO other.main.users VALUES (99);
    `);

    const executed: string[] = [];
    const execute = async (sql: string) => {
      executed.push(sql);
      const reader = await connection.runAndReadAll(sql);
      return reader.getRowObjectsJson();
    };
    const adapter = new DuckDB({
      execute,
      grounding: [tables({ filter: ['users'] })],
    });

    assert.deepEqual(
      await adapter.execute(`
        SELECT name
        FROM users
        QUALIFY row_number() OVER (ORDER BY id) = 1
      `),
      [{ name: 'Ada' }],
    );
    assert.deepEqual(await adapter.execute('SELECT * FROM range(3)'), [
      { range: '0' },
      { range: '1' },
      { range: '2' },
    ]);

    const hiddenCte =
      'WITH hidden AS (SELECT * FROM secrets) SELECT 1 AS value';
    await assert.rejects(
      adapter.execute(hiddenCte),
      (error: unknown) =>
        hasSqlErrorName(error, 'SQLScopeError') &&
        error.payload.referenced_entities?.includes(
          '"memory"."main"."secrets"',
        ) === true,
    );
    assert.ok(!executed.includes(hiddenCte));

    const attachedCatalog = 'SELECT * FROM other.main.users';
    await assert.rejects(adapter.execute(attachedCatalog), {
      name: 'SQLScopeError',
    });
    assert.ok(!executed.includes(attachedCatalog));

    for (const sql of [
      'DROP TABLE users',
      'SELECT 1; DROP TABLE users',
      "SELECT * FROM read_csv_auto('/tmp/secret.csv')",
      'SELECT * FROM duckdb_secrets()',
      "SELECT nextval('ids')",
      'SELECT hidden_count()',
    ]) {
      await assert.rejects(adapter.execute(sql), { name: 'SQLReadOnlyError' });
      assert.ok(!executed.includes(sql));
    }

    const invalid = await adapter.validate('SELCT 1');
    assert.equal(typeof invalid, 'string');
    assert.equal(
      JSON.parse(invalid as string).error_type,
      'SQL_SCOPE_PARSE_ERROR',
    );

    const rows = await connection.runAndReadAll(
      'SELECT count(*) AS count FROM users',
    );
    assert.deepEqual(rows.getRowObjectsJson(), [{ count: '1' }]);
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
});

it('isolates named DuckDB connections with different grounded scopes', async () => {
  const crmInstance = await DuckDBInstance.create(':memory:');
  const supportInstance = await DuckDBInstance.create(':memory:');
  const crmConnection = await crmInstance.connect();
  const supportConnection = await supportInstance.connect();

  try {
    await crmConnection.run(`
      CREATE TABLE customers (id INTEGER, name VARCHAR);
      CREATE TABLE private_customers (id INTEGER, note VARCHAR);
      INSERT INTO customers VALUES (1, 'Ada');
      INSERT INTO private_customers VALUES (1, 'hidden');
    `);
    await supportConnection.run(`
      CREATE TABLE tickets (id INTEGER, subject VARCHAR);
      CREATE TABLE private_notes (id INTEGER, note VARCHAR);
      INSERT INTO tickets VALUES (10, 'Login');
      INSERT INTO private_notes VALUES (10, 'hidden');
    `);

    const text2sql = new Text2Sql({
      adapters: {
        crm: new DuckDB({
          execute: async (sql) =>
            (await crmConnection.runAndReadAll(sql)).getRowObjectsJson(),
          grounding: [tables({ filter: ['customers'] })],
        }),
        support: new DuckDB({
          execute: async (sql) =>
            (await supportConnection.runAndReadAll(sql)).getRowObjectsJson(),
          grounding: [tables({ filter: ['tickets'] })],
        }),
      },
      lock: new FileIndexLock(),
    });

    assert.deepEqual(await text2sql.run('crm', 'SELECT name FROM customers'), {
      rows: [{ name: 'Ada' }],
      columns: ['name'],
    });
    assert.deepEqual(
      await text2sql.run('support', 'SELECT subject FROM tickets'),
      { rows: [{ subject: 'Login' }], columns: ['subject'] },
    );
    await assert.rejects(
      text2sql.run('crm', 'SELECT * FROM private_customers'),
      Text2SqlValidationError,
    );
    await assert.rejects(
      text2sql.run('support', 'SELECT * FROM customers'),
      Text2SqlValidationError,
    );
  } finally {
    crmConnection.closeSync();
    supportConnection.closeSync();
    crmInstance.closeSync();
    supportInstance.closeSync();
  }
});

it('joins explicitly grounded relations across attached DuckDB catalogs', async () => {
  const instance = await DuckDBInstance.create(':memory:');
  const connection = await instance.connect();

  try {
    await connection.run(`
      CREATE TABLE users (id INTEGER, name VARCHAR);
      ATTACH ':memory:' AS warehouse;
      CREATE TABLE warehouse.main.orders (
        id INTEGER,
        user_id INTEGER,
        amount INTEGER
      );
      CREATE TABLE warehouse.main.secrets (value VARCHAR);
      INSERT INTO users VALUES (1, 'Ada');
      INSERT INTO warehouse.main.orders VALUES (10, 1, 25);
      INSERT INTO warehouse.main.secrets VALUES ('hidden');
    `);

    const text2sql = new Text2Sql({
      adapters: {
        analytics: new DuckDB({
          execute: async (sql) =>
            (await connection.runAndReadAll(sql)).getRowObjectsJson(),
          catalogs: ['memory', 'warehouse'],
          schemas: ['main'],
          grounding: [
            tables({
              filter: ['memory.main.users', 'warehouse.main.orders'],
            }),
          ],
        }),
      },
      lock: new FileIndexLock(),
    });

    assert.deepEqual(
      await text2sql.run(
        'analytics',
        `
          SELECT users.name, orders.amount
          FROM memory.main.users
          JOIN warehouse.main.orders ON users.id = orders.user_id
        `,
      ),
      { rows: [{ name: 'Ada', amount: 25 }], columns: ['name', 'amount'] },
    );
    await assert.rejects(
      text2sql.run('analytics', 'SELECT * FROM warehouse.main.secrets'),
      Text2SqlValidationError,
    );
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
});

function hasSqlErrorName(
  error: unknown,
  name: string,
): error is Error & {
  payload: { referenced_entities?: string[] };
} {
  return (
    error instanceof Error &&
    error.name === name &&
    'payload' in error &&
    typeof error.payload === 'object' &&
    error.payload !== null
  );
}

it('introspects DuckDB catalog metadata through first-class groundings', async () => {
  const instance = await DuckDBInstance.create(':memory:');
  const connection = await instance.connect();

  try {
    await connection.run(`
      CREATE TYPE status_enum AS ENUM ('active', 'inactive');
      CREATE TABLE users (
        id INTEGER PRIMARY KEY,
        email VARCHAR UNIQUE NOT NULL,
        status status_enum DEFAULT 'active',
        score INTEGER CHECK (score >= 0)
      );
      CREATE TABLE orders (
        id INTEGER PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        amount DECIMAL(10, 2)
      );
      CREATE INDEX orders_user_id_idx ON orders(user_id);
      CREATE VIEW active_users AS
        SELECT id, email FROM users WHERE status = 'active';
      INSERT INTO users VALUES
        (1, 'ada@example.com', 'active', 10),
        (2, 'grace@example.com', 'inactive', NULL);
      INSERT INTO orders VALUES (10, 1, 12.50), (11, 1, 20.00);
    `);

    const execute = async (sql: string) => {
      const reader = await connection.runAndReadAll(sql);
      return reader.getRowObjectsJson();
    };
    const adapter = new DuckDB({
      execute,
      grounding: [
        info(),
        tables({ forward: true }),
        views(),
        constraints(),
        indexes(),
        rowCount(),
        columnStats(),
        columnValues(),
      ],
    });

    const fragments = await adapter.introspect();
    const dialect = fragments.find(
      (fragment) => fragment.name === 'dialectInfo',
    );
    assert.equal(
      (dialect?.data as Record<string, unknown> | undefined)?.dialect,
      'duckdb',
    );

    const users = fragments.find(
      (fragment) =>
        fragment.name === 'table' &&
        (fragment.data as Record<string, unknown> | undefined)?.name ===
          '"memory"."main"."users"',
    );
    assert.ok(users);
    const usersData = users.data as Record<string, unknown>;
    assert.equal(usersData.rowCount, 2);
    const userColumns = usersData.columns as Array<{
      name: string;
      data: Record<string, unknown>;
    }>;
    assert.deepEqual(
      userColumns.find((column) => column.data.name === 'status')?.data.values,
      ['active', 'inactive'],
    );
    assert.deepEqual(
      userColumns.find((column) => column.data.name === 'score')?.data.stats,
      { min: '10', max: '10', nullFraction: 0.5, nDistinct: 1 },
    );
    assert.equal(
      userColumns.find((column) => column.data.name === 'id')?.data.pk,
      true,
    );

    const orders = fragments.find(
      (fragment) =>
        fragment.name === 'table' &&
        (fragment.data as Record<string, unknown> | undefined)?.name ===
          '"memory"."main"."orders"',
    );
    assert.ok(orders);
    assert.match(JSON.stringify(orders.data), /orders_user_id_idx/);

    const relationship = fragments.find(
      (fragment) => fragment.name === 'relationship',
    );
    assert.ok(relationship);
    assert.match(JSON.stringify(relationship.data), /orders/);
    assert.match(JSON.stringify(relationship.data), /users/);

    const activeUsers = fragments.find(
      (fragment) =>
        fragment.name === 'view' &&
        (fragment.data as Record<string, unknown> | undefined)?.name ===
          '"memory"."main"."active_users"',
    );
    assert.ok(activeUsers);
    assert.match(JSON.stringify(activeUsers.data), /CREATE VIEW/);
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
});
