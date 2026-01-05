import { DatabaseSync } from 'node:sqlite';

import type { GroundingFn } from '../adapter.ts';
import { Sqlite } from '../sqlite/sqlite.ts';
import { type ColumnType, type ParsedSheet, parseFile } from './parser.ts';

/**
 * Options for creating a Spreadsheet adapter.
 */
export interface SpreadsheetOptions {
  /**
   * Path to the spreadsheet file (Excel .xlsx/.xls or CSV/TSV).
   */
  file: string;

  /**
   * Optional path to persist the SQLite database.
   * If not provided, uses in-memory database (':memory:').
   */
  database?: string;

  /**
   * Grounding functions to use for schema introspection.
   */
  grounding: GroundingFn[];
}

/**
 * Spreadsheet adapter that loads Excel/CSV files into SQLite.
 *
 * This adapter:
 * 1. Parses the spreadsheet file (Excel or CSV/TSV)
 * 2. Creates a SQLite database (in-memory or file-based)
 * 3. Creates tables from sheets and loads data
 * 4. Delegates all SQL operations to the SQLite adapter
 *
 * @example
 * ```typescript
 * import { Spreadsheet, tables, info } from '@deepagents/text2sql/spreadsheet';
 *
 * const adapter = new Spreadsheet({
 *   file: './sales.xlsx',
 *   grounding: [tables(), info()]
 * });
 *
 * const schema = await adapter.introspect();
 * const results = await adapter.execute('SELECT * FROM Customers');
 * ```
 */
export class Spreadsheet extends Sqlite {
  #db: DatabaseSync;

  constructor(options: SpreadsheetOptions) {
    // Parse the spreadsheet file
    const sheets = parseFile(options.file);

    // Create SQLite database
    const dbPath = options.database ?? ':memory:';
    const db = new DatabaseSync(dbPath);

    // Create tables and load data
    for (const sheet of sheets) {
      const createSQL = createTableSQL(sheet);
      db.exec(createSQL);
      loadData(db, sheet);
    }

    // Initialize the SQLite adapter with execute function
    super({
      execute: (sql: string) => db.prepare(sql).all(),
      grounding: options.grounding,
    });

    this.#db = db;
  }

  /**
   * Close the underlying SQLite database.
   * Call this when done to release resources.
   */
  close(): void {
    this.#db.close();
  }
}

/**
 * Generate CREATE TABLE SQL for a parsed sheet.
 */
function createTableSQL(sheet: ParsedSheet): string {
  if (sheet.columns.length === 0) {
    throw new Error(`Cannot create table "${sheet.name}" with no columns.`);
  }

  const columns = sheet.columns
    .map((col) => `"${escapeIdentifier(col.name)}" ${col.type}`)
    .join(', ');

  return `CREATE TABLE "${escapeIdentifier(sheet.name)}" (${columns})`;
}

/**
 * SQLite input value type.
 */
type SQLiteValue = string | number | bigint | null | Uint8Array;

/**
 * Load data from a parsed sheet into the SQLite database.
 * Uses transactions for performance.
 */
function loadData(db: DatabaseSync, sheet: ParsedSheet): void {
  if (sheet.rows.length === 0) {
    return;
  }

  const columns = sheet.columns
    .map((c) => `"${escapeIdentifier(c.name)}"`)
    .join(', ');
  const placeholders = sheet.columns.map(() => '?').join(', ');

  const insertSQL = `INSERT INTO "${escapeIdentifier(sheet.name)}" (${columns}) VALUES (${placeholders})`;
  const stmt = db.prepare(insertSQL);

  db.exec('BEGIN TRANSACTION');

  try {
    for (const row of sheet.rows) {
      const values: SQLiteValue[] = sheet.columns.map((col) => {
        // Use originalKey to access row data (preserves original case)
        const rawValue = row[col.originalKey];
        return convertValue(rawValue, col.type);
      });
      stmt.run(...values);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/**
 * Convert a JavaScript value to the appropriate SQLite type.
 * Type-aware conversion based on the inferred column type.
 */
function convertValue(value: unknown, type: ColumnType): SQLiteValue {
  // Null/undefined/empty → NULL
  if (value == null || value === '') {
    return null;
  }

  // Handle Date objects - format as YYYY-MM-DD
  if (value instanceof Date) {
    return value.toISOString().split('T')[0];
  }

  switch (type) {
    case 'INTEGER': {
      // Convert to integer, floor decimals
      const num = Number(value);
      if (isNaN(num)) {
        return null; // Non-numeric values become NULL
      }
      return Math.floor(num);
    }

    case 'REAL': {
      // Convert to float
      const num = Number(value);
      if (isNaN(num)) {
        return null; // Non-numeric values become NULL
      }
      return num;
    }

    case 'TEXT':
    default: {
      // Convert to string
      if (typeof value === 'boolean') {
        return value ? 'true' : 'false';
      }
      if (typeof value === 'object') {
        return JSON.stringify(value);
      }
      return String(value);
    }
  }
}

/**
 * Escape double quotes in identifiers for SQLite.
 */
function escapeIdentifier(name: string): string {
  return name.replace(/"/g, '""');
}
