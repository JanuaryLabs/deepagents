import type { Adapter } from '../adapter.ts';
import {
  RowCountGrounding,
  type RowCountGroundingConfig,
} from '../groundings/row-count.grounding.ts';

/**
 * SQLite implementation of RowCountGrounding.
 */
export class SqliteRowCountGrounding extends RowCountGrounding {
  #adapter: Adapter;

  constructor(adapter: Adapter, config: RowCountGroundingConfig = {}) {
    super(config);
    this.#adapter = adapter;
  }

  protected override async getRowCount(tableName: string): Promise<number | undefined> {
    const rows = await this.#adapter.runQuery<{ count: number | string | bigint | null }>(
      `SELECT COUNT(*) as count FROM ${this.#adapter.quoteIdentifier(tableName)}`,
    );

    return this.#adapter.toNumber(rows[0]?.count);
  }
}
