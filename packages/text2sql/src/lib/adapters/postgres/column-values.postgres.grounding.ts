import type { Adapter } from '../adapter.ts';
import {
  type Column,
  ColumnValuesGrounding,
  type ColumnValuesGroundingConfig,
} from '../groundings/column-values.grounding.ts';

export class PostgresColumnValuesGrounding extends ColumnValuesGrounding {
  #adapter: Adapter;
  #enumCache: Map<string, string[]> = new Map();
  #enumCacheLoaded = false;

  constructor(adapter: Adapter, config: ColumnValuesGroundingConfig = {}) {
    super(config);
    this.#adapter = adapter;
  }

  /**
   * Load all ENUM types and their values into cache.
   * This is more efficient than querying per-column.
   */
  async #loadEnumCache(): Promise<void> {
    if (this.#enumCacheLoaded) {
      return;
    }

    const rows = await this.#adapter.runQuery<{
      type_name: string;
      type_schema: string;
      enum_value: string;
    }>(`
      SELECT
        t.typname AS type_name,
        n.nspname AS type_schema,
        e.enumlabel AS enum_value
      FROM pg_type t
      JOIN pg_enum e ON t.oid = e.enumtypid
      JOIN pg_namespace n ON n.oid = t.typnamespace
      ORDER BY t.typname, e.enumsortorder
    `);

    for (const row of rows) {
      const key = `${row.type_schema}.${row.type_name}`;
      const existing = this.#enumCache.get(key) ?? [];
      existing.push(row.enum_value);
      this.#enumCache.set(key, existing);

      // Also cache without schema for convenience
      const simpleKey = row.type_name;
      const simpleExisting = this.#enumCache.get(simpleKey) ?? [];
      simpleExisting.push(row.enum_value);
      this.#enumCache.set(simpleKey, simpleExisting);
    }

    this.#enumCacheLoaded = true;
  }

  protected override async collectEnumValues(
    tableName: string,
    column: Column,
  ): Promise<string[] | undefined> {
    // USER-DEFINED type in PostgreSQL could be ENUM
    if (column.type.toLowerCase() !== 'user-defined') {
      return undefined;
    }

    await this.#loadEnumCache();

    // Get the actual type name for this column
    const { schema, table } = this.#adapter.parseTableName(tableName);
    const rows = await this.#adapter.runQuery<{
      udt_name: string;
      udt_schema: string;
    }>(`
      SELECT udt_name, udt_schema
      FROM information_schema.columns
      WHERE table_schema = '${this.#adapter.escapeString(schema)}'
        AND table_name = '${this.#adapter.escapeString(table)}'
        AND column_name = '${this.#adapter.escapeString(column.name)}'
    `);

    if (!rows.length) {
      return undefined;
    }

    const { udt_name, udt_schema } = rows[0];

    // Look up in cache
    const fullKey = `${udt_schema}.${udt_name}`;
    const values =
      this.#enumCache.get(fullKey) ?? this.#enumCache.get(udt_name);

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

    const rows = await this.#adapter.runQuery<{ value: string | null }>(sql);

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
