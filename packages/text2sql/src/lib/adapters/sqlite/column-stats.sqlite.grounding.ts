import type { Adapter, ColumnStats } from '../adapter.ts';
import {
  ColumnStatsGrounding,
  type ColumnStatsGroundingConfig,
} from '../groundings/column-stats.grounding.ts';
import type { Column } from '../groundings/context.ts';

/**
 * SQLite implementation of ColumnStatsGrounding.
 */
export class SqliteColumnStatsGrounding extends ColumnStatsGrounding {
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

    const tableIdentifier = this.#adapter.quoteIdentifier(tableName);
    const columnIdentifier = this.#adapter.quoteIdentifier(column.name);

    const sql = `
      SELECT
        MIN(${columnIdentifier}) AS min_value,
        MAX(${columnIdentifier}) AS max_value,
        AVG(CASE WHEN ${columnIdentifier} IS NULL THEN 1.0 ELSE 0.0 END) AS null_fraction
      FROM ${tableIdentifier}
    `;

    const rows = await this.#adapter.runQuery<{
      min_value: unknown;
      max_value: unknown;
      null_fraction: number | string | null;
    }>(sql);

    if (!rows.length) {
      return undefined;
    }

    const min = this.#normalizeValue(rows[0]?.min_value);
    const max = this.#normalizeValue(rows[0]?.max_value);
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
    return /int|real|numeric|double|float|decimal|date|time|bool/.test(
      normalized,
    );
  }

  #normalizeValue(value: unknown): string | null {
    if (value === null || value === undefined) {
      return null;
    }
    if (typeof value === 'string') {
      return value;
    }
    if (typeof value === 'number' || typeof value === 'bigint') {
      return String(value);
    }
    if (typeof value === 'boolean') {
      return value ? 'true' : 'false';
    }
    if (value instanceof Date) {
      return value.toISOString();
    }
    if (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) {
      return value.toString('utf-8');
    }
    return null;
  }
}
