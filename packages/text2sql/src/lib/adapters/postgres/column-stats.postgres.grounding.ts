import type { Adapter, ColumnStats } from '../adapter.ts';
import {
  ColumnStatsGrounding,
  type ColumnStatsGroundingConfig,
} from '../groundings/column-stats.grounding.ts';
import type { Column, GroundingContext } from '../groundings/context.ts';

interface PgStatsRow {
  attname: string;
  null_frac: number | null;
  n_distinct: number | null;
  histogram_bounds: string | null;
  correlation: number | null;
}

export class PostgresColumnStatsGrounding extends ColumnStatsGrounding {
  #adapter: Adapter;
  #pgStatsCache = new Map<string, Map<string, PgStatsRow>>();

  constructor(adapter: Adapter, config: ColumnStatsGroundingConfig = {}) {
    super(config);
    this.#adapter = adapter;
  }

  override async execute(ctx: GroundingContext): Promise<void> {
    await this.#fetchAllPgStats(ctx);
    await super.execute(ctx);
  }

  async #fetchAllPgStats(ctx: GroundingContext): Promise<void> {
    const allContainers = [...ctx.tables, ...ctx.views];
    if (allContainers.length === 0) return;

    const conditions = allContainers.map((container) => {
      const { schema, table } = this.#adapter.parseTableName(container.name);
      return `(schemaname = '${this.#adapter.escapeString(schema)}' AND tablename = '${this.#adapter.escapeString(table)}')`;
    });

    const rows = await this.#adapter.runQuery<
      PgStatsRow & { schemaname: string; tablename: string }
    >(`
      SELECT
        schemaname,
        tablename,
        attname,
        null_frac,
        n_distinct,
        histogram_bounds::text,
        correlation
      FROM pg_stats
      WHERE ${conditions.join(' OR ')}
    `);

    for (const row of rows) {
      const tableName = allContainers.find((c) => {
        const { schema, table } = this.#adapter.parseTableName(c.name);
        return schema === row.schemaname && table === row.tablename;
      })?.name;
      if (!tableName) continue;

      let map = this.#pgStatsCache.get(tableName);
      if (!map) {
        map = new Map();
        this.#pgStatsCache.set(tableName, map);
      }
      map.set(row.attname, row);
    }
  }

  protected override async collectStats(
    tableName: string,
    column: Column,
  ): Promise<ColumnStats | undefined> {
    const cached = this.#pgStatsCache.get(tableName)?.get(column.name);
    if (cached) {
      return this.#fromPgStats(cached);
    }

    return this.#collectStatsLive(tableName, column);
  }

  #fromPgStats(row: PgStatsRow): ColumnStats | undefined {
    const bounds = row.histogram_bounds
      ? this.#parsePgArray(row.histogram_bounds)
      : undefined;

    const nullFraction = this.#adapter.toNumber(row.null_frac);
    const nDistinct = this.#adapter.toNumber(row.n_distinct);
    const correlation = this.#adapter.toNumber(row.correlation);

    const result: ColumnStats = {
      ...(bounds?.length && { min: bounds[0] }),
      ...(bounds?.length && { max: bounds[bounds.length - 1] }),
      ...(nullFraction != null && {
        nullFraction: Math.max(0, Math.min(1, nullFraction)),
      }),
      ...(nDistinct != null && { nDistinct }),
      ...(correlation != null && {
        correlation: Math.max(-1, Math.min(1, correlation)),
      }),
    };

    return Object.keys(result).length > 0 ? result : undefined;
  }

  async #collectStatsLive(
    tableName: string,
    column: Column,
  ): Promise<ColumnStats | undefined> {
    if (!this.#shouldCollectStats(column.type)) {
      return undefined;
    }

    const { schema, table } = this.#adapter.parseTableName(tableName);
    const tableIdentifier = `${this.#adapter.quoteIdentifier(schema)}.${this.#adapter.quoteIdentifier(table)}`;
    const columnIdentifier = this.#adapter.quoteIdentifier(column.name);

    const rows = await this.#adapter.runQuery<{
      min_value: string | null;
      max_value: string | null;
      null_fraction: number | string | null;
    }>(`
      SELECT
        MIN(${columnIdentifier})::text AS min_value,
        MAX(${columnIdentifier})::text AS max_value,
        AVG(CASE WHEN ${columnIdentifier} IS NULL THEN 1.0 ELSE 0.0 END) AS null_fraction
      FROM ${tableIdentifier}
    `);

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
    return /int|real|numeric|double|float|decimal|date|time|serial/.test(
      normalized,
    );
  }

  #parsePgArray(text: string): string[] {
    const inner =
      text.startsWith('{') && text.endsWith('}') ? text.slice(1, -1) : text;

    if (!inner) {
      return [];
    }

    const values: string[] = [];
    let current = '';
    let inQuote = false;

    for (let i = 0; i < inner.length; i++) {
      const ch = inner[i];

      if (inQuote) {
        if (ch === '"' && inner[i + 1] === '"') {
          current += '"';
          i++;
        } else if (ch === '"') {
          inQuote = false;
        } else {
          current += ch;
        }
      } else if (ch === '"') {
        inQuote = true;
      } else if (ch === ',') {
        values.push(current);
        current = '';
      } else {
        current += ch;
      }
    }

    values.push(current);
    return values;
  }
}
