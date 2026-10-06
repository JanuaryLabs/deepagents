import { z } from 'zod';

// Rows of BigQuery INFORMATION_SCHEMA queries, as @google-cloud/bigquery's
// query() returns them: STRING columns are strings, NULL is null, and INT64
// columns are numbers. That is the client's default; with wrapIntegers it
// returns BigQueryInt objects instead, which these groundings cannot read.

/** An INT64 column. */
export const int64 = z.number();

/** `SELECT table_name FROM INFORMATION_SCHEMA.TABLES`. */
export const tableNameRow = z.object({ table_name: z.string().nullable() });

/** A `constraint_name` from TABLE_CONSTRAINTS or CONSTRAINT_COLUMN_USAGE. */
export const constraintNameRow = z.object({
  constraint_name: z.string().nullable(),
});

/**
 * KEY_COLUMN_USAGE columns of a key constraint.
 * `position_in_unique_constraint` is NULL for a primary key column.
 */
export const keyColumnUsageRow = z.object({
  constraint_name: z.string().nullable(),
  column_name: z.string().nullable(),
  ordinal_position: int64.nullable(),
  position_in_unique_constraint: int64.nullable(),
});
