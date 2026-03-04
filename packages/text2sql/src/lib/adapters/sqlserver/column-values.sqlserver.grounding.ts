import type { Adapter } from '../adapter.ts';
import {
  type Column,
  ColumnValuesGrounding,
  type ColumnValuesGroundingConfig,
} from '../groundings/column-values.grounding.ts';

export class SqlServerColumnValuesGrounding extends ColumnValuesGrounding {
  #adapter: Adapter;

  constructor(adapter: Adapter, config: ColumnValuesGroundingConfig = {}) {
    super(config);
    this.#adapter = adapter;
  }

  #isHighCardinality(column: Column): boolean {
    const nDistinct = column.stats?.nDistinct;
    if (nDistinct != null) {
      if (nDistinct > 0) return nDistinct > this.lowCardinalityLimit;
      return true;
    }

    const type = column.type.toLowerCase();
    if (
      /nvarchar\s*\(\s*max\s*\)|varchar\s*\(\s*max\s*\)|text|ntext|xml|image|varbinary\s*\(\s*max\s*\)|uniqueidentifier/.test(
        type,
      )
    ) {
      return true;
    }
    const varcharMatch = type.match(/n?varchar\s*\(\s*(\d+)\s*\)/);
    if (varcharMatch && parseInt(varcharMatch[1]) > 255) {
      return true;
    }
    return false;
  }

  protected override async collectLowCardinality(
    tableName: string,
    column: Column,
  ): Promise<string[] | undefined> {
    if (this.#isHighCardinality(column)) {
      return undefined;
    }

    const { schema, table } = this.#adapter.parseTableName(tableName);
    const tableIdentifier = `[${this.#adapter.escape(schema)}].[${this.#adapter.escape(table)}]`;
    const columnIdentifier = `[${this.#adapter.escape(column.name)}]`;
    const limit = this.lowCardinalityLimit + 1;

    const sql = `
      SELECT DISTINCT TOP ${limit} CAST(${columnIdentifier} AS NVARCHAR(MAX)) AS value
      FROM ${tableIdentifier}
      WHERE ${columnIdentifier} IS NOT NULL
    `;

    const rows = await this.#adapter.runQuery<{ value: string | null }>(sql);

    if (!rows.length || rows.length > this.lowCardinalityLimit) {
      return undefined;
    }

    const values: string[] = [];
    for (const row of rows) {
      if (row.value == null) {
        return undefined;
      }
      values.push(row.value);
    }

    return values.length ? values : undefined;
  }
}
