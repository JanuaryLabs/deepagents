import type { Adapter } from '../adapter.ts';
import {
  RowCountGrounding,
  type RowCountGroundingConfig,
} from '../groundings/row-count.grounding.ts';

export class PostgresRowCountGrounding extends RowCountGrounding {
  #adapter: Adapter;

  constructor(adapter: Adapter, config: RowCountGroundingConfig = {}) {
    super(config);
    this.#adapter = adapter;
  }

  protected override async getRowCount(
    tableName: string,
  ): Promise<number | undefined> {
    const estimate = await this.#getEstimatedRowCount(tableName);
    if (estimate != null && estimate > 0) {
      return Math.round(estimate);
    }

    return this.#getLiveRowCount(tableName);
  }

  async #getEstimatedRowCount(tableName: string): Promise<number | undefined> {
    const { schema, table } = this.#adapter.parseTableName(tableName);
    const rows = await this.#adapter.runQuery<{
      estimate: number | string | bigint | null;
    }>(`
      SELECT c.reltuples::bigint AS estimate
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = '${this.#adapter.escapeString(schema)}'
        AND c.relname = '${this.#adapter.escapeString(table)}'
    `);

    return this.#adapter.toNumber(rows[0]?.estimate);
  }

  async #getLiveRowCount(tableName: string): Promise<number | undefined> {
    const { schema, table } = this.#adapter.parseTableName(tableName);
    const tableIdentifier = `${this.#adapter.quoteIdentifier(schema)}.${this.#adapter.quoteIdentifier(table)}`;

    const rows = await this.#adapter.runQuery<{
      count: number | string | bigint | null;
    }>(`SELECT COUNT(*) as count FROM ${tableIdentifier}`);

    return this.#adapter.toNumber(rows[0]?.count);
  }
}
