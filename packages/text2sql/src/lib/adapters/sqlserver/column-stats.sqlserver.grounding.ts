import type { Adapter, ColumnStats } from '../adapter.ts';
import {
  ColumnStatsGrounding,
  type ColumnStatsGroundingConfig,
} from '../groundings/column-stats.grounding.ts';
import type { Column, GroundingContext } from '../groundings/context.ts';

interface NDistinctRow {
  schema_name: string;
  table_name: string;
  column_name: string;
  approx_n_distinct: number;
}

export class SqlServerColumnStatsGrounding extends ColumnStatsGrounding {
  #adapter: Adapter;
  #nDistinctCache = new Map<string, Map<string, number>>();

  constructor(adapter: Adapter, config: ColumnStatsGroundingConfig = {}) {
    super(config);
    this.#adapter = adapter;
  }

  override async execute(ctx: GroundingContext): Promise<void> {
    await this.#fetchNDistinct(ctx);
    await super.execute(ctx);
  }

  async #fetchNDistinct(ctx: GroundingContext): Promise<void> {
    if (ctx.tables.length === 0) return;

    const objectIds = ctx.tables.map((t) => {
      const { schema, table } = this.#adapter.parseTableName(t.name);
      return `OBJECT_ID('[${this.#adapter.escape(schema)}].[${this.#adapter.escape(table)}]')`;
    });

    try {
      const rows = await this.#adapter.runQuery<NDistinctRow>(`
        SELECT
          OBJECT_SCHEMA_NAME(s.object_id) AS schema_name,
          OBJECT_NAME(s.object_id) AS table_name,
          COL_NAME(sc.object_id, sc.column_id) AS column_name,
          (
            SELECT ISNULL(SUM(h.distinct_range_rows), 0) + COUNT(*)
            FROM sys.dm_db_stats_histogram(s.object_id, s.stats_id) h
          ) AS approx_n_distinct
        FROM sys.stats s
        INNER JOIN sys.stats_columns sc
          ON s.object_id = sc.object_id AND s.stats_id = sc.stats_id
        CROSS APPLY sys.dm_db_stats_properties(s.object_id, s.stats_id) sp
        WHERE sc.stats_column_id = 1
          AND sp.rows > 0
          AND s.object_id IN (${objectIds.join(', ')})
      `);

      for (const row of rows) {
        const tableName = ctx.tables.find((t) => {
          const { schema, table } = this.#adapter.parseTableName(t.name);
          return schema === row.schema_name && table === row.table_name;
        })?.name;
        if (!tableName) continue;

        let map = this.#nDistinctCache.get(tableName);
        if (!map) {
          map = new Map();
          this.#nDistinctCache.set(tableName, map);
        }
        map.set(row.column_name, row.approx_n_distinct);
      }
    } catch {
      // sys.dm_db_stats_histogram requires SQL Server 2016 SP1+
    }
  }

  protected override async collectStats(
    tableName: string,
    column: Column,
  ): Promise<ColumnStats | undefined> {
    const cachedNDistinct = this.#nDistinctCache
      .get(tableName)
      ?.get(column.name);

    if (!this.#shouldCollectStats(column.type)) {
      if (cachedNDistinct != null) {
        return { nDistinct: cachedNDistinct };
      }
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
      if (cachedNDistinct != null) {
        return { nDistinct: cachedNDistinct };
      }
      return undefined;
    }

    const min = rows[0]?.min_value;
    const max = rows[0]?.max_value;
    const nullFraction = this.#adapter.toNumber(rows[0]?.null_fraction);

    if (
      min == null &&
      max == null &&
      nullFraction == null &&
      cachedNDistinct == null
    ) {
      return undefined;
    }

    return {
      min: min ?? undefined,
      max: max ?? undefined,
      nullFraction:
        nullFraction != null && Number.isFinite(nullFraction)
          ? Math.max(0, Math.min(1, nullFraction))
          : undefined,
      ...(cachedNDistinct != null && { nDistinct: cachedNDistinct }),
    };
  }

  #shouldCollectStats(type: string | undefined): boolean {
    if (!type) {
      return false;
    }
    const normalized = type.toLowerCase();
    return /int|real|numeric|float|decimal|date|time|money/.test(normalized);
  }
}
