import fs from 'node:fs';
import * as path from 'node:path';
import XLSX from 'xlsx';

// The `xlsx` package resolves to its pure-ESM `xlsx.mjs` build under Node, which
// ships without a bound `fs`, so readFile/writeFile throw until one is wired in.
XLSX.set_fs(fs);

/**
 * Column type for SQLite.
 */
export type ColumnType = 'TEXT' | 'INTEGER' | 'REAL';

/**
 * Column definition with name and inferred type.
 */
export interface Column {
  /** Sanitized column name for SQL */
  name: string;
  /** Original column name from spreadsheet (for data access) */
  originalKey: string;
  /** Inferred SQLite type */
  type: ColumnType;
}

/**
 * Parsed sheet with table name, columns, and row data.
 */
export interface ParsedSheet {
  name: string;
  columns: Column[];
  rows: Record<string, unknown>[];
}

/**
 * Parse an Excel or CSV/TSV file into sheets.
 *
 * - Excel files: each sheet becomes a ParsedSheet
 * - CSV/TSV files: single ParsedSheet with filename as table name
 */
export function parseFile(filePath: string): ParsedSheet[] {
  const ext = path.extname(filePath).toLowerCase();

  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.readFile(filePath, {
      cellDates: true, // Parse dates as Date objects
    });
  } catch (error) {
    const message = Error.isError(error) ? error.message : String(error);
    throw new Error(`Failed to read spreadsheet "${filePath}": ${message}`, {
      cause: error,
    });
  }

  const sheets: ParsedSheet[] = [];
  const tableIdentifier = uniqueIdentifiers();

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet);

    // Skip empty sheets
    if (rows.length === 0) {
      continue;
    }

    const columns = inferColumns(rows);

    // Skip sheets with no columns (shouldn't happen if rows exist, but be safe)
    if (columns.length === 0) {
      continue;
    }

    // For CSV files, use filename as table name; for Excel, use sheet name.
    // Distinct sheet names can sanitize to one identifier ("Sales Data",
    // "sales-data"), so each sheet's table name is made unique.
    sheets.push({
      name:
        ext === '.csv' || ext === '.tsv'
          ? getTableNameFromFile(filePath)
          : tableIdentifier(sheetName),
      columns,
      rows,
    });
  }

  if (sheets.length === 0) {
    throw new Error(
      `No valid sheets found in "${filePath}". All sheets are empty or have no columns.`,
    );
  }

  return sheets;
}

/**
 * Extract table name from filename.
 * './data/customers.csv' → 'customers'
 */
function getTableNameFromFile(filePath: string): string {
  const basename = path.basename(filePath, path.extname(filePath));
  return sanitizeTableName(basename);
}

/**
 * Sanitize a name to be a valid SQL table/column identifier.
 * - Lowercase for consistency
 * - Replace invalid chars with underscores
 * - Ensure it doesn't start with a number
 * - Trim and collapse multiple underscores
 * - Truncate to 64 characters
 */
export function sanitizeIdentifier(name: string): string {
  // Lowercase for consistent SQL identifiers
  let sanitized = name.toLowerCase();

  // Replace any non-alphanumeric (except underscore) with underscore
  sanitized = sanitized.replace(/[^a-z0-9_]/g, '_');

  // Collapse multiple underscores
  sanitized = sanitized.replace(/_+/g, '_');

  // Trim leading/trailing underscores
  sanitized = sanitized.replace(/^_+|_+$/g, '');

  // If starts with number, prefix with underscore
  if (/^[0-9]/.test(sanitized)) {
    sanitized = '_' + sanitized;
  }

  // If empty after sanitization, use a default
  if (!sanitized) {
    return 'column';
  }

  // Truncate to 64 characters (common SQL identifier limit)
  return sanitized.slice(0, 64);
}

// Alias for backwards compatibility
export const sanitizeTableName = sanitizeIdentifier;

/**
 * Infer column definitions from row data.
 * Uses the first row's keys as column names and samples values for type inference.
 */
function inferColumns(rows: Record<string, unknown>[]): Column[] {
  if (rows.length === 0) {
    return [];
  }

  // Get all unique keys from all rows (in case some rows have different keys)
  const keySet = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      keySet.add(key);
    }
  }

  // Handle empty keys (sheets with no headers)
  if (keySet.size === 0) {
    return [];
  }

  const columnIdentifier = uniqueIdentifiers();
  return Array.from(keySet, (originalKey) => {
    const values = rows.map((row) => row[originalKey]);
    const type = inferColumnType(values);
    return { name: columnIdentifier(originalKey), originalKey, type };
  });
}

/**
 * Hands out sanitized identifiers, each unique among the ones it handed out
 * before: a clash gets the first free `_2`, `_3`, … suffix, so a name that
 * already ends in `_2` cannot collide with a suffixed duplicate.
 */
function uniqueIdentifiers(): (rawName: string) => string {
  const used = new Set<string>();
  return (rawName) => {
    const base = sanitizeIdentifier(rawName);
    let name = base;
    for (let suffix = 2; used.has(name); suffix++) {
      name = `${base}_${suffix}`;
    }
    used.add(name);
    return name;
  };
}

/**
 * Infer SQLite column type from sample values.
 * Conservative approach: when in doubt, use TEXT.
 */
function inferColumnType(values: unknown[]): ColumnType {
  let hasInteger = false;
  let hasReal = false;

  for (const value of values) {
    // Skip nullish or empty values
    if (value == null || value === '') {
      continue;
    }

    // Dates are stored as TEXT (ISO format)
    if (value instanceof Date) {
      return 'TEXT';
    }

    if (typeof value === 'number') {
      if (Number.isInteger(value)) {
        hasInteger = true;
      } else {
        hasReal = true;
      }
    } else if (typeof value === 'boolean') {
      // Booleans can be stored as INTEGER (0/1)
      hasInteger = true;
    } else {
      // Any non-number type means TEXT
      return 'TEXT';
    }
  }

  // If we have any REAL values, use REAL (even if some are integers)
  if (hasReal) {
    return 'REAL';
  }

  // If we only have integers, use INTEGER
  if (hasInteger) {
    return 'INTEGER';
  }

  // Default to TEXT (all values were null/empty)
  return 'TEXT';
}
