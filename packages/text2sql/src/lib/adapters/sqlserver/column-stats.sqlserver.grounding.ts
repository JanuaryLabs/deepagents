import type { Adapter, ColumnStats } from '../adapter.ts';
import {
  ColumnStatsGrounding,
  type ColumnStatsGroundingConfig,
} from '../groundings/column-stats.grounding.ts';
import type { Column } from '../groundings/context.ts';

/**
 * SQL Server implementation of ColumnStatsGrounding.
 */
export class SqlServerColumnStatsGrounding extends ColumnStatsGrounding {
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
    const tableIdentifier = `[${this.#adapter.escape(schema)}].[${this.#adapter.escape(table)}]`;
    const columnIdentifier = `[${this.#adapter.escape(column.name)}]`;

    const sql = `
      SELECT
        CAST(MIN(${columnIdentifier}) AS NVARCHAR(MAX)) AS min_value,
        CAST(MAX(${columnIdentifier}) AS NVARCHAR(MAX)) AS max_value,
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
    // Note: bit excluded because SQL Server doesn't support MIN/MAX on bit types
    return /int|real|numeric|float|decimal|date|time|money/.test(normalized);
  }
}
