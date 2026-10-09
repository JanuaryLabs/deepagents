import pMemoize from 'p-memoize';
import { z } from 'zod';

import type { Adapter } from '../adapter.ts';
import {
  type Column,
  ColumnValuesGrounding,
  type ColumnValuesGroundingConfig,
} from '../groundings/column-values.grounding.ts';

/** An ENUM label with its type; typname, nspname and enumlabel are names. */
const enumValueRow = z.object({
  type_name: z.string(),
  type_schema: z.string(),
  enum_value: z.string(),
});

/** The type a column was declared with, from information_schema.columns. */
const columnTypeRow = z.object({
  udt_name: z.string(),
  udt_schema: z.string(),
});

/** `SELECT DISTINCT <column>::text AS value`. */
const textValueRow = z.object({ value: z.string().nullable() });

export class PostgresColumnValuesGrounding extends ColumnValuesGrounding {
  #adapter: Adapter;
  /** Every ENUM type's values, loaded once on first use; a failed load runs again. */
  readonly #enumValues: () => Promise<Map<string, string[]>>;

  constructor(adapter: Adapter, config: ColumnValuesGroundingConfig = {}) {
    super(config);
    this.#adapter = adapter;
    this.#enumValues = pMemoize(() => this.#loadEnumValues());
  }

  /**
   * Load all ENUM types and their values, keyed by schema-qualified and by
   * bare type name. One query is more efficient than one per column.
   */
  async #loadEnumValues(): Promise<Map<string, string[]>> {
    const enumValues = new Map<string, string[]>();
    const rows = await this.#adapter.runQuery(
      `
      SELECT
        t.typname AS type_name,
        n.nspname AS type_schema,
        e.enumlabel AS enum_value
      FROM pg_type t
      JOIN pg_enum e ON t.oid = e.enumtypid
      JOIN pg_namespace n ON n.oid = t.typnamespace
      ORDER BY t.typname, e.enumsortorder
    `,
      enumValueRow,
    );

    for (const row of rows) {
      const key = `${row.type_schema}.${row.type_name}`;
      const existing = enumValues.get(key) ?? [];
      existing.push(row.enum_value);
      enumValues.set(key, existing);

      // Also key it without schema for convenience
      const simpleKey = row.type_name;
      const simpleExisting = enumValues.get(simpleKey) ?? [];
      simpleExisting.push(row.enum_value);
      enumValues.set(simpleKey, simpleExisting);
    }

    return enumValues;
  }

  protected override async collectEnumValues(
    tableName: string,
    column: Column,
  ): Promise<string[] | undefined> {
    // USER-DEFINED type in PostgreSQL could be ENUM
    if (column.type.toLowerCase() !== 'user-defined') {
      return undefined;
    }

    const enumValues = await this.#enumValues();

    // Get the actual type name for this column
    const { schema, table } = this.#adapter.parseTableName(tableName);
    const rows = await this.#adapter.runQuery(
      `
      SELECT udt_name, udt_schema
      FROM information_schema.columns
      WHERE table_schema = '${this.#adapter.escapeString(schema)}'
        AND table_name = '${this.#adapter.escapeString(table)}'
        AND column_name = '${this.#adapter.escapeString(column.name)}'
    `,
      columnTypeRow,
    );

    if (!rows.length) {
      return undefined;
    }

    const { udt_name, udt_schema } = rows[0];

    // Look up in cache
    const fullKey = `${udt_schema}.${udt_name}`;
    const values = enumValues.get(fullKey) ?? enumValues.get(udt_name);

    return values?.length ? values : undefined;
  }

  protected override async collectLowCardinality(
    tableName: string,
    column: Column,
  ): Promise<string[] | undefined> {
    if (this.#isHighCardinality(column)) {
      return undefined;
    }

    const { schema, table } = this.#adapter.parseTableName(tableName);
    const tableIdentifier = `${this.#adapter.quoteIdentifier(schema)}.${this.#adapter.quoteIdentifier(table)}`;
    const columnIdentifier = this.#adapter.quoteIdentifier(column.name);
    const limit = this.lowCardinalityLimit + 1;

    const sql = `
      SELECT DISTINCT ${columnIdentifier}::text AS value
      FROM ${tableIdentifier}
      WHERE ${columnIdentifier} IS NOT NULL
      LIMIT ${limit}
    `;

    const rows = await this.#adapter.runQuery(sql, textValueRow);

    if (!rows.length || rows.length > this.lowCardinalityLimit) {
      return undefined;
    }

    const values: string[] = [];
    for (const row of rows) {
      if (row.value == null) {
        return undefined;
      }
      values.push(row.value);
    }

    return values.length ? values : undefined;
  }

  #isHighCardinality(column: Column): boolean {
    const nDistinct = column.stats?.nDistinct;
    if (nDistinct == null) return false;
    if (nDistinct > 0) return nDistinct > this.lowCardinalityLimit;
    return true;
  }
}
