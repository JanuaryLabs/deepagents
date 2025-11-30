import type { Adapter } from '../adapter.ts';
import {
  type Column,
  LowCardinalityGrounding,
  type LowCardinalityGroundingConfig,
} from '../groundings/low-cardinality.grounding.ts';

const LOW_CARDINALITY_LIMIT = 20;

/**
 * PostgreSQL implementation of LowCardinalityGrounding.
 */
export class PostgresLowCardinalityGrounding extends LowCardinalityGrounding {
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
    const tableIdentifier = `${this.#adapter.quoteIdentifier(schema)}.${this.#adapter.quoteIdentifier(table)}`;
    const columnIdentifier = this.#adapter.quoteIdentifier(column.name);
    const limit = LOW_CARDINALITY_LIMIT + 1;

    const sql = `
      SELECT DISTINCT ${columnIdentifier}::text AS value
      FROM ${tableIdentifier}
      WHERE ${columnIdentifier} IS NOT NULL
      LIMIT ${limit}
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
