import type { Adapter } from '../adapter.ts';
import {
  type Column,
  LowCardinalityGrounding,
  type LowCardinalityGroundingConfig,
} from '../groundings/low-cardinality.grounding.ts';

const LOW_CARDINALITY_LIMIT = 20;

/**
 * SQL Server implementation of LowCardinalityGrounding.
 */
export class SqlServerLowCardinalityGrounding extends LowCardinalityGrounding {
  #adapter: Adapter;

  constructor(adapter: Adapter, config: LowCardinalityGroundingConfig = {}) {
    super(config);
    this.#adapter = adapter;
  }

  protected override async collectLowCardinality(
    tableName: string,
    column: Column,
  ): Promise<{ kind: 'LowCardinality'; values: string[] } | undefined> {
    const { schema, table } = this.#adapter.parseTableName(tableName);
    const tableIdentifier = `[${this.#adapter.escape(schema)}].[${this.#adapter.escape(table)}]`;
    const columnIdentifier = `[${this.#adapter.escape(column.name)}]`;
    const limit = LOW_CARDINALITY_LIMIT + 1;

    const sql = `
      SELECT DISTINCT TOP ${limit} CAST(${columnIdentifier} AS NVARCHAR(MAX)) AS value
      FROM ${tableIdentifier}
      WHERE ${columnIdentifier} IS NOT NULL
    `;

    const rows = await this.#adapter.runQuery<{ value: string | null }>(sql);

    if (!rows.length || rows.length > LOW_CARDINALITY_LIMIT) {
      return undefined;
    }

    const values: string[] = [];
    for (const row of rows) {
      if (row.value == null) {
        return undefined;
      }
      values.push(row.value);
    }

    if (!values.length) {
      return undefined;
    }

    return { kind: 'LowCardinality', values };
  }
}
