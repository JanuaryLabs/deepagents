// Re-export relevant SQLite groundings
export {
  columnStats,
  columnValues,
  info,
  rowCount,
  tables,
} from '../sqlite/index.ts';

// Export the Spreadsheet adapter
export { Spreadsheet, type SpreadsheetOptions } from './spreadsheet.ts';

// Export parser utilities (for advanced use cases)
export {
  parseFile,
  sanitizeIdentifier,
  sanitizeTableName,
  type Column,
  type ColumnType,
  type ParsedSheet,
} from './parser.ts';
