import type { Adapter } from '../adapter.ts';
import {
  RowCountGrounding,
  type RowCountGroundingConfig,
} from '../groundings/row-count.grounding.ts';

export class ClickHouseRowCountGrounding extends RowCountGrounding {
  readonly #adapter: Adapter;

  constructor(adapter: Adapter, config: RowCountGroundingConfig = {}) {
    super(config);
    this.#adapter = adapter;
  }

  protected override async getRowCount(
    tableName: string,
  ): Promise<number | undefined> {
    const { schema, table } = this.#adapter.parseTableName(tableName);
    const relation = schema
      ? `${this.#adapter.quoteIdentifier(schema)}.${this.#adapter.quoteIdentifier(table)}`
      : this.#adapter.quoteIdentifier(table);

    try {
      const rows = await this.#adapter.runQuery<{
        count: number | string | bigint | null;
      }>(`SELECT count() AS count FROM ${relation}`);
      return toNumber(rows[0]?.count);
    } catch {
      return undefined;
    }
  }
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}
