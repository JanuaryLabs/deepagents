import type { Adapter } from '../adapter.ts';
import {
  RowCountGrounding,
  type RowCountGroundingConfig,
} from '../groundings/row-count.grounding.ts';

/**
 * SQL Server implementation of RowCountGrounding.
 */
export class SqlServerRowCountGrounding extends RowCountGrounding {
  #adapter: Adapter;

  constructor(adapter: Adapter, config: RowCountGroundingConfig = {}) {
    super(config);
    this.#adapter = adapter;
  }

  protected override async getRowCount(tableName: string): Promise<number | undefined> {
    const { schema, table } = this.#adapter.parseTableName(tableName);
    const tableIdentifier = `[${this.#adapter.escape(schema)}].[${this.#adapter.escape(table)}]`;

    const rows = await this.#adapter.runQuery<{ count: number | string | bigint | null }>(
      `SELECT COUNT(*) as count FROM ${tableIdentifier}`,
    );

    return this.#adapter.toNumber(rows[0]?.count);
  }
}
