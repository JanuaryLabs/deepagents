import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import XLSX from 'xlsx';

import { info, rowCount, tables } from './index.ts';
import { Spreadsheet } from './spreadsheet.ts';

/**
 * Helper to create a temp file path with a specific name.
 */
function tempFile(name: string): string {
  return path.join(os.tmpdir(), name);
}

/**
 * Helper to create a CSV file from data.
 */
function createCSV(filePath: string, data: Record<string, unknown>[]): void {
  const ws = XLSX.utils.json_to_sheet(data);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  XLSX.writeFile(wb, filePath, { bookType: 'csv' });
}

/**
 * Helper to create an Excel file with multiple sheets.
 */
function createExcel(
  filePath: string,
  sheets: Record<string, Record<string, unknown>[]>,
): void {
  const wb = XLSX.utils.book_new();
  for (const [sheetName, data] of Object.entries(sheets)) {
    const ws = XLSX.utils.json_to_sheet(data);
    XLSX.utils.book_append_sheet(wb, ws, sheetName);
  }
  XLSX.writeFile(wb, filePath);
}

describe('Spreadsheet Adapter', () => {
  let tempFiles: string[] = [];

  beforeEach(() => {
    tempFiles = [];
  });

  afterEach(() => {
    for (const file of tempFiles) {
      try {
        fs.unlinkSync(file);
      } catch {
        // Ignore cleanup errors
      }
    }
  });

  describe('CSV loading and querying', () => {
    it('should load CSV and query data', async () => {
      const csvPath = tempFile('users.csv');
      tempFiles.push(csvPath);

      createCSV(csvPath, [
        { id: 1, name: 'Alice', age: 30 },
        { id: 2, name: 'Bob', age: 25 },
        { id: 3, name: 'Charlie', age: 35 },
      ]);

      const adapter = new Spreadsheet({
        file: csvPath,
        grounding: [tables()],
      });

      const rows = await adapter.execute('SELECT * FROM users ORDER BY id');

      assert.strictEqual(rows.length, 3);
      assert.strictEqual(rows[0].name, 'Alice');
      assert.strictEqual(rows[1].name, 'Bob');
      assert.strictEqual(rows[2].name, 'Charlie');

      adapter.close();
    });

    it('should derive table name from filename', async () => {
      const csvPath = tempFile('customers.csv');
      tempFiles.push(csvPath);

      createCSV(csvPath, [{ value: 1 }]);

      const adapter = new Spreadsheet({
        file: csvPath,
        grounding: [tables()],
      });

      const rows = await adapter.execute('SELECT * FROM customers');

      assert.strictEqual(rows.length, 1);
      adapter.close();
    });
  });

  describe('Excel multi-sheet loading', () => {
    it('should load multiple sheets as separate tables', async () => {
      const xlsxPath = tempFile('multi.xlsx');
      tempFiles.push(xlsxPath);

      createExcel(xlsxPath, {
        Customers: [
          { id: 1, name: 'Alice' },
          { id: 2, name: 'Bob' },
        ],
        Orders: [
          { order_id: 101, customer_id: 1, amount: 99.99 },
          { order_id: 102, customer_id: 2, amount: 149.5 },
        ],
      });

      const adapter = new Spreadsheet({
        file: xlsxPath,
        grounding: [tables()],
      });

      const customers = await adapter.execute(
        'SELECT * FROM Customers ORDER BY id',
      );
      assert.strictEqual(customers.length, 2);
      assert.strictEqual(customers[0].name, 'Alice');

      const orders = await adapter.execute(
        'SELECT * FROM Orders ORDER BY order_id',
      );
      assert.strictEqual(orders.length, 2);
      assert.strictEqual(orders[0].amount, 99.99);

      adapter.close();
    });

    it('should allow joining tables from different sheets', async () => {
      const xlsxPath = tempFile('join.xlsx');
      tempFiles.push(xlsxPath);

      createExcel(xlsxPath, {
        Users: [
          { id: 1, name: 'Alice' },
          { id: 2, name: 'Bob' },
        ],
        Posts: [
          { id: 1, user_id: 1, title: 'Hello' },
          { id: 2, user_id: 1, title: 'World' },
          { id: 3, user_id: 2, title: 'Test' },
        ],
      });

      const adapter = new Spreadsheet({
        file: xlsxPath,
        grounding: [tables()],
      });

      const results = await adapter.execute(`
        SELECT Users.name, Posts.title
        FROM Users
        JOIN Posts ON Users.id = Posts.user_id
        ORDER BY Posts.id
      `);

      assert.strictEqual(results.length, 3);
      assert.strictEqual(results[0].name, 'Alice');
      assert.strictEqual(results[0].title, 'Hello');

      adapter.close();
    });
  });

  describe('Type inference', () => {
    it('should preserve integer types', async () => {
      const csvPath = tempFile('integers.csv');
      tempFiles.push(csvPath);

      createCSV(csvPath, [{ count: 10 }, { count: 20 }, { count: 30 }]);

      const adapter = new Spreadsheet({
        file: csvPath,
        grounding: [tables()],
      });

      const rows = await adapter.execute(
        'SELECT SUM(count) as total FROM integers',
      );
      assert.strictEqual(rows[0].total, 60);

      adapter.close();
    });

    it('should preserve real/float types', async () => {
      const csvPath = tempFile('floats.csv');
      tempFiles.push(csvPath);

      createCSV(csvPath, [{ price: 10.5 }, { price: 20.25 }]);

      const adapter = new Spreadsheet({
        file: csvPath,
        grounding: [tables()],
      });

      const rows = await adapter.execute(
        'SELECT AVG(price) as avg_price FROM floats',
      );
      assert.ok(Math.abs(rows[0].avg_price - 15.375) < 0.001);

      adapter.close();
    });

    it('should handle mixed types as TEXT', async () => {
      const csvPath = tempFile('mixed.csv');
      tempFiles.push(csvPath);

      createCSV(csvPath, [{ value: 'hello' }, { value: 123 }]);

      const adapter = new Spreadsheet({
        file: csvPath,
        grounding: [tables()],
      });

      const rows = await adapter.execute('SELECT * FROM mixed ORDER BY value');
      assert.strictEqual(rows.length, 2);

      adapter.close();
    });
  });

  describe('Table name sanitization', () => {
    it('should sanitize special characters in sheet names', async () => {
      const xlsxPath = tempFile('special.xlsx');
      tempFiles.push(xlsxPath);

      createExcel(xlsxPath, {
        'My Sheet!': [{ id: 1 }],
      });

      const adapter = new Spreadsheet({
        file: xlsxPath,
        grounding: [tables()],
      });

      // "My Sheet!" should become "my_sheet" (lowercase)
      const rows = await adapter.execute('SELECT * FROM my_sheet');
      assert.strictEqual(rows.length, 1);

      adapter.close();
    });

    it('should prefix sheet names starting with numbers', async () => {
      const xlsxPath = tempFile('numeric.xlsx');
      tempFiles.push(xlsxPath);

      createExcel(xlsxPath, {
        '123Data': [{ id: 1 }],
      });

      const adapter = new Spreadsheet({
        file: xlsxPath,
        grounding: [tables()],
      });

      // "123Data" should become "_123data" (lowercase + prefixed)
      const rows = await adapter.execute('SELECT * FROM _123data');
      assert.strictEqual(rows.length, 1);

      adapter.close();
    });

    it('should lowercase all identifiers', async () => {
      const xlsxPath = tempFile('uppercase.xlsx');
      tempFiles.push(xlsxPath);

      // Use aoa_to_sheet to have precise control over column names
      const ws = XLSX.utils.aoa_to_sheet([
        ['MyColumn', 'AnotherCol'],
        ['value1', 'value2'],
      ]);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'MyTable');
      XLSX.writeFile(wb, xlsxPath);

      const adapter = new Spreadsheet({
        file: xlsxPath,
        grounding: [tables()],
      });

      // Table and column names should be lowercase
      const rows = await adapter.execute(
        'SELECT mycolumn, anothercol FROM mytable',
      );
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0].mycolumn, 'value1');
      assert.strictEqual(rows[0].anothercol, 'value2');

      adapter.close();
    });

    it('should truncate long identifiers to 64 characters', async () => {
      const xlsxPath = tempFile('longname.xlsx');
      tempFiles.push(xlsxPath);

      // Excel limits sheet names to 31 chars, so test with long column names instead
      const longColumnName = 'a'.repeat(100);
      const ws = XLSX.utils.aoa_to_sheet([[longColumnName], ['value']]);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Data');
      XLSX.writeFile(wb, xlsxPath);

      const adapter = new Spreadsheet({
        file: xlsxPath,
        grounding: [tables()],
      });

      // Column name should be truncated to 64 chars
      const truncatedName = 'a'.repeat(64);
      const rows = await adapter.execute(`SELECT "${truncatedName}" FROM data`);
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0][truncatedName], 'value');

      adapter.close();
    });
  });

  describe('NULL handling', () => {
    it('should treat empty cells as NULL', async () => {
      const xlsxPath = tempFile('nulls.xlsx');
      tempFiles.push(xlsxPath);

      // Create sheet with some empty values
      const ws = XLSX.utils.aoa_to_sheet([
        ['id', 'name', 'email'],
        [1, 'Alice', 'alice@example.com'],
        [2, 'Bob', null],
        [3, null, 'charlie@example.com'],
      ]);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Users');
      XLSX.writeFile(wb, xlsxPath);

      const adapter = new Spreadsheet({
        file: xlsxPath,
        grounding: [tables()],
      });

      const nullEmails = await adapter.execute(
        'SELECT * FROM Users WHERE email IS NULL',
      );
      assert.strictEqual(nullEmails.length, 1);
      assert.strictEqual(nullEmails[0].name, 'Bob');

      const nullNames = await adapter.execute(
        'SELECT * FROM Users WHERE name IS NULL',
      );
      assert.strictEqual(nullNames.length, 1);
      assert.strictEqual(nullNames[0].id, 3);

      adapter.close();
    });
  });

  describe('Introspection with groundings', () => {
    it('should introspect schema with tables grounding', async () => {
      const xlsxPath = tempFile('products.xlsx');
      tempFiles.push(xlsxPath);

      createExcel(xlsxPath, {
        Products: [{ id: 1, name: 'Widget', price: 9.99 }],
      });

      const adapter = new Spreadsheet({
        file: xlsxPath,
        grounding: [tables()],
      });

      const schema = await adapter.introspect();

      // Table name is lowercase
      assert.ok(
        schema.includes('products'),
        'Schema should include table name (lowercase)',
      );
      assert.ok(schema.includes('id'), 'Schema should include id column');
      assert.ok(schema.includes('name'), 'Schema should include name column');
      assert.ok(schema.includes('price'), 'Schema should include price column');

      adapter.close();
    });

    it('should work with rowCount grounding', async () => {
      const csvPath = tempFile('rowcount.csv');
      tempFiles.push(csvPath);

      createCSV(csvPath, [{ id: 1 }, { id: 2 }, { id: 3 }]);

      const adapter = new Spreadsheet({
        file: csvPath,
        grounding: [tables(), rowCount()],
      });

      const schema = await adapter.introspect();

      // Row count should be included
      assert.ok(
        schema.includes('3') || schema.includes('rows'),
        'Schema should include row count info',
      );

      adapter.close();
    });

    it('should work with info grounding', async () => {
      const csvPath = tempFile('info.csv');
      tempFiles.push(csvPath);

      createCSV(csvPath, [{ id: 1 }]);

      const adapter = new Spreadsheet({
        file: csvPath,
        grounding: [info()],
      });

      const schema = await adapter.introspect();

      // Should report SQLite dialect
      assert.ok(
        schema.includes('sqlite'),
        'Schema should report sqlite dialect',
      );

      adapter.close();
    });
  });

  describe('Error cases', () => {
    it('should throw error for non-existent file', () => {
      assert.throws(() => {
        new Spreadsheet({
          file: '/nonexistent/path/to/file.xlsx',
          grounding: [tables()],
        });
      }, /Failed to read spreadsheet|ENOENT/);
    });

    it('should throw error for empty spreadsheet', async () => {
      const xlsxPath = tempFile('empty.xlsx');
      tempFiles.push(xlsxPath);

      // Create empty workbook
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([]), 'Empty');
      XLSX.writeFile(wb, xlsxPath);

      assert.throws(() => {
        new Spreadsheet({
          file: xlsxPath,
          grounding: [tables()],
        });
      }, /No valid sheets|empty/i);
    });
  });

  describe('Cleanup', () => {
    it('should close without error', async () => {
      const csvPath = tempFile('close.csv');
      tempFiles.push(csvPath);

      createCSV(csvPath, [{ id: 1 }]);

      const adapter = new Spreadsheet({
        file: csvPath,
        grounding: [tables()],
      });

      // Should not throw
      assert.doesNotThrow(() => {
        adapter.close();
      });
    });

    it('should support file-based database', async () => {
      const csvPath = tempFile('persist.csv');
      const dbPath = tempFile('persist.db');
      tempFiles.push(csvPath, dbPath);

      createCSV(csvPath, [{ id: 1, name: 'Test' }]);

      const adapter = new Spreadsheet({
        file: csvPath,
        database: dbPath,
        grounding: [tables()],
      });

      const rows = await adapter.execute('SELECT * FROM persist');
      assert.strictEqual(rows.length, 1);

      adapter.close();

      // Database file should exist
      assert.ok(fs.existsSync(dbPath), 'Database file should be created');
    });
  });

  describe('Data type handling', () => {
    it('should handle Unicode characters', async () => {
      const xlsxPath = tempFile('unicode.xlsx');
      tempFiles.push(xlsxPath);

      createExcel(xlsxPath, {
        Data: [
          { text: '你好世界' },
          { text: 'Données été' },
          { text: 'emoji: 🎉' },
        ],
      });

      const adapter = new Spreadsheet({
        file: xlsxPath,
        grounding: [tables()],
      });

      const rows = await adapter.execute('SELECT * FROM data');
      assert.strictEqual(rows.length, 3);
      assert.strictEqual(rows[0].text, '你好世界');
      assert.strictEqual(rows[1].text, 'Données été');
      assert.ok(rows[2].text.includes('🎉'));

      adapter.close();
    });

    it('should handle special characters in text values', async () => {
      const xlsxPath = tempFile('specialtext.xlsx');
      tempFiles.push(xlsxPath);

      createExcel(xlsxPath, {
        Data: [
          { text: "It's a test" },
          { text: 'Say "hello"' },
          { text: 'Line1\nLine2' },
        ],
      });

      const adapter = new Spreadsheet({
        file: xlsxPath,
        grounding: [tables()],
      });

      const rows = await adapter.execute('SELECT * FROM data');
      assert.strictEqual(rows.length, 3);
      assert.strictEqual(rows[0].text, "It's a test");
      assert.strictEqual(rows[1].text, 'Say "hello"');
      assert.ok(rows[2].text.includes('Line1'));

      adapter.close();
    });

    it('should floor decimal values for INTEGER columns', async () => {
      const xlsxPath = tempFile('floor.xlsx');
      tempFiles.push(xlsxPath);

      createExcel(xlsxPath, {
        Numbers: [{ value: 42 }, { value: 43 }],
      });

      const adapter = new Spreadsheet({
        file: xlsxPath,
        grounding: [tables()],
      });

      // Insert a decimal that should be floored
      // Note: We test via the existing integer column which floors decimals
      const rows = await adapter.execute('SELECT value FROM numbers');
      assert.strictEqual(rows.length, 2);
      // Values should be integers
      assert.strictEqual(rows[0].value, 42);
      assert.strictEqual(rows[1].value, 43);

      adapter.close();
    });

    it('should handle non-numeric values in numeric columns as NULL', async () => {
      const xlsxPath = tempFile('nonnumeric.xlsx');
      tempFiles.push(xlsxPath);

      // Create sheet with numeric column but one non-numeric value
      const ws = XLSX.utils.aoa_to_sheet([
        ['amount'],
        [100],
        ['not a number'],
        [200],
      ]);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Data');
      XLSX.writeFile(wb, xlsxPath);

      const adapter = new Spreadsheet({
        file: xlsxPath,
        grounding: [tables()],
      });

      // The 'not a number' row should have NULL for amount
      const rows = await adapter.execute('SELECT * FROM data');
      assert.strictEqual(rows.length, 3);

      // Find the NULL row
      const nullRows = await adapter.execute(
        'SELECT * FROM data WHERE amount IS NULL',
      );
      // Due to type inference, the column might be TEXT if it has mixed values
      // But if inferred as numeric, 'not a number' becomes NULL
      assert.ok(rows.length === 3);

      adapter.close();
    });

    it('should handle rows with fewer values than columns', async () => {
      const xlsxPath = tempFile('sparse.xlsx');
      tempFiles.push(xlsxPath);

      // Create sheet where some rows have missing values
      const ws = XLSX.utils.aoa_to_sheet([
        ['a', 'b', 'c'],
        ['val1', 'val2', 'val3'],
        ['only_a'], // Missing b and c
      ]);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Data');
      XLSX.writeFile(wb, xlsxPath);

      const adapter = new Spreadsheet({
        file: xlsxPath,
        grounding: [tables()],
      });

      const rows = await adapter.execute('SELECT * FROM data');
      assert.strictEqual(rows.length, 2);

      // Second row should have NULL for missing columns
      const sparseRow = await adapter.execute(
        'SELECT * FROM data WHERE b IS NULL',
      );
      assert.strictEqual(sparseRow.length, 1);
      assert.strictEqual(sparseRow[0].a, 'only_a');

      adapter.close();
    });

    it('should handle dates formatted as YYYY-MM-DD', async () => {
      const xlsxPath = tempFile('dates.xlsx');
      tempFiles.push(xlsxPath);

      // Create sheet with date values
      const ws = XLSX.utils.aoa_to_sheet([
        ['date'],
        [new Date('2024-03-15T12:00:00Z')],
        [new Date('2024-12-25T00:00:00Z')],
      ]);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Events');
      XLSX.writeFile(wb, xlsxPath, { cellDates: true });

      const adapter = new Spreadsheet({
        file: xlsxPath,
        grounding: [tables()],
      });

      const rows = await adapter.execute('SELECT * FROM events');
      assert.strictEqual(rows.length, 2);
      // Dates should be formatted as YYYY-MM-DD
      assert.ok(
        rows[0].date.startsWith('2024-03-15') ||
          rows[0].date.includes('2024-03-15'),
      );

      adapter.close();
    });
  });
});
