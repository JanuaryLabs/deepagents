import * as path from 'node:path';
import XLSX from 'xlsx';

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
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read spreadsheet "${filePath}": ${message}`);
  }

  const sheets: ParsedSheet[] = [];

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet);

    // Skip empty sheets
    if (rows.length === 0) {
      continue;
    }

    // For CSV files, use filename as table name; for Excel, use sheet name
    const tableName =
      ext === '.csv' || ext === '.tsv'
        ? getTableNameFromFile(filePath)
        : sanitizeTableName(sheetName);

    const columns = inferColumns(rows);

    // Skip sheets with no columns (shouldn't happen if rows exist, but be safe)
    if (columns.length === 0) {
      continue;
    }

    sheets.push({
      name: tableName,
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

  const rawNames = Array.from(keySet);
  const dedupedNames = deduplicateColumnNames(rawNames);

  return dedupedNames.map((name, idx) => {
    const originalKey = rawNames[idx];
    const values = rows.map((row) => row[originalKey]);
    const type = inferColumnType(values);
    return { name, originalKey, type };
  });
}

/**
 * Deduplicate column names by appending _2, _3, etc. to duplicates.
 */
function deduplicateColumnNames(names: string[]): string[] {
  const seen = new Map<string, number>();
  const result: string[] = [];

  for (const rawName of names) {
    // Sanitize the column name
    let name = sanitizeTableName(rawName);

    // Handle empty names (generate column_1, column_2, etc.)
    if (!name) {
      name = 'column';
    }

    const count = seen.get(name) ?? 0;
    if (count > 0) {
      result.push(`${name}_${count + 1}`);
    } else {
      result.push(name);
    }
    seen.set(name, count + 1);
  }

  return result;
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
