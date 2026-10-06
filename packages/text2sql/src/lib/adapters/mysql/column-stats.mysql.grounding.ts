import { z } from 'zod';

import type { Adapter, ColumnStats } from '../adapter.ts';
import {
  ColumnStatsGrounding,
  type ColumnStatsGroundingConfig,
} from '../groundings/column-stats.grounding.ts';
import type { Column } from '../groundings/column-values.grounding.ts';
import { numericValue } from '../groundings/rows.ts';
import { currentDatabaseRow } from './mysql-rows.ts';

/**
 * MIN/MAX are cast to CHAR, so they are strings; AVG of 1.0/0.0 is a DECIMAL,
 * which mysql2 and the mariadb connector return as a string. All three are
 * NULL for an empty table.
 */
const statsRow = z.object({
  min_value: z.string().nullable(),
  max_value: z.string().nullable(),
  null_fraction: numericValue.nullable(),
});

/**
 * MySQL/MariaDB implementation of ColumnStatsGrounding.
 *
 * Collects min/max/null statistics for numeric, date, and boolean columns.
 */
export class MysqlColumnStatsGrounding extends ColumnStatsGrounding {
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
    const database = schema || (await this.#getCurrentDatabase());

    const tableIdentifier = `${this.#adapter.quoteIdentifier(database)}.${this.#adapter.quoteIdentifier(table)}`;
    const columnIdentifier = this.#adapter.quoteIdentifier(column.name);

    try {
      const rows = await this.#adapter.runQuery(
        `
        SELECT
          CAST(MIN(${columnIdentifier}) AS CHAR) AS min_value,
          CAST(MAX(${columnIdentifier}) AS CHAR) AS max_value,
          AVG(CASE WHEN ${columnIdentifier} IS NULL THEN 1.0 ELSE 0.0 END) AS null_fraction
        FROM ${tableIdentifier}
      `,
        statsRow,
      );

      if (!rows.length) {
        return undefined;
      }

      const min = rows[0]?.min_value ?? undefined;
      const max = rows[0]?.max_value ?? undefined;
      const nullFraction = this.#toNumber(rows[0]?.null_fraction);

      if (min == null && max == null && nullFraction == null) {
        return undefined;
      }

      return {
        min,
        max,
        nullFraction:
          nullFraction != null && Number.isFinite(nullFraction)
            ? Math.max(0, Math.min(1, nullFraction))
            : undefined,
      };
    } catch {
      return undefined;
    }
  }

  #shouldCollectStats(type: string | undefined): boolean {
    if (!type) {
      return false;
    }
    const normalized = type.toLowerCase();
    // Include numeric, date/time, and boolean types
    return /int|numeric|decimal|double|float|real|date|time|timestamp|datetime|bool|bit|year/.test(
      normalized,
    );
  }

  #toNumber(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === 'bigint') {
      return Number(value);
    }
    if (typeof value === 'string' && value.trim() !== '') {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  }

  async #getCurrentDatabase(): Promise<string> {
    const rows = await this.#adapter.runQuery(
      'SELECT DATABASE() AS db',
      currentDatabaseRow,
    );
    return rows[0]?.db ?? '';
  }
}
