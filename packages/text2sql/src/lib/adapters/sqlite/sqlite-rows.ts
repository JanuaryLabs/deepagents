import { z } from 'zod';

// Rows of SQLite's catalog queries, as node:sqlite returns them. TEXT columns
// are strings and INTEGER columns numbers, or bigints when the database is
// opened with readBigInts; every integer here is small, so it is read as a
// number either way.

export const sqliteInteger = z
  .union([z.number(), z.bigint()])
  .transform(Number);

/** `SELECT sql FROM sqlite_master`: the CREATE statement, when one exists. */
export const sqliteMasterSqlRow = z.object({ sql: z.string().nullable() });

/** `PRAGMA table_info`. `type` is '' for a column declared without one. */
export const tableInfoRow = z.object({
  cid: sqliteInteger,
  name: z.string(),
  type: z.string(),
  notnull: sqliteInteger,
  dflt_value: z.string().nullable(),
  pk: sqliteInteger,
});

/**
 * `PRAGMA foreign_key_list`. `to` is null when the key references the parent
 * table's primary key without naming its columns.
 */
export const foreignKeyListRow = z.object({
  id: sqliteInteger,
  seq: sqliteInteger,
  table: z.string(),
  from: z.string(),
  to: z.string().nullable(),
});

/** `PRAGMA index_list`. `origin` is 'c' (CREATE INDEX), 'u' (UNIQUE) or 'pk'. */
export const indexListRow = z.object({
  seq: sqliteInteger,
  name: z.string(),
  unique: sqliteInteger,
  origin: z.string(),
  partial: sqliteInteger,
});

/** `PRAGMA index_info`. `name` is null for an expression column. */
export const indexInfoRow = z.object({
  seqno: sqliteInteger,
  cid: sqliteInteger,
  name: z.string().nullable(),
});
