import assert from 'node:assert';
import { describe, it } from 'node:test';

import { init_db } from '../../../tests/sqlite.ts';
import { lowCardinality, tables } from './index.ts';

describe('SqliteLowCardinalityGrounding', () => {
  describe('Suite 1: Low Cardinality Detection', () => {
    it('should detect low cardinality column with few distinct values', async () => {
      // Arrange
      const ddl = `
        CREATE TABLE products (
          id INTEGER PRIMARY KEY,
          status TEXT
        );
        INSERT INTO products (status) VALUES ('active'), ('inactive'), ('pending');
      `;
      const { adapter } = await init_db(ddl, {
        grounding: [tables(), lowCardinality({ limit: 5 })],
      });

      // Act
      const output = await adapter.introspect();

      // Assert
      assert.ok(
        output.includes('LowCardinality: active, inactive, pending') ||
        output.includes('LowCardinality: inactive, active, pending') ||
        output.includes('LowCardinality: pending, active, inactive'),
        `Expected low cardinality annotation with values, got:\n${output}`,
      );
    });

    it('should not mark column exceeding limit as low cardinality', async () => {
      // Arrange
      const limit = 5;
      const ddl = `
        CREATE TABLE users (
          id INTEGER PRIMARY KEY,
          username TEXT
        );
      `;
      const { adapter, db } = await init_db(ddl, {
        grounding: [tables(), lowCardinality({ limit })],
      });
      // Insert more values than the limit
      for (let i = 0; i < limit + 2; i++) {
        db.exec(`INSERT INTO users (username) VALUES ('user_${i}')`);
      }

      // Act
      const output = await adapter.introspect();

      // Assert
      const usernameColumnLine = output.split('\n').find((line) => line.includes('username (TEXT)'));
      assert.ok(usernameColumnLine, `Expected username column in output, got:\n${output}`);
      assert.ok(
        !usernameColumnLine.includes('LowCardinality'),
        `Expected username column to NOT have LowCardinality annotation (${limit + 2} values exceeds limit of ${limit}), got:\n${usernameColumnLine}`,
      );
    });

    it('should include column with exactly limit distinct values (boundary case)', async () => {
      // Arrange
      const limit = 5;
      const ddl = `
        CREATE TABLE items (
          id INTEGER PRIMARY KEY,
          category TEXT
        );
      `;
      const { adapter, db } = await init_db(ddl, {
        grounding: [tables(), lowCardinality({ limit })],
      });
      // Insert exactly limit values
      for (let i = 0; i < limit; i++) {
        db.exec(`INSERT INTO items (category) VALUES ('cat_${i}')`);
      }

      // Act
      const output = await adapter.introspect();

      // Assert
      const categoryColumnLine = output.split('\n').find((line) => line.includes('category (TEXT)'));
      assert.ok(categoryColumnLine, `Expected category column in output, got:\n${output}`);
      assert.ok(
        categoryColumnLine.includes('LowCardinality'),
        `Expected LowCardinality annotation for exactly ${limit} values, got:\n${categoryColumnLine}`,
      );
      assert.ok(
        output.includes('cat_0'),
        `Expected cat_0 in low cardinality values, got:\n${output}`,
      );
    });

    it('should exclude column with limit + 1 distinct values (exceeds threshold)', async () => {
      // Arrange
      const limit = 5;
      const ddl = `
        CREATE TABLE items (
          id INTEGER PRIMARY KEY,
          category TEXT
        );
      `;
      const { adapter, db } = await init_db(ddl, {
        grounding: [tables(), lowCardinality({ limit })],
      });
      // Insert limit + 1 values
      for (let i = 0; i < limit + 1; i++) {
        db.exec(`INSERT INTO items (category) VALUES ('cat_${i}')`);
      }

      // Act
      const output = await adapter.introspect();

      // Assert
      const categoryColumnLine = output.split('\n').find((line) => line.includes('category (TEXT)'));
      assert.ok(categoryColumnLine, `Expected category column in output, got:\n${output}`);
      assert.ok(
        !categoryColumnLine.includes('LowCardinality'),
        `Expected no LowCardinality annotation for ${limit + 1} values (exceeds limit of ${limit}), got:\n${categoryColumnLine}`,
      );
    });

    it('should respect custom limit configuration', async () => {
      // Arrange
      const ddl = `
        CREATE TABLE status_codes (
          id INTEGER PRIMARY KEY,
          code TEXT
        );
        INSERT INTO status_codes (code) VALUES ('A'), ('B'), ('C');
      `;

      // Act & Assert with limit: 2 (should NOT include - 3 values exceeds limit)
      const { adapter: adapter2 } = await init_db(ddl, {
        grounding: [tables(), lowCardinality({ limit: 2 })],
      });
      const output2 = await adapter2.introspect();
      const codeLine2 = output2.split('\n').find((line) => line.includes('code (TEXT)'));
      assert.ok(codeLine2, `Expected code column in output`);
      assert.ok(
        !codeLine2.includes('LowCardinality'),
        `Expected no LowCardinality with limit: 2 for 3 values, got:\n${codeLine2}`,
      );

      // Act & Assert with limit: 3 (should include - 3 values equals limit)
      const { adapter: adapter3 } = await init_db(ddl, {
        grounding: [tables(), lowCardinality({ limit: 3 })],
      });
      const output3 = await adapter3.introspect();
      const codeLine3 = output3.split('\n').find((line) => line.includes('code (TEXT)'));
      assert.ok(codeLine3, `Expected code column in output`);
      assert.ok(
        codeLine3.includes('LowCardinality'),
        `Expected LowCardinality with limit: 3 for 3 values, got:\n${codeLine3}`,
      );

      // Act & Assert with limit: 10 (should include - 3 values within limit)
      const { adapter: adapter10 } = await init_db(ddl, {
        grounding: [tables(), lowCardinality({ limit: 10 })],
      });
      const output10 = await adapter10.introspect();
      const codeLine10 = output10.split('\n').find((line) => line.includes('code (TEXT)'));
      assert.ok(codeLine10, `Expected code column in output`);
      assert.ok(
        codeLine10.includes('LowCardinality'),
        `Expected LowCardinality with limit: 10 for 3 values, got:\n${codeLine10}`,
      );
    });

    it('should use default limit of 20 when not specified', async () => {
      // Arrange
      const ddl = `
        CREATE TABLE defaults (
          id INTEGER PRIMARY KEY,
          value TEXT
        );
      `;
      const { adapter, db } = await init_db(ddl, {
        grounding: [tables(), lowCardinality()], // No limit specified
      });
      // Insert exactly 20 values (should be included with default limit)
      for (let i = 0; i < 20; i++) {
        db.exec(`INSERT INTO defaults (value) VALUES ('val_${i}')`);
      }

      // Act
      const output = await adapter.introspect();

      // Assert
      const valueColumnLine = output.split('\n').find((line) => line.includes('value (TEXT)'));
      assert.ok(valueColumnLine, `Expected value column in output, got:\n${output}`);
      assert.ok(
        valueColumnLine.includes('LowCardinality'),
        `Expected LowCardinality annotation with default limit of 20, got:\n${valueColumnLine}`,
      );
    });
  });

  describe('Suite 2: Empty and NULL Handling', () => {
    it('should not annotate column in empty table', async () => {
      // Arrange
      const ddl = `
        CREATE TABLE empty_table (
          id INTEGER PRIMARY KEY,
          status TEXT
        );
      `;
      const { adapter } = await init_db(ddl, {
        grounding: [tables(), lowCardinality({ limit: 5 })],
      });

      // Act
      const output = await adapter.introspect();

      // Assert
      const statusColumnLine = output.split('\n').find((line) => line.includes('status (TEXT)'));
      assert.ok(statusColumnLine, `Expected status column in output, got:\n${output}`);
      assert.ok(
        !statusColumnLine.includes('LowCardinality'),
        `Expected no LowCardinality annotation for empty table, got:\n${statusColumnLine}`,
      );
    });

    it('should exclude NULL values from distinct count', async () => {
      // Arrange
      const ddl = `
        CREATE TABLE records (
          id INTEGER PRIMARY KEY,
          type TEXT
        );
        INSERT INTO records (type) VALUES ('A'), ('B'), (NULL), (NULL);
      `;
      const { adapter } = await init_db(ddl, {
        grounding: [tables(), lowCardinality({ limit: 5 })],
      });

      // Act
      const output = await adapter.introspect();

      // Assert
      assert.ok(
        output.includes('LowCardinality:'),
        `Expected LowCardinality annotation, got:\n${output}`,
      );
      assert.ok(
        output.includes('A') && output.includes('B'),
        `Expected values A and B in output, got:\n${output}`,
      );
      assert.ok(
        !output.includes('LowCardinality: null') && !output.includes('LowCardinality: NULL'),
        `Expected NULL to be excluded from values, got:\n${output}`,
      );
    });

    it('should not annotate column with only NULL values', async () => {
      // Arrange
      const ddl = `
        CREATE TABLE null_only (
          id INTEGER PRIMARY KEY,
          value TEXT
        );
        INSERT INTO null_only (value) VALUES (NULL), (NULL);
      `;
      const { adapter } = await init_db(ddl, {
        grounding: [tables(), lowCardinality({ limit: 5 })],
      });

      // Act
      const output = await adapter.introspect();

      // Assert
      const valueColumnLine = output.split('\n').find((line) => line.includes('value (TEXT)'));
      assert.ok(valueColumnLine, `Expected value column in output, got:\n${output}`);
      assert.ok(
        !valueColumnLine.includes('LowCardinality'),
        `Expected value column to NOT have LowCardinality annotation, got:\n${valueColumnLine}`,
      );
    });
  });

  describe('Suite 3: Value Type Normalization', () => {
    it('should normalize string values', async () => {
      // Arrange
      const ddl = `
        CREATE TABLE strings (
          id INTEGER PRIMARY KEY,
          name TEXT
        );
        INSERT INTO strings (name) VALUES ('Alice'), ('Bob');
      `;
      const { adapter } = await init_db(ddl, {
        grounding: [tables(), lowCardinality({ limit: 5 })],
      });

      // Act
      const output = await adapter.introspect();

      // Assert
      assert.ok(
        output.includes('LowCardinality:') && output.includes('Alice') && output.includes('Bob'),
        `Expected LowCardinality with Alice and Bob, got:\n${output}`,
      );
    });

    it('should normalize integer values to strings', async () => {
      // Arrange
      const ddl = `
        CREATE TABLE numbers (
          id INTEGER PRIMARY KEY,
          priority INTEGER
        );
        INSERT INTO numbers (priority) VALUES (1), (2), (3);
      `;
      const { adapter } = await init_db(ddl, {
        grounding: [tables(), lowCardinality({ limit: 5 })],
      });

      // Act
      const output = await adapter.introspect();

      // Assert
      const priorityColumnLine = output.split('\n').find((line) => line.includes('priority (INTEGER)'));
      assert.ok(priorityColumnLine, `Expected priority column in output, got:\n${output}`);
      assert.ok(
        priorityColumnLine.includes('LowCardinality'),
        `Expected LowCardinality annotation for integer column, got:\n${priorityColumnLine}`,
      );
      assert.ok(
        priorityColumnLine.includes('1') && priorityColumnLine.includes('2') && priorityColumnLine.includes('3'),
        `Expected values 1, 2, 3 in output, got:\n${priorityColumnLine}`,
      );
    });

    it('should normalize boolean-like integer values', async () => {
      // Arrange
      const ddl = `
        CREATE TABLE flags (
          id INTEGER PRIMARY KEY,
          is_active INTEGER
        );
        INSERT INTO flags (is_active) VALUES (0), (1);
      `;
      const { adapter } = await init_db(ddl, {
        grounding: [tables(), lowCardinality({ limit: 5 })],
      });

      // Act
      const output = await adapter.introspect();

      // Assert
      const isActiveColumnLine = output.split('\n').find((line) => line.includes('is_active (INTEGER)'));
      assert.ok(isActiveColumnLine, `Expected is_active column in output, got:\n${output}`);
      assert.ok(
        isActiveColumnLine.includes('LowCardinality'),
        `Expected LowCardinality annotation, got:\n${isActiveColumnLine}`,
      );
      assert.ok(
        isActiveColumnLine.includes('0') && isActiveColumnLine.includes('1'),
        `Expected values 0 and 1 in output, got:\n${isActiveColumnLine}`,
      );
    });

    it('should normalize real/float values', async () => {
      // Arrange
      const ddl = `
        CREATE TABLE measurements (
          id INTEGER PRIMARY KEY,
          rating REAL
        );
        INSERT INTO measurements (rating) VALUES (1.5), (2.5), (3.5);
      `;
      const { adapter } = await init_db(ddl, {
        grounding: [tables(), lowCardinality({ limit: 5 })],
      });

      // Act
      const output = await adapter.introspect();

      // Assert
      const ratingColumnLine = output.split('\n').find((line) => line.includes('rating (REAL)'));
      assert.ok(ratingColumnLine, `Expected rating column in output, got:\n${output}`);
      assert.ok(
        ratingColumnLine.includes('LowCardinality'),
        `Expected LowCardinality annotation for float column, got:\n${ratingColumnLine}`,
      );
      assert.ok(
        ratingColumnLine.includes('1.5') && ratingColumnLine.includes('2.5') && ratingColumnLine.includes('3.5'),
        `Expected float values in output, got:\n${ratingColumnLine}`,
      );
    });
  });

  describe('Suite 4: Multiple Tables and Columns', () => {
    it('should process multiple columns in same table', async () => {
      // Arrange
      const ddl = `
        CREATE TABLE orders (
          id INTEGER PRIMARY KEY,
          status TEXT,
          payment_method TEXT
        );
        INSERT INTO orders (status, payment_method) VALUES
          ('pending', 'card'),
          ('shipped', 'paypal'),
          ('delivered', 'card');
      `;
      const { adapter } = await init_db(ddl, {
        grounding: [tables(), lowCardinality({ limit: 5 })],
      });

      // Act
      const output = await adapter.introspect();

      // Assert
      const lowCardMatches = output.match(/LowCardinality:/g) || [];
      assert.ok(
        lowCardMatches.length >= 2,
        `Expected at least 2 LowCardinality annotations (status and payment_method), got ${lowCardMatches.length}:\n${output}`,
      );
      assert.ok(
        output.includes('pending') && output.includes('shipped') && output.includes('delivered'),
        `Expected status values in output, got:\n${output}`,
      );
      assert.ok(
        output.includes('card') && output.includes('paypal'),
        `Expected payment_method values in output, got:\n${output}`,
      );
    });

    it('should process multiple tables independently', async () => {
      // Arrange
      const ddl = `
        CREATE TABLE users (
          id INTEGER PRIMARY KEY,
          role TEXT
        );
        CREATE TABLE products (
          id INTEGER PRIMARY KEY,
          category TEXT
        );
        INSERT INTO users (role) VALUES ('admin'), ('user');
        INSERT INTO products (category) VALUES ('electronics'), ('clothing');
      `;
      const { adapter } = await init_db(ddl, {
        grounding: [tables(), lowCardinality({ limit: 5 })],
      });

      // Act
      const output = await adapter.introspect();

      // Assert
      assert.ok(
        output.includes('admin') && output.includes('user'),
        `Expected role values in output, got:\n${output}`,
      );
      assert.ok(
        output.includes('electronics') && output.includes('clothing'),
        `Expected category values in output, got:\n${output}`,
      );
    });

    it('should handle mixed cardinality columns in same table', async () => {
      // Arrange
      const limit = 5;
      const ddl = `
        CREATE TABLE events (
          id INTEGER PRIMARY KEY,
          event_type TEXT,
          event_id TEXT
        );
      `;
      const { adapter, db } = await init_db(ddl, {
        grounding: [tables(), lowCardinality({ limit })],
      });
      // event_type has low cardinality (2 values)
      // event_id has high cardinality (limit + 2 unique values)
      for (let i = 0; i < limit + 2; i++) {
        const type = i % 2 === 0 ? 'click' : 'view';
        db.exec(`INSERT INTO events (event_type, event_id) VALUES ('${type}', 'evt_${i}')`);
      }

      // Act
      const output = await adapter.introspect();

      // Assert
      const eventTypeColumnLine = output.split('\n').find((line) => line.includes('event_type (TEXT)'));
      const eventIdColumnLine = output.split('\n').find((line) => line.includes('event_id (TEXT)'));

      assert.ok(eventTypeColumnLine, `Expected event_type column in output, got:\n${output}`);
      assert.ok(eventIdColumnLine, `Expected event_id column in output, got:\n${output}`);

      assert.ok(
        eventTypeColumnLine.includes('LowCardinality'),
        `Expected event_type to have LowCardinality (2 values within limit of ${limit}), got:\n${eventTypeColumnLine}`,
      );
      assert.ok(
        !eventIdColumnLine.includes('LowCardinality'),
        `Expected event_id to NOT have LowCardinality (${limit + 2} values exceeds limit of ${limit}), got:\n${eventIdColumnLine}`,
      );
      assert.ok(
        eventTypeColumnLine.includes('click') && eventTypeColumnLine.includes('view'),
        `Expected event_type values (click, view) in output, got:\n${eventTypeColumnLine}`,
      );
    });
  });

  describe('Suite 5: Edge Cases', () => {
    it('should handle special characters in values', async () => {
      // Arrange
      const ddl = `
        CREATE TABLE special (
          id INTEGER PRIMARY KEY,
          symbol TEXT
        );
        INSERT INTO special (symbol) VALUES ('a''b'), ('c"d');
      `;
      const { adapter } = await init_db(ddl, {
        grounding: [tables(), lowCardinality({ limit: 5 })],
      });

      // Act
      const output = await adapter.introspect();

      // Assert
      const symbolColumnLine = output.split('\n').find((line) => line.includes('symbol (TEXT)'));
      assert.ok(symbolColumnLine, `Expected symbol column in output, got:\n${output}`);
      assert.ok(
        symbolColumnLine.includes('LowCardinality'),
        `Expected LowCardinality annotation for special characters, got:\n${symbolColumnLine}`,
      );
    });

    it('should handle empty string as a valid distinct value', async () => {
      // Arrange
      const ddl = `
        CREATE TABLE with_empty (
          id INTEGER PRIMARY KEY,
          value TEXT
        );
        INSERT INTO with_empty (value) VALUES (''), ('a'), ('b');
      `;
      const { adapter } = await init_db(ddl, {
        grounding: [tables(), lowCardinality({ limit: 5 })],
      });

      // Act
      const output = await adapter.introspect();

      // Assert
      const valueColumnLine = output.split('\n').find((line) => line.includes('value (TEXT)'));
      assert.ok(valueColumnLine, `Expected value column in output, got:\n${output}`);
      assert.ok(
        valueColumnLine.includes('LowCardinality'),
        `Expected LowCardinality annotation, got:\n${valueColumnLine}`,
      );
      assert.ok(
        valueColumnLine.includes('a') && valueColumnLine.includes('b'),
        `Expected non-empty values in output, got:\n${valueColumnLine}`,
      );
    });

    it('should handle unicode values', async () => {
      // Arrange
      const ddl = `
        CREATE TABLE unicode (
          id INTEGER PRIMARY KEY,
          emoji TEXT
        );
        INSERT INTO unicode (emoji) VALUES ('😀'), ('🎉'), ('👍');
      `;
      const { adapter } = await init_db(ddl, {
        grounding: [tables(), lowCardinality({ limit: 5 })],
      });

      // Act
      const output = await adapter.introspect();

      // Assert
      const emojiColumnLine = output.split('\n').find((line) => line.includes('emoji (TEXT)'));
      assert.ok(emojiColumnLine, `Expected emoji column in output, got:\n${output}`);
      assert.ok(
        emojiColumnLine.includes('LowCardinality'),
        `Expected LowCardinality annotation for unicode values, got:\n${emojiColumnLine}`,
      );
      assert.ok(
        emojiColumnLine.includes('😀') && emojiColumnLine.includes('🎉') && emojiColumnLine.includes('👍'),
        `Expected emoji values in output, got:\n${emojiColumnLine}`,
      );
    });

    it('should handle reserved SQL keywords as table/column names', async () => {
      // Arrange
      const ddl = `
        CREATE TABLE "select" (
          "id" INTEGER PRIMARY KEY,
          "order" TEXT
        );
        INSERT INTO "select" ("order") VALUES ('first'), ('second');
      `;
      const { adapter } = await init_db(ddl, {
        grounding: [tables(), lowCardinality({ limit: 5 })],
      });

      // Act
      const output = await adapter.introspect();

      // Assert
      const orderColumnLine = output.split('\n').find((line) => line.includes('order (TEXT)'));
      assert.ok(orderColumnLine, `Expected order column in output, got:\n${output}`);
      assert.ok(
        orderColumnLine.includes('LowCardinality'),
        `Expected LowCardinality annotation for reserved keyword column, got:\n${orderColumnLine}`,
      );
      assert.ok(
        orderColumnLine.includes('first') && orderColumnLine.includes('second'),
        `Expected values in output, got:\n${orderColumnLine}`,
      );
    });

    it('should handle single distinct value', async () => {
      // Arrange
      const ddl = `
        CREATE TABLE single_value (
          id INTEGER PRIMARY KEY,
          status TEXT
        );
        INSERT INTO single_value (status) VALUES ('active'), ('active'), ('active');
      `;
      const { adapter } = await init_db(ddl, {
        grounding: [tables(), lowCardinality({ limit: 5 })],
      });

      // Act
      const output = await adapter.introspect();

      // Assert
      const statusColumnLine = output.split('\n').find((line) => line.includes('status (TEXT)'));
      assert.ok(statusColumnLine, `Expected status column in output, got:\n${output}`);
      assert.ok(
        statusColumnLine.includes('LowCardinality: active'),
        `Expected LowCardinality with single value 'active', got:\n${statusColumnLine}`,
      );
    });
  });
});
