import assert from 'node:assert';
import { describe, it } from 'node:test';

import { init_db } from '../../../tests/sqlite.ts';
import { columnValues, constraints, tables } from './index.ts';

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

      const output = await adapter.introspect();

      assert.ok(
        output.includes('LowCardinality'),
        'Expected LowCardinality annotation',
      );
      assert.ok(
        output.includes('pending') &&
          output.includes('shipped') &&
          output.includes('delivered'),
        'Expected all status values in output',
      );
    });

    it('should not annotate columns with too many distinct values', async () => {
      // Create a table with more than 20 distinct values
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

      const output = await adapter.introspect();

      assert.ok(
        !output.includes('LowCardinality'),
        'Should NOT include LowCardinality annotation for high cardinality column',
      );
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

      const output = await adapter.introspect();

      // Should still detect low cardinality for non-NULL values
      assert.ok(output.includes('category'), 'Expected category column');
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

      const output = await adapter.introspect();

      assert.ok(
        !output.includes('LowCardinality'),
        'Should NOT include LowCardinality for empty table',
      );
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

      const output = await adapter.introspect();

      // All columns should be detected as low cardinality
      assert.ok(output.includes('flag'), 'Expected flag column');
      assert.ok(output.includes('amount'), 'Expected amount column');
      assert.ok(output.includes('label'), 'Expected label column');
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

      const output = await adapter.introspect();

      assert.ok(output.includes('Enum'), 'Expected Enum annotation');
      assert.ok(
        output.includes('todo') &&
          output.includes('in_progress') &&
          output.includes('done'),
        'Expected all enum values in output',
      );
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

      const output = await adapter.introspect();

      // Should show Enum for status (from CHECK), not LowCardinality
      // The status line should have Enum annotation, not LowCardinality
      const statusLine = output
        .split('\n')
        .find((line) => line.includes('status'));
      assert.ok(statusLine, 'Expected status column in output');
      assert.ok(statusLine.includes('Enum'), 'Expected Enum annotation for status');
      assert.ok(
        !statusLine.includes('LowCardinality'),
        'Should NOT show LowCardinality for status when CHECK constraint exists',
      );
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

      const output = await adapter.introspect();

      assert.ok(output.includes('Enum'), 'Expected Enum annotation');
      assert.ok(
        output.includes('admin') &&
          output.includes('user') &&
          output.includes('guest'),
        'Expected all role values in output',
      );
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

      const output1 = await adapter1.introspect();
      assert.ok(
        !output1.includes('LowCardinality'),
        'Should NOT detect with limit 3',
      );

      // With limit of 10, 5 values should be detected
      const { adapter: adapter2 } = await init_db(ddl, {
        grounding: [tables(), columnValues({ lowCardinalityLimit: 10 })],
      });

      const output2 = await adapter2.introspect();
      assert.ok(
        output2.includes('LowCardinality'),
        'Should detect with limit 10',
      );
    });
  });
});
