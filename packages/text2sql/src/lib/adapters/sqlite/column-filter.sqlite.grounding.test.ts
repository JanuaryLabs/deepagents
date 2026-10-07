import { Sqlite as TestSqlite } from '@zukhruf/testing/sqlite';
import assert from 'node:assert';
import { describe, it } from 'node:test';
import { z } from 'zod';

import { createGroundingContext } from '@deepagents/text2sql/grounding';
import {
  Sqlite,
  columnValues,
  constraints,
  indexes,
  tables,
  views,
} from '@deepagents/text2sql/sqlite';

const testSqlite = new TestSqlite();

const entityColumns = z.object({
  columns: z.array(
    z.object({
      data: z.object({
        name: z.string(),
        values: z.array(z.string()).optional(),
      }),
    }),
  ),
});
const tableIndexes = z.object({
  indexes: z
    .array(z.object({ data: z.object({ name: z.string() }) }))
    .optional(),
});
const fragmentData = z.record(z.string(), z.unknown());

function dataName(data: unknown): string | undefined {
  return z.object({ name: z.string() }).safeParse(data).data?.name;
}

describe('Column restriction', () => {
  describe('table column filtering', () => {
    it('should include only specified columns with string array filter', async () => {
      const ddl = `
        CREATE TABLE users (
          id INTEGER PRIMARY KEY,
          name TEXT,
          email TEXT,
          ssn TEXT,
          created_at INTEGER
        );
      `;

      await using database = await testSqlite.database();
      database.connection.exec(ddl);
      const adapter = new Sqlite({
        execute: (sql) => database.connection.prepare(sql).all(),
        grounding: [
          tables({
            columns: {
              users: ['id', 'name', 'email'],
            },
          }),
        ],
      });

      const fragments = await adapter.introspect();
      const tableFragment = fragments.find((f) => f.name === 'table');

      assert.deepStrictEqual(tableFragment?.data, {
        name: 'users',
        columns: [
          { name: 'column', data: { name: 'id', type: 'INTEGER' } },
          { name: 'column', data: { name: 'name', type: 'TEXT' } },
          { name: 'column', data: { name: 'email', type: 'TEXT' } },
        ],
      });
    });

    it('should filter columns with regex', async () => {
      const ddl = `
        CREATE TABLE payments (
          id INTEGER PRIMARY KEY,
          amount REAL,
          internal_notes TEXT,
          internal_code TEXT,
          status TEXT
        );
      `;

      await using database = await testSqlite.database();
      database.connection.exec(ddl);
      const adapter = new Sqlite({
        execute: (sql) => database.connection.prepare(sql).all(),
        grounding: [
          tables({
            columns: {
              payments: /^(?!internal_)/,
            },
          }),
        ],
      });

      const fragments = await adapter.introspect();
      const tableFragment = fragments.find((f) => f.name === 'table');

      assert.deepStrictEqual(tableFragment?.data, {
        name: 'payments',
        columns: [
          { name: 'column', data: { name: 'id', type: 'INTEGER' } },
          { name: 'column', data: { name: 'amount', type: 'REAL' } },
          { name: 'column', data: { name: 'status', type: 'TEXT' } },
        ],
      });
    });

    it('should filter columns with predicate function', async () => {
      const ddl = `
        CREATE TABLE accounts (
          id INTEGER PRIMARY KEY,
          name TEXT,
          card_number TEXT,
          cvv TEXT,
          balance REAL
        );
      `;

      await using database = await testSqlite.database();
      database.connection.exec(ddl);
      const adapter = new Sqlite({
        execute: (sql) => database.connection.prepare(sql).all(),
        grounding: [
          tables({
            columns: {
              accounts: (col) => !['card_number', 'cvv'].includes(col),
            },
          }),
        ],
      });

      const fragments = await adapter.introspect();
      const tableFragment = fragments.find((f) => f.name === 'table');

      assert.deepStrictEqual(tableFragment?.data, {
        name: 'accounts',
        columns: [
          { name: 'column', data: { name: 'id', type: 'INTEGER' } },
          { name: 'column', data: { name: 'name', type: 'TEXT' } },
          { name: 'column', data: { name: 'balance', type: 'REAL' } },
        ],
      });
    });

    it('should keep all columns for tables not in the columns config', async () => {
      const ddl = `
        CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, ssn TEXT);
        CREATE TABLE posts (id INTEGER PRIMARY KEY, title TEXT, body TEXT);
      `;

      await using database = await testSqlite.database();
      database.connection.exec(ddl);
      const adapter = new Sqlite({
        execute: (sql) => database.connection.prepare(sql).all(),
        grounding: [
          tables({
            columns: {
              users: ['id', 'name'],
            },
          }),
        ],
      });

      const fragments = await adapter.introspect();
      const tableFragments = fragments.filter((f) => f.name === 'table');

      const usersData = tableFragments.find(
        (f) => dataName(f.data) === 'users',
      )?.data;
      const postsData = tableFragments.find(
        (f) => dataName(f.data) === 'posts',
      )?.data;

      assert.deepStrictEqual(usersData, {
        name: 'users',
        columns: [
          { name: 'column', data: { name: 'id', type: 'INTEGER' } },
          { name: 'column', data: { name: 'name', type: 'TEXT' } },
        ],
      });

      assert.deepStrictEqual(postsData, {
        name: 'posts',
        columns: [
          { name: 'column', data: { name: 'id', type: 'INTEGER' } },
          { name: 'column', data: { name: 'title', type: 'TEXT' } },
          { name: 'column', data: { name: 'body', type: 'TEXT' } },
        ],
      });
    });
  });

  describe('cascade cleanup', () => {
    it('should exclude indexes referencing filtered-out columns', async () => {
      const ddl = `
        CREATE TABLE users (
          id INTEGER PRIMARY KEY,
          name TEXT,
          email TEXT,
          ssn TEXT
        );
        CREATE INDEX idx_email ON users(email);
        CREATE INDEX idx_ssn ON users(ssn);
      `;

      await using database = await testSqlite.database();
      database.connection.exec(ddl);
      const adapter = new Sqlite({
        execute: (sql) => database.connection.prepare(sql).all(),
        grounding: [
          tables({
            columns: {
              users: ['id', 'name', 'email'],
            },
          }),
          indexes(),
        ],
      });

      const fragments = await adapter.introspect();
      const tableFragment = fragments.find((f) => f.name === 'table');
      const data = tableIndexes.parse(tableFragment?.data);

      const indexNames = data.indexes?.map((idx) => idx.data.name) ?? [];

      assert.ok(
        indexNames.includes('idx_email'),
        'idx_email should be present',
      );
      assert.ok(
        !indexNames.includes('idx_ssn'),
        'idx_ssn should be excluded (references filtered-out column)',
      );
    });

    it('should exclude relationships when FK columns are filtered out', async () => {
      const ddl = `
        CREATE TABLE departments (id INTEGER PRIMARY KEY, name TEXT);
        CREATE TABLE users (
          id INTEGER PRIMARY KEY,
          name TEXT,
          dept_id INTEGER REFERENCES departments(id),
          ssn TEXT
        );
      `;

      await using database = await testSqlite.database();
      database.connection.exec(ddl);
      const adapter = new Sqlite({
        execute: (sql) => database.connection.prepare(sql).all(),
        grounding: [
          tables({
            filter: ['users', 'departments'],
            columns: {
              users: ['id', 'name'],
            },
            forward: true,
          }),
        ],
      });

      const fragments = await adapter.introspect();
      const relFragments = fragments.filter((f) => f.name === 'relationship');

      assert.strictEqual(
        relFragments.length,
        0,
        'Relationship should be excluded because dept_id is filtered out',
      );
    });

    it('should keep relationships when FK columns are present', async () => {
      const ddl = `
        CREATE TABLE departments (id INTEGER PRIMARY KEY, name TEXT);
        CREATE TABLE users (
          id INTEGER PRIMARY KEY,
          name TEXT,
          dept_id INTEGER REFERENCES departments(id),
          ssn TEXT
        );
      `;

      await using database = await testSqlite.database();
      database.connection.exec(ddl);
      const adapter = new Sqlite({
        execute: (sql) => database.connection.prepare(sql).all(),
        grounding: [
          tables({
            filter: ['users', 'departments'],
            columns: {
              users: ['id', 'name', 'dept_id'],
            },
            forward: true,
          }),
        ],
      });

      const fragments = await adapter.introspect();
      const relFragments = fragments.filter((f) => f.name === 'relationship');

      assert.strictEqual(relFragments.length, 1);
    });

    it('should not traverse through filtered-out foreign keys', async () => {
      const ddl = `
        CREATE TABLE departments (id INTEGER PRIMARY KEY, name TEXT);
        CREATE TABLE users (
          id INTEGER PRIMARY KEY,
          name TEXT,
          dept_id INTEGER REFERENCES departments(id),
          ssn TEXT
        );
      `;

      await using database = await testSqlite.database();
      database.connection.exec(ddl);
      const adapter = new Sqlite({
        execute: (sql) => database.connection.prepare(sql).all(),
        grounding: [
          tables({
            filter: ['users'],
            columns: {
              users: ['id', 'name'],
            },
            forward: true,
          }),
        ],
      });

      const fragments = await adapter.introspect();
      const tableNames = fragments
        .filter((f) => f.name === 'table')
        .map((f) => dataName(f.data));

      assert.deepStrictEqual(tableNames, ['users']);
      assert.strictEqual(
        fragments.filter((f) => f.name === 'relationship').length,
        0,
      );
    });

    it('should drop composite relationships when any FK column is missing', async () => {
      const adapter = new Sqlite({
        grounding: [],
        execute: async () => [],
      });

      const fragments = await adapter.introspect({
        ...createGroundingContext(),
        tables: [
          {
            name: 'inventory',
            columns: [
              { name: 'id', type: 'INTEGER' },
              { name: 'wh_region', type: 'TEXT' },
            ],
          },
          {
            name: 'warehouses',
            columns: [
              { name: 'region', type: 'TEXT' },
              { name: 'code', type: 'TEXT' },
            ],
          },
        ],
        relationships: [
          {
            table: 'inventory',
            from: ['wh_region', 'wh_code'],
            referenced_table: 'warehouses',
            to: ['region', 'code'],
          },
        ],
      });

      assert.strictEqual(
        fragments.filter((f) => f.name === 'relationship').length,
        0,
      );
    });

    it('should drop composite indexes and constraints when any column is missing', async () => {
      const ddl = `
        CREATE TABLE users (
          email TEXT,
          tenant_id INTEGER,
          UNIQUE(email, tenant_id),
          CHECK (email <> '' AND tenant_id > 0)
        );
        CREATE INDEX idx_user_email_tenant ON users(email, tenant_id);
      `;

      await using database = await testSqlite.database();
      database.connection.exec(ddl);
      const adapter = new Sqlite({
        execute: (sql) => database.connection.prepare(sql).all(),
        grounding: [
          tables({
            columns: {
              users: ['email'],
            },
          }),
          indexes(),
          constraints(),
        ],
      });

      const fragments = await adapter.introspect();
      const data = fragmentData.parse(
        fragments.find((f) => f.name === 'table')?.data,
      );

      assert.strictEqual(data.indexes, undefined);
      assert.strictEqual(data.constraints, undefined);
    });
  });

  describe('downstream grounding interaction', () => {
    it('should not collect column values for filtered-out columns', async () => {
      const ddl = `
        CREATE TABLE orders (
          id INTEGER PRIMARY KEY,
          status TEXT,
          secret_code TEXT
        );
        INSERT INTO orders VALUES (1, 'active', 'ABC');
        INSERT INTO orders VALUES (2, 'inactive', 'DEF');
        INSERT INTO orders VALUES (3, 'active', 'GHI');
      `;

      await using database = await testSqlite.database();
      database.connection.exec(ddl);
      const adapter = new Sqlite({
        execute: (sql) => database.connection.prepare(sql).all(),
        grounding: [
          tables({
            columns: {
              orders: ['id', 'status'],
            },
          }),
          columnValues(),
        ],
      });

      const fragments = await adapter.introspect();
      const tableFragment = fragments.find((f) => f.name === 'table');
      const data = entityColumns.parse(tableFragment?.data);

      const colNames = data.columns.map((c) => c.data.name);
      assert.ok(
        !colNames.includes('secret_code'),
        'secret_code should not appear',
      );
      assert.ok(colNames.includes('status'), 'status should appear');

      const statusCol = data.columns.find((c) => c.data.name === 'status');
      assert.ok(statusCol?.data.values, 'status should have collected values');
    });
  });

  describe('view column filtering', () => {
    it('should filter view columns with string array', async () => {
      const ddl = `
        CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, email TEXT, ssn TEXT);
        CREATE VIEW v_users AS SELECT id, name, email, ssn FROM users;
      `;

      await using database = await testSqlite.database();
      database.connection.exec(ddl);
      const adapter = new Sqlite({
        execute: (sql) => database.connection.prepare(sql).all(),
        grounding: [
          tables(),
          views({
            columns: {
              v_users: ['id', 'name'],
            },
          }),
        ],
      });

      const fragments = await adapter.introspect();
      const viewFragment = fragments.find((f) => f.name === 'view');
      const data = entityColumns.parse(viewFragment?.data);

      const colNames = data.columns.map((c) => c.data.name);
      assert.deepStrictEqual(colNames, ['id', 'name']);
    });
  });

  describe('column filter with traversal', () => {
    it('should apply column filter to tables discovered via forward traversal', async () => {
      const ddl = `
        CREATE TABLE authors (id INTEGER PRIMARY KEY, name TEXT, bio TEXT, ssn TEXT);
        CREATE TABLE books (
          id INTEGER PRIMARY KEY,
          title TEXT,
          author_id INTEGER REFERENCES authors(id)
        );
      `;

      await using database = await testSqlite.database();
      database.connection.exec(ddl);
      const adapter = new Sqlite({
        execute: (sql) => database.connection.prepare(sql).all(),
        grounding: [
          tables({
            filter: ['books'],
            columns: {
              authors: ['id', 'name'],
            },
            forward: true,
          }),
        ],
      });

      const fragments = await adapter.introspect();
      const tableFragments = fragments.filter((f) => f.name === 'table');

      const authorsData = tableFragments.find(
        (f) => dataName(f.data) === 'authors',
      )?.data;

      assert.deepStrictEqual(authorsData, {
        name: 'authors',
        columns: [
          { name: 'column', data: { name: 'id', type: 'INTEGER' } },
          { name: 'column', data: { name: 'name', type: 'TEXT' } },
        ],
      });
    });
  });
});
