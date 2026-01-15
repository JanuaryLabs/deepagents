import assert from 'node:assert';
import { describe, it } from 'node:test';

import { columnValues, constraints, tables } from '@deepagents/text2sql/sqlite';

import { init_db } from '../../../tests/sqlite.ts';

describe('SqliteColumnValuesGrounding', () => {
  describe('Low cardinality detection', () => {
    it('should detect low cardinality column values', async () => {
      const ddl = `
        CREATE TABLE orders (
          id INTEGER PRIMARY KEY,
          status TEXT
        );
        INSERT INTO orders (status) VALUES ('pending'), ('shipped'), ('delivered');
      `;

      const { adapter } = await init_db(ddl, {
        grounding: [tables(), columnValues()],
      });

      const fragments = await adapter.introspect();
      const tableFragment = fragments.find((f) => f.name === 'table');

      assert.deepStrictEqual(tableFragment?.data, {
        name: 'orders',
        columns: [
          {
            name: 'column',
            data: { name: 'id', type: 'INTEGER', values: ['1', '2', '3'] },
          },
          {
            name: 'column',
            data: {
              name: 'status',
              type: 'TEXT',
              values: ['pending', 'shipped', 'delivered'],
            },
          },
        ],
      });
    });

    it('should not annotate columns with too many distinct values', async () => {
      const ddl = `
        CREATE TABLE items (
          id INTEGER PRIMARY KEY,
          code TEXT
        );
      `;

      const { adapter, db } = await init_db(ddl, {
        grounding: [tables(), columnValues({ lowCardinalityLimit: 5 })],
      });

      // Insert 10 distinct values (exceeds limit of 5)
      for (let i = 0; i < 10; i++) {
        db.exec(`INSERT INTO items (code) VALUES ('code_${i}')`);
      }

      const fragments = await adapter.introspect();
      const tableFragment = fragments.find((f) => f.name === 'table');

      // No values array since cardinality exceeds limit
      assert.deepStrictEqual(tableFragment?.data, {
        name: 'items',
        columns: [
          { name: 'column', data: { name: 'id', type: 'INTEGER' } },
          { name: 'column', data: { name: 'code', type: 'TEXT' } },
        ],
      });
    });

    it('should handle NULL values gracefully', async () => {
      const ddl = `
        CREATE TABLE products (
          id INTEGER PRIMARY KEY,
          category TEXT
        );
        INSERT INTO products (category) VALUES ('electronics'), (NULL), ('books');
      `;

      const { adapter } = await init_db(ddl, {
        grounding: [tables(), columnValues()],
      });

      const fragments = await adapter.introspect();
      const tableFragment = fragments.find((f) => f.name === 'table');

      // Should detect non-NULL values (id gets values, category gets non-null values)
      assert.deepStrictEqual(tableFragment?.data, {
        name: 'products',
        columns: [
          {
            name: 'column',
            data: { name: 'id', type: 'INTEGER', values: ['1', '2', '3'] },
          },
          {
            name: 'column',
            data: {
              name: 'category',
              type: 'TEXT',
              values: ['electronics', 'books'],
            },
          },
        ],
      });
    });

    it('should handle empty table', async () => {
      const ddl = `
        CREATE TABLE empty_table (
          id INTEGER PRIMARY KEY,
          status TEXT
        );
      `;

      const { adapter } = await init_db(ddl, {
        grounding: [tables(), columnValues()],
      });

      const fragments = await adapter.introspect();
      const tableFragment = fragments.find((f) => f.name === 'table');

      // No values since table is empty
      assert.deepStrictEqual(tableFragment?.data, {
        name: 'empty_table',
        columns: [
          { name: 'column', data: { name: 'id', type: 'INTEGER' } },
          { name: 'column', data: { name: 'status', type: 'TEXT' } },
        ],
      });
    });

    it('should handle various data types', async () => {
      const ddl = `
        CREATE TABLE mixed (
          id INTEGER PRIMARY KEY,
          flag INTEGER,
          amount REAL,
          label TEXT
        );
        INSERT INTO mixed (flag, amount, label) VALUES (0, 10.5, 'A'), (1, 20.0, 'B');
      `;

      const { adapter } = await init_db(ddl, {
        grounding: [tables(), columnValues()],
      });

      const fragments = await adapter.introspect();
      const tableFragment = fragments.find((f) => f.name === 'table');

      assert.deepStrictEqual(tableFragment?.data, {
        name: 'mixed',
        columns: [
          {
            name: 'column',
            data: { name: 'id', type: 'INTEGER', values: ['1', '2'] },
          },
          {
            name: 'column',
            data: { name: 'flag', type: 'INTEGER', values: ['0', '1'] },
          },
          {
            name: 'column',
            data: { name: 'amount', type: 'REAL', values: ['10.5', '20'] },
          },
          {
            name: 'column',
            data: { name: 'label', type: 'TEXT', values: ['A', 'B'] },
          },
        ],
      });
    });
  });

  describe('CHECK constraint enum detection', () => {
    it('should detect enum values from CHECK constraint with IN clause', async () => {
      const ddl = `
        CREATE TABLE tasks (
          id INTEGER PRIMARY KEY,
          status TEXT CHECK (status IN ('todo', 'in_progress', 'done'))
        );
      `;

      const { adapter } = await init_db(ddl, {
        grounding: [tables(), constraints(), columnValues()],
      });

      const fragments = await adapter.introspect();
      const tableFragment = fragments.find((f) => f.name === 'table');

      assert.deepStrictEqual(tableFragment?.data, {
        name: 'tasks',
        columns: [
          { name: 'column', data: { name: 'id', type: 'INTEGER', pk: true } },
          {
            name: 'column',
            data: {
              name: 'status',
              type: 'TEXT',
              values: ['todo', 'in_progress', 'done'],
            },
          },
        ],
        constraints: [
          {
            name: 'constraint',
            data: {
              name: 'tasks_check_0',
              type: 'CHECK',
              columns: ['status'],
              definition: "status IN ('todo', 'in_progress', 'done')",
            },
          },
        ],
      });
    });

    it('should prefer CHECK constraint over low cardinality', async () => {
      const ddl = `
        CREATE TABLE orders (
          id INTEGER PRIMARY KEY,
          status TEXT CHECK (status IN ('pending', 'completed'))
        );
        INSERT INTO orders (status) VALUES ('pending'), ('completed');
      `;

      const { adapter } = await init_db(ddl, {
        grounding: [tables(), constraints(), columnValues()],
      });

      const fragments = await adapter.introspect();
      const tableFragment = fragments.find((f) => f.name === 'table');

      // Values should come from CHECK constraint
      assert.deepStrictEqual(tableFragment?.data, {
        name: 'orders',
        columns: [
          {
            name: 'column',
            data: { name: 'id', type: 'INTEGER', pk: true, values: ['1', '2'] },
          },
          {
            name: 'column',
            data: {
              name: 'status',
              type: 'TEXT',
              values: ['pending', 'completed'],
            },
          },
        ],
        constraints: [
          {
            name: 'constraint',
            data: {
              name: 'orders_check_0',
              type: 'CHECK',
              columns: ['status'],
              definition: "status IN ('pending', 'completed')",
            },
          },
        ],
      });
    });

    it('should handle named CHECK constraints', async () => {
      const ddl = `
        CREATE TABLE users (
          id INTEGER PRIMARY KEY,
          role TEXT CONSTRAINT valid_role CHECK (role IN ('admin', 'user', 'guest'))
        );
      `;

      const { adapter } = await init_db(ddl, {
        grounding: [tables(), constraints(), columnValues()],
      });

      const fragments = await adapter.introspect();
      const tableFragment = fragments.find((f) => f.name === 'table');

      assert.deepStrictEqual(tableFragment?.data, {
        name: 'users',
        columns: [
          { name: 'column', data: { name: 'id', type: 'INTEGER', pk: true } },
          {
            name: 'column',
            data: {
              name: 'role',
              type: 'TEXT',
              values: ['admin', 'user', 'guest'],
            },
          },
        ],
        constraints: [
          {
            name: 'constraint',
            data: {
              name: 'valid_role',
              type: 'CHECK',
              columns: ['role'],
              definition: "role IN ('admin', 'user', 'guest')",
            },
          },
        ],
      });
    });
  });

  describe('config options', () => {
    it('should respect lowCardinalityLimit config', async () => {
      const ddl = `
        CREATE TABLE test (
          id INTEGER PRIMARY KEY,
          code TEXT
        );
        INSERT INTO test (code) VALUES ('a'), ('b'), ('c'), ('d'), ('e');
      `;

      // With limit of 3, 5 values should not be detected
      const { adapter: adapter1 } = await init_db(ddl, {
        grounding: [tables(), columnValues({ lowCardinalityLimit: 3 })],
      });

      const fragments1 = await adapter1.introspect();
      const tableFragment1 = fragments1.find((f) => f.name === 'table');

      assert.deepStrictEqual(tableFragment1?.data, {
        name: 'test',
        columns: [
          { name: 'column', data: { name: 'id', type: 'INTEGER' } },
          { name: 'column', data: { name: 'code', type: 'TEXT' } },
        ],
      });

      // With limit of 10, 5 values should be detected
      const { adapter: adapter2 } = await init_db(ddl, {
        grounding: [tables(), columnValues({ lowCardinalityLimit: 10 })],
      });

      const fragments2 = await adapter2.introspect();
      const tableFragment2 = fragments2.find((f) => f.name === 'table');

      assert.deepStrictEqual(tableFragment2?.data, {
        name: 'test',
        columns: [
          {
            name: 'column',
            data: {
              name: 'id',
              type: 'INTEGER',
              values: ['1', '2', '3', '4', '5'],
            },
          },
          {
            name: 'column',
            data: {
              name: 'code',
              type: 'TEXT',
              values: ['a', 'b', 'c', 'd', 'e'],
            },
          },
        ],
      });
    });
  });
});
