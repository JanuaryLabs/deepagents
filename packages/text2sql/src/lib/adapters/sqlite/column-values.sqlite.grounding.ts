import type { Adapter } from '../adapter.ts';
import {
  type Column,
  ColumnValuesGrounding,
  type ColumnValuesGroundingConfig,
} from '../groundings/column-values.grounding.ts';

/**
 * SQLite implementation of ColumnValuesGrounding.
 *
 * Supports:
 * - CHECK constraints with IN clauses (inherited from base)
 * - Low cardinality data scan
 *
 * Note: SQLite does not have native ENUM types.
 */
export class SqliteColumnValuesGrounding extends ColumnValuesGrounding {
  #adapter: Adapter;

  constructor(adapter: Adapter, config: ColumnValuesGroundingConfig = {}) {
    super(config);
    this.#adapter = adapter;
  }

  protected override async collectLowCardinality(
    tableName: string,
    column: Column,
  ): Promise<string[] | undefined> {
    const tableIdentifier = this.#adapter.quoteIdentifier(tableName);
    const columnIdentifier = this.#adapter.quoteIdentifier(column.name);
    const limit = this.lowCardinalityLimit + 1;

    const sql = `
      SELECT DISTINCT ${columnIdentifier} AS value
      FROM ${tableIdentifier}
      WHERE ${columnIdentifier} IS NOT NULL
      LIMIT ${limit}
    `;

    const rows = await this.#adapter.runQuery<{ value: unknown }>(sql);

    if (!rows.length || rows.length > this.lowCardinalityLimit) {
      return undefined;
    }

    const values: string[] = [];
    for (const row of rows) {
      const formatted = this.#normalizeValue(row.value);
      if (formatted == null) {
        return undefined;
      }
      values.push(formatted);
    }

    return values.length ? values : undefined;
  }

  #normalizeValue(value: unknown): string | null {
    if (value === null || value === undefined) {
      return null;
    }
    if (typeof value === 'string') {
      return value;
    }
    if (typeof value === 'number' || typeof value === 'bigint') {
      return String(value);
    }
    if (typeof value === 'boolean') {
      return value ? 'true' : 'false';
    }
    if (value instanceof Date) {
      return value.toISOString();
    }
    if (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) {
      return value.toString('utf-8');
    }
    return null;
  }
}
