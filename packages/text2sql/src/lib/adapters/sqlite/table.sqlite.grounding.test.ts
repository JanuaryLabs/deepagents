import assert from 'node:assert';
import { describe, it } from 'node:test';

import { constraints, tables } from '@deepagents/text2sql/sqlite';

import { init_db } from '../../../tests/sqlite.ts';

describe('SqliteTableGrounding', () => {
  describe('Suite 1: Edge Cases', () => {
    it('should return empty fragments for empty database', async () => {
      const { adapter } = await init_db('', {
        grounding: [tables()],
      });

      const fragments = await adapter.introspect();
      const tableFragments = fragments.filter((f) => f.name === 'table');

      assert.deepStrictEqual(tableFragments, []);
    });

    it('should handle self-referential foreign keys', async () => {
      const ddl = `
        CREATE TABLE employees (
          id INTEGER PRIMARY KEY,
          name TEXT,
          manager_id INTEGER REFERENCES employees(id)
        );
      `;

      const { adapter } = await init_db(ddl, {
        grounding: [tables({ forward: true, backward: true })],
      });

      const fragments = await adapter.introspect();
      const tableFragment = fragments.find((f) => f.name === 'table');

      assert.deepStrictEqual(tableFragment?.data, {
        name: 'employees',
        columns: [
          { name: 'column', data: { name: 'id', type: 'INTEGER' } },
          { name: 'column', data: { name: 'name', type: 'TEXT' } },
          { name: 'column', data: { name: 'manager_id', type: 'INTEGER' } },
        ],
      });
    });

    it('should handle circular foreign key references without infinite loop', async () => {
      const ddl = [
        'CREATE TABLE a (id INTEGER PRIMARY KEY, b_id INTEGER);',
        'CREATE TABLE b (id INTEGER PRIMARY KEY, a_id INTEGER REFERENCES a(id));',
      ];

      const { adapter } = await init_db(ddl, {
        grounding: [tables({ forward: true, backward: true })],
      });

      const fragments = await adapter.introspect();
      const tableFragments = fragments.filter((f) => f.name === 'table');

      assert.deepStrictEqual(
        tableFragments.map((f) => f.data),
        [
          {
            name: 'a',
            columns: [
              { name: 'column', data: { name: 'id', type: 'INTEGER' } },
              { name: 'column', data: { name: 'b_id', type: 'INTEGER' } },
            ],
          },
          {
            name: 'b',
            columns: [
              { name: 'column', data: { name: 'id', type: 'INTEGER' } },
              { name: 'column', data: { name: 'a_id', type: 'INTEGER' } },
            ],
          },
        ],
      );
    });
  });

  describe('Suite 2: Table Discovery', () => {
    it('should discover single table with columns and primary key', async () => {
      const ddl = `
        CREATE TABLE users (
          id INTEGER PRIMARY KEY,
          email TEXT,
          created_at INTEGER
        );
      `;

      const { adapter } = await init_db(ddl, {
        grounding: [tables(), constraints()],
      });

      const fragments = await adapter.introspect();
      const tableFragment = fragments.find((f) => f.name === 'table');

      assert.deepStrictEqual(tableFragment?.data, {
        name: 'users',
        columns: [
          { name: 'column', data: { name: 'id', type: 'INTEGER', pk: true } },
          { name: 'column', data: { name: 'email', type: 'TEXT' } },
          { name: 'column', data: { name: 'created_at', type: 'INTEGER' } },
        ],
      });
    });

    it('should discover multiple unrelated tables', async () => {
      const ddl = `
        CREATE TABLE products (id INTEGER PRIMARY KEY, name TEXT);
        CREATE TABLE categories (id INTEGER PRIMARY KEY, label TEXT);
      `;

      const { adapter } = await init_db(ddl, {
        grounding: [tables()],
      });

      const fragments = await adapter.introspect();
      const tableFragments = fragments.filter((f) => f.name === 'table');

      assert.deepStrictEqual(
        tableFragments.map((f) => f.data),
        [
          {
            name: 'categories',
            columns: [
              { name: 'column', data: { name: 'id', type: 'INTEGER' } },
              { name: 'column', data: { name: 'label', type: 'TEXT' } },
            ],
          },
          {
            name: 'products',
            columns: [
              { name: 'column', data: { name: 'id', type: 'INTEGER' } },
              { name: 'column', data: { name: 'name', type: 'TEXT' } },
            ],
          },
        ],
      );
    });
  });

  describe('Suite 3: Foreign Key Relationships', () => {
    it('should discover simple foreign key relationship', async () => {
      const ddl = `
        CREATE TABLE authors (id INTEGER PRIMARY KEY, name TEXT);
        CREATE TABLE books (
          id INTEGER PRIMARY KEY,
          author_id INTEGER REFERENCES authors(id)
        );
      `;

      const { adapter } = await init_db(ddl, {
        grounding: [tables({ forward: true })],
      });

      const fragments = await adapter.introspect();
      const tableFragments = fragments.filter((f) => f.name === 'table');

      assert.deepStrictEqual(
        tableFragments.map((f) => f.data),
        [
          {
            name: 'authors',
            columns: [
              { name: 'column', data: { name: 'id', type: 'INTEGER' } },
              { name: 'column', data: { name: 'name', type: 'TEXT' } },
            ],
          },
          {
            name: 'books',
            columns: [
              { name: 'column', data: { name: 'id', type: 'INTEGER' } },
              { name: 'column', data: { name: 'author_id', type: 'INTEGER' } },
            ],
          },
        ],
      );
    });

    it('should handle composite foreign keys', async () => {
      const ddl = `
        CREATE TABLE warehouses (
          region TEXT,
          code TEXT,
          PRIMARY KEY (region, code)
        );
        CREATE TABLE inventory (
          id INTEGER PRIMARY KEY,
          wh_region TEXT,
          wh_code TEXT,
          FOREIGN KEY (wh_region, wh_code) REFERENCES warehouses(region, code)
        );
      `;

      const { adapter } = await init_db(ddl, {
        grounding: [tables({ forward: true })],
      });

      const fragments = await adapter.introspect();
      const tableFragments = fragments.filter((f) => f.name === 'table');

      assert.deepStrictEqual(
        tableFragments.map((f) => f.data),
        [
          {
            name: 'inventory',
            columns: [
              { name: 'column', data: { name: 'id', type: 'INTEGER' } },
              { name: 'column', data: { name: 'wh_region', type: 'TEXT' } },
              { name: 'column', data: { name: 'wh_code', type: 'TEXT' } },
            ],
          },
          {
            name: 'warehouses',
            columns: [
              { name: 'column', data: { name: 'region', type: 'TEXT' } },
              { name: 'column', data: { name: 'code', type: 'TEXT' } },
            ],
          },
        ],
      );
    });

    it('should handle multiple foreign keys from one table', async () => {
      const ddl = `
        CREATE TABLE users (id INTEGER PRIMARY KEY);
        CREATE TABLE products (id INTEGER PRIMARY KEY);
        CREATE TABLE orders (
          id INTEGER PRIMARY KEY,
          user_id INTEGER REFERENCES users(id),
          product_id INTEGER REFERENCES products(id)
        );
      `;

      const { adapter } = await init_db(ddl, {
        grounding: [tables({ forward: true })],
      });

      const fragments = await adapter.introspect();
      const tableFragments = fragments.filter((f) => f.name === 'table');

      assert.deepStrictEqual(
        tableFragments.map((f) => f.data),
        [
          {
            name: 'orders',
            columns: [
              { name: 'column', data: { name: 'id', type: 'INTEGER' } },
              { name: 'column', data: { name: 'user_id', type: 'INTEGER' } },
              { name: 'column', data: { name: 'product_id', type: 'INTEGER' } },
            ],
          },
          {
            name: 'products',
            columns: [
              { name: 'column', data: { name: 'id', type: 'INTEGER' } },
            ],
          },
          {
            name: 'users',
            columns: [
              { name: 'column', data: { name: 'id', type: 'INTEGER' } },
            ],
          },
        ],
      );
    });
  });

  describe('Suite 4: Traversal Behavior', () => {
    it('should return only seed tables when no traversal configured', async () => {
      const ddl = `
        CREATE TABLE parent (id INTEGER PRIMARY KEY);
        CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id));
      `;

      const { adapter } = await init_db(ddl, {
        grounding: [tables({ filter: ['child'] })],
      });

      const fragments = await adapter.introspect();
      const tableFragments = fragments.filter((f) => f.name === 'table');

      assert.deepStrictEqual(
        tableFragments.map((f) => f.data),
        [
          {
            name: 'child',
            columns: [
              { name: 'column', data: { name: 'id', type: 'INTEGER' } },
              { name: 'column', data: { name: 'parent_id', type: 'INTEGER' } },
            ],
          },
        ],
      );
    });

    it('should traverse forward following FK direction', async () => {
      const ddl = `
        CREATE TABLE grandparent (id INTEGER PRIMARY KEY);
        CREATE TABLE parent (id INTEGER PRIMARY KEY, gp_id INTEGER REFERENCES grandparent(id));
        CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id));
      `;

      const { adapter } = await init_db(ddl, {
        grounding: [tables({ filter: ['child'], forward: true })],
      });

      const fragments = await adapter.introspect();
      const tableFragments = fragments.filter((f) => f.name === 'table');

      assert.deepStrictEqual(
        tableFragments.map((f) => f.data),
        [
          {
            name: 'child',
            columns: [
              { name: 'column', data: { name: 'id', type: 'INTEGER' } },
              { name: 'column', data: { name: 'parent_id', type: 'INTEGER' } },
            ],
          },
          {
            name: 'parent',
            columns: [
              { name: 'column', data: { name: 'id', type: 'INTEGER' } },
              { name: 'column', data: { name: 'gp_id', type: 'INTEGER' } },
            ],
          },
          {
            name: 'grandparent',
            columns: [
              { name: 'column', data: { name: 'id', type: 'INTEGER' } },
            ],
          },
        ],
      );
    });

    it('should traverse backward finding referencing tables', async () => {
      const ddl = `
        CREATE TABLE parent (id INTEGER PRIMARY KEY);
        CREATE TABLE child1 (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id));
        CREATE TABLE child2 (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id));
      `;

      const { adapter } = await init_db(ddl, {
        grounding: [tables({ filter: ['parent'], backward: true })],
      });

      const fragments = await adapter.introspect();
      const tableFragments = fragments.filter((f) => f.name === 'table');

      assert.deepStrictEqual(
        tableFragments.map((f) => f.data),
        [
          {
            name: 'parent',
            columns: [
              { name: 'column', data: { name: 'id', type: 'INTEGER' } },
            ],
          },
          {
            name: 'child1',
            columns: [
              { name: 'column', data: { name: 'id', type: 'INTEGER' } },
              { name: 'column', data: { name: 'parent_id', type: 'INTEGER' } },
            ],
          },
          {
            name: 'child2',
            columns: [
              { name: 'column', data: { name: 'id', type: 'INTEGER' } },
              { name: 'column', data: { name: 'parent_id', type: 'INTEGER' } },
            ],
          },
        ],
      );
    });

    it('should respect forward depth limit', async () => {
      const ddl = `
        CREATE TABLE a (id INTEGER PRIMARY KEY);
        CREATE TABLE b (id INTEGER PRIMARY KEY, a_id INTEGER REFERENCES a(id));
        CREATE TABLE c (id INTEGER PRIMARY KEY, b_id INTEGER REFERENCES b(id));
      `;

      const { adapter } = await init_db(ddl, {
        grounding: [tables({ filter: ['c'], forward: 1 })],
      });

      const fragments = await adapter.introspect();
      const tableFragments = fragments.filter((f) => f.name === 'table');

      // c at depth 0, b at depth 1, a would be depth 2 (excluded)
      assert.deepStrictEqual(
        tableFragments.map((f) => f.data),
        [
          {
            name: 'c',
            columns: [
              { name: 'column', data: { name: 'id', type: 'INTEGER' } },
              { name: 'column', data: { name: 'b_id', type: 'INTEGER' } },
            ],
          },
          {
            name: 'b',
            columns: [
              { name: 'column', data: { name: 'id', type: 'INTEGER' } },
              { name: 'column', data: { name: 'a_id', type: 'INTEGER' } },
            ],
          },
        ],
      );
    });

    it('should traverse both directions with bidirectional config', async () => {
      const ddl = `
        CREATE TABLE parent (id INTEGER PRIMARY KEY);
        CREATE TABLE hub (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id));
        CREATE TABLE spoke1 (id INTEGER PRIMARY KEY, hub_id INTEGER REFERENCES hub(id));
        CREATE TABLE spoke2 (id INTEGER PRIMARY KEY, hub_id INTEGER REFERENCES hub(id));
      `;

      const { adapter } = await init_db(ddl, {
        grounding: [tables({ filter: ['hub'], forward: true, backward: true })],
      });

      const fragments = await adapter.introspect();
      const tableFragments = fragments.filter((f) => f.name === 'table');

      assert.deepStrictEqual(
        tableFragments.map((f) => f.data),
        [
          {
            name: 'hub',
            columns: [
              { name: 'column', data: { name: 'id', type: 'INTEGER' } },
              { name: 'column', data: { name: 'parent_id', type: 'INTEGER' } },
            ],
          },
          {
            name: 'parent',
            columns: [
              { name: 'column', data: { name: 'id', type: 'INTEGER' } },
            ],
          },
          {
            name: 'spoke1',
            columns: [
              { name: 'column', data: { name: 'id', type: 'INTEGER' } },
              { name: 'column', data: { name: 'hub_id', type: 'INTEGER' } },
            ],
          },
          {
            name: 'spoke2',
            columns: [
              { name: 'column', data: { name: 'id', type: 'INTEGER' } },
              { name: 'column', data: { name: 'hub_id', type: 'INTEGER' } },
            ],
          },
        ],
      );
    });
  });

  describe('Suite 5: Filter Behavior', () => {
    it('should filter by explicit table name array', async () => {
      const ddl = `
        CREATE TABLE users (id INTEGER PRIMARY KEY);
        CREATE TABLE posts (id INTEGER PRIMARY KEY);
        CREATE TABLE comments (id INTEGER PRIMARY KEY);
      `;

      const { adapter } = await init_db(ddl, {
        grounding: [tables({ filter: ['users', 'posts'] })],
      });

      const fragments = await adapter.introspect();
      const tableFragments = fragments.filter((f) => f.name === 'table');

      assert.deepStrictEqual(
        tableFragments.map((f) => f.data),
        [
          {
            name: 'users',
            columns: [
              { name: 'column', data: { name: 'id', type: 'INTEGER' } },
            ],
          },
          {
            name: 'posts',
            columns: [
              { name: 'column', data: { name: 'id', type: 'INTEGER' } },
            ],
          },
        ],
      );
    });

    it('should filter by regex pattern', async () => {
      const ddl = `
        CREATE TABLE order_items (id INTEGER PRIMARY KEY);
        CREATE TABLE order_history (id INTEGER PRIMARY KEY);
        CREATE TABLE products (id INTEGER PRIMARY KEY);
      `;

      const { adapter } = await init_db(ddl, {
        grounding: [tables({ filter: /^order/ })],
      });

      const fragments = await adapter.introspect();
      const tableFragments = fragments.filter((f) => f.name === 'table');

      assert.deepStrictEqual(
        tableFragments.map((f) => f.data),
        [
          {
            name: 'order_history',
            columns: [
              { name: 'column', data: { name: 'id', type: 'INTEGER' } },
            ],
          },
          {
            name: 'order_items',
            columns: [
              { name: 'column', data: { name: 'id', type: 'INTEGER' } },
            ],
          },
        ],
      );
    });

    it('should filter by predicate function', async () => {
      const ddl = `
        CREATE TABLE user_profiles (id INTEGER PRIMARY KEY);
        CREATE TABLE user_settings (id INTEGER PRIMARY KEY);
        CREATE TABLE products (id INTEGER PRIMARY KEY);
      `;

      const { adapter } = await init_db(ddl, {
        grounding: [tables({ filter: (name) => name.startsWith('user_') })],
      });

      const fragments = await adapter.introspect();
      const tableFragments = fragments.filter((f) => f.name === 'table');

      assert.deepStrictEqual(
        tableFragments.map((f) => f.data),
        [
          {
            name: 'user_profiles',
            columns: [
              { name: 'column', data: { name: 'id', type: 'INTEGER' } },
            ],
          },
          {
            name: 'user_settings',
            columns: [
              { name: 'column', data: { name: 'id', type: 'INTEGER' } },
            ],
          },
        ],
      );
    });
  });
});
