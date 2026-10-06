import { z } from 'zod';

// Row shapes shared by every adapter because no driver changes them.

/** A text column aliased `name`, such as a table or view name. */
export const nameRow = z.object({ name: z.string() });

/** `SELECT <engine version function> AS version`. */
export const versionRow = z.object({ version: z.string() });

/** The current database's name, aliased `db`. */
export const databaseRow = z.object({ db: z.string() });

/** A view's stored definition, aliased `definition`; NULL where the engine hides it. */
export const viewDefinitionRow = z.object({
  definition: z.string().nullable(),
});

/** `SELECT DISTINCT <column> AS value`: whatever the column stores. */
export const distinctValueRow = z.object({ value: z.unknown() });

/** A distinct value the query casts to text after filtering out NULLs. */
export const textValueRow = z.object({ value: z.string() });

/**
 * A number as drivers return it: a JS number, a bigint (DuckDB BIGINT, the
 * mariadb connector, node:sqlite readBigInts) or a decimal string (pg and
 * tedious BIGINT, NUMERIC and DECIMAL). Read it with Adapter.toNumber().
 */
export const numericValue = z.union([z.number(), z.bigint(), z.string()]);
