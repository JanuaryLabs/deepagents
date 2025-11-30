import assert from 'node:assert';
import { describe, it } from 'node:test';

import { init_db } from '../../../tests/sqlite.ts';
import { tables } from './index.ts';

describe('SqliteTableGrounding', () => {
  describe('Suite 1: Edge Cases', () => {
    it('should return schema unavailable for empty database', async () => {
      const { adapter } = await init_db('', {
        grounding: [tables()],
      });

      const output = await adapter.introspect();

      assert.ok(
        output.includes('Schema unavailable'),
        'Expected "Schema unavailable" in output',
      );
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

      const output = await adapter.introspect();

      assert.ok(output.includes('employees'), 'Expected "employees" table');
      assert.ok(
        output.includes('manager_id'),
        'Expected "manager_id" column in output',
      );
    });

    it('should handle circular foreign key references without infinite loop', async () => {
      // SQLite doesn't support ALTER TABLE ADD CONSTRAINT, so we create
      // tables with FKs inline (requires creating referenced table first)
      const ddl = [
        'CREATE TABLE a (id INTEGER PRIMARY KEY, b_id INTEGER);',
        'CREATE TABLE b (id INTEGER PRIMARY KEY, a_id INTEGER REFERENCES a(id));',
      ];

      const { adapter } = await init_db(ddl, {
        grounding: [tables({ forward: true, backward: true })],
      });

      const output = await adapter.introspect();

      assert.ok(output.includes('Table: a'), 'Expected table "a" in output');
      assert.ok(output.includes('Table: b'), 'Expected table "b" in output');
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
        grounding: [tables()],
      });

      const output = await adapter.introspect();

      assert.ok(output.includes('Table: users'), 'Expected "users" table');
      assert.ok(output.includes('id (INTEGER)'), 'Expected id column');
      assert.ok(output.includes('email (TEXT)'), 'Expected email column');
      assert.ok(
        output.includes('created_at (INTEGER)'),
        'Expected created_at column',
      );
      assert.ok(output.includes('[PK]'), 'Expected primary key annotation');
    });

    it('should discover multiple unrelated tables', async () => {
      const ddl = `
        CREATE TABLE products (id INTEGER PRIMARY KEY, name TEXT);
        CREATE TABLE categories (id INTEGER PRIMARY KEY, label TEXT);
      `;

      const { adapter } = await init_db(ddl, {
        grounding: [tables()],
      });

      const output = await adapter.introspect();

      assert.ok(
        output.includes('Table: products'),
        'Expected "products" table',
      );
      assert.ok(
        output.includes('Table: categories'),
        'Expected "categories" table',
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

      const output = await adapter.introspect();

      assert.ok(output.includes('Table: authors'), 'Expected "authors" table');
      assert.ok(output.includes('Table: books'), 'Expected "books" table');
      assert.ok(output.includes('author_id'), 'Expected author_id column');
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

      const output = await adapter.introspect();

      assert.ok(
        output.includes('Table: warehouses'),
        'Expected "warehouses" table',
      );
      assert.ok(
        output.includes('Table: inventory'),
        'Expected "inventory" table',
      );
      assert.ok(output.includes('wh_region'), 'Expected wh_region column');
      assert.ok(output.includes('wh_code'), 'Expected wh_code column');
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

      const output = await adapter.introspect();

      assert.ok(output.includes('Table: users'), 'Expected "users" table');
      assert.ok(output.includes('Table: products'), 'Expected "products" table');
      assert.ok(output.includes('Table: orders'), 'Expected "orders" table');
      assert.ok(output.includes('user_id'), 'Expected user_id column');
      assert.ok(output.includes('product_id'), 'Expected product_id column');
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

      const output = await adapter.introspect();

      assert.ok(output.includes('Table: child'), 'Expected "child" table');
      assert.ok(
        !output.includes('Table: parent'),
        'Should NOT include "parent" table without traversal',
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

      const output = await adapter.introspect();

      assert.ok(output.includes('Table: child'), 'Expected "child" table');
      assert.ok(output.includes('Table: parent'), 'Expected "parent" table');
      assert.ok(
        output.includes('Table: grandparent'),
        'Expected "grandparent" table',
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

      const output = await adapter.introspect();

      assert.ok(output.includes('Table: parent'), 'Expected "parent" table');
      assert.ok(output.includes('Table: child1'), 'Expected "child1" table');
      assert.ok(output.includes('Table: child2'), 'Expected "child2" table');
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

      const output = await adapter.introspect();

      assert.ok(output.includes('Table: c'), 'Expected "c" table');
      assert.ok(output.includes('Table: b'), 'Expected "b" table at depth 1');
      assert.ok(
        !output.includes('Table: a'),
        'Should NOT include "a" table (depth 2 exceeds limit)',
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

      const output = await adapter.introspect();

      assert.ok(output.includes('Table: hub'), 'Expected "hub" table');
      assert.ok(
        output.includes('Table: parent'),
        'Expected "parent" table (forward)',
      );
      assert.ok(
        output.includes('Table: spoke1'),
        'Expected "spoke1" table (backward)',
      );
      assert.ok(
        output.includes('Table: spoke2'),
        'Expected "spoke2" table (backward)',
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

      const output = await adapter.introspect();

      assert.ok(output.includes('Table: users'), 'Expected "users" table');
      assert.ok(output.includes('Table: posts'), 'Expected "posts" table');
      assert.ok(
        !output.includes('Table: comments'),
        'Should NOT include "comments" table',
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

      const output = await adapter.introspect();

      assert.ok(
        output.includes('Table: order_items'),
        'Expected "order_items" table',
      );
      assert.ok(
        output.includes('Table: order_history'),
        'Expected "order_history" table',
      );
      assert.ok(
        !output.includes('Table: products'),
        'Should NOT include "products" table',
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

      const output = await adapter.introspect();

      assert.ok(
        output.includes('Table: user_profiles'),
        'Expected "user_profiles" table',
      );
      assert.ok(
        output.includes('Table: user_settings'),
        'Expected "user_settings" table',
      );
      assert.ok(
        !output.includes('Table: products'),
        'Should NOT include "products" table',
      );
    });
  });
});
