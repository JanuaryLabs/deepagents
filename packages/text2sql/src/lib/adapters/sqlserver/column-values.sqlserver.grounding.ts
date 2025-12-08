import type { Adapter } from '../adapter.ts';
import {
  type Column,
  ColumnValuesGrounding,
  type ColumnValuesGroundingConfig,
} from '../groundings/column-values.grounding.ts';

/**
 * SQL Server implementation of ColumnValuesGrounding.
 *
 * Supports:
 * - CHECK constraints with IN clauses (inherited from base)
 * - Low cardinality data scan
 *
 * Note: SQL Server does not have native ENUM types.
 */
export class SqlServerColumnValuesGrounding extends ColumnValuesGrounding {
  #adapter: Adapter;

  constructor(adapter: Adapter, config: ColumnValuesGroundingConfig = {}) {
    super(config);
    this.#adapter = adapter;
  }

  protected override async collectLowCardinality(
    tableName: string,
    column: Column,
  ): Promise<string[] | undefined> {
    const { schema, table } = this.#adapter.parseTableName(tableName);
    const tableIdentifier = `[${this.#adapter.escape(schema)}].[${this.#adapter.escape(table)}]`;
    const columnIdentifier = `[${this.#adapter.escape(column.name)}]`;
    const limit = this.lowCardinalityLimit + 1;

    const sql = `
      SELECT DISTINCT TOP ${limit} CAST(${columnIdentifier} AS NVARCHAR(MAX)) AS value
      FROM ${tableIdentifier}
      WHERE ${columnIdentifier} IS NOT NULL
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
}
