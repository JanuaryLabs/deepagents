import type { Adapter, ColumnStats } from '../adapter.ts';
import {
  ColumnStatsGrounding,
  type ColumnStatsGroundingConfig,
} from '../groundings/column-stats.grounding.ts';
import type { Column } from '../groundings/context.ts';

/**
 * PostgreSQL implementation of ColumnStatsGrounding.
 */
export class PostgresColumnStatsGrounding extends ColumnStatsGrounding {
  #adapter: Adapter;

  constructor(adapter: Adapter, config: ColumnStatsGroundingConfig = {}) {
    super(config);
    this.#adapter = adapter;
  }

  protected override async collectStats(
    tableName: string,
    column: Column,
  ): Promise<ColumnStats | undefined> {
    if (!this.#shouldCollectStats(column.type)) {
      return undefined;
    }

    const { schema, table } = this.#adapter.parseTableName(tableName);
    const tableIdentifier = `${this.#adapter.quoteIdentifier(schema)}.${this.#adapter.quoteIdentifier(table)}`;
    const columnIdentifier = this.#adapter.quoteIdentifier(column.name);

    const sql = `
      SELECT
        MIN(${columnIdentifier})::text AS min_value,
        MAX(${columnIdentifier})::text AS max_value,
        AVG(CASE WHEN ${columnIdentifier} IS NULL THEN 1.0 ELSE 0.0 END) AS null_fraction
      FROM ${tableIdentifier}
    `;

    const rows = await this.#adapter.runQuery<{
      min_value: string | null;
      max_value: string | null;
      null_fraction: number | string | null;
    }>(sql);

    if (!rows.length) {
      return undefined;
    }

    const min = rows[0]?.min_value;
    const max = rows[0]?.max_value;
    const nullFraction = this.#adapter.toNumber(rows[0]?.null_fraction);

    if (min == null && max == null && nullFraction == null) {
      return undefined;
    }

    return {
      min: min ?? undefined,
      max: max ?? undefined,
      nullFraction:
        nullFraction != null && Number.isFinite(nullFraction)
          ? Math.max(0, Math.min(1, nullFraction))
          : undefined,
    };
  }

  #shouldCollectStats(type: string | undefined): boolean {
    if (!type) {
      return false;
    }
    const normalized = type.toLowerCase();
    return /int|real|numeric|double|float|decimal|date|time|bool|serial/.test(
      normalized,
    );
  }
}
