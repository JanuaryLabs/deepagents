import type { Adapter } from '../adapter.ts';
import {
  RowCountGrounding,
  type RowCountGroundingConfig,
} from '../groundings/row-count.grounding.ts';

/**
 * MySQL/MariaDB implementation of RowCountGrounding.
 *
 * Uses COUNT(*) for accurate row counts.
 */
export class MysqlRowCountGrounding extends RowCountGrounding {
  #adapter: Adapter;

  constructor(adapter: Adapter, config: RowCountGroundingConfig = {}) {
    super(config);
    this.#adapter = adapter;
  }

  protected override async getRowCount(
    tableName: string,
  ): Promise<number | undefined> {
    const { schema, table } = this.#adapter.parseTableName(tableName);
    const database = schema || (await this.#getCurrentDatabase());

    const tableIdentifier = `${this.#adapter.quoteIdentifier(database)}.${this.#adapter.quoteIdentifier(table)}`;

    try {
      const rows = await this.#adapter.runQuery<{
        count: number | string | bigint | null;
      }>(`SELECT COUNT(*) AS count FROM ${tableIdentifier}`);

      return this.#toNumber(rows[0]?.count);
    } catch {
      return undefined;
    }
  }

  #toNumber(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === 'bigint') {
      return Number(value);
    }
    if (typeof value === 'string' && value.trim() !== '') {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : undefined;
    }
    return undefined;
  }

  async #getCurrentDatabase(): Promise<string> {
    const rows = await this.#adapter.runQuery<{ db: string | null }>(
      'SELECT DATABASE() AS db',
    );
    return rows[0]?.db ?? '';
  }
}
