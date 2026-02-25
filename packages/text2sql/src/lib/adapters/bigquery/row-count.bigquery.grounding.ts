import type { Table } from '../adapter.ts';
import type { GroundingContext } from '../groundings/context.ts';
import {
  RowCountGrounding,
  type RowCountGroundingConfig,
} from '../groundings/row-count.grounding.ts';
import type { BigQuery } from './bigquery.ts';

type RowCountRow = {
  table_name: string | null;
  total_rows: number | string | null;
};

type LegacyRowCountRow = {
  table_name: string | null;
  row_count: number | string | null;
};

export interface BigQueryRowCountGroundingConfig extends RowCountGroundingConfig {}

export class BigQueryRowCountGrounding extends RowCountGrounding {
  #adapter: BigQuery;

  constructor(adapter: BigQuery, config: BigQueryRowCountGroundingConfig = {}) {
    super(config);
    this.#adapter = adapter;
  }

  override async execute(ctx: GroundingContext): Promise<void> {
    const byDataset = new Map<string, Table[]>();
    for (const table of ctx.tables) {
      const { schema: dataset } = this.#adapter.parseTableName(table.name);
      const list = byDataset.get(dataset) ?? [];
      list.push(table);
      byDataset.set(dataset, list);
    }

    for (const [dataset, tables] of byDataset) {
      const tableNames = tables.map(
        (t) => this.#adapter.parseTableName(t.name).table,
      );
      const counts = await this.#fetchRowCounts(dataset, tableNames);

      for (const table of tables) {
        const rawName = this.#adapter.parseTableName(table.name).table;
        const count = counts.get(rawName);
        if (count != null) {
          table.rowCount = count;
          table.sizeHint = this.#classifyRowCount(count);
        }
      }
    }
  }

  async #fetchRowCounts(
    dataset: string,
    tableNames: string[],
  ): Promise<Map<string, number>> {
    const inList = tableNames
      .map((n) => `'${this.#adapter.escapeString(n)}'`)
      .join(', ');

    try {
      return await this.#fromTableStorage(dataset, inList);
    } catch {
      // TABLE_STORAGE may not be accessible on cross-project public datasets
    }

    try {
      return await this.#fromLegacyTables(dataset, inList);
    } catch {
      // __TABLES__ may also be unavailable in some contexts
    }

    return new Map();
  }

  async #fromTableStorage(
    dataset: string,
    inList: string,
  ): Promise<Map<string, number>> {
    const rows = await this.#adapter.runQuery<RowCountRow>(`
      SELECT table_name, total_rows
      FROM ${this.#adapter.infoSchemaView(dataset, 'TABLE_STORAGE')}
      WHERE table_name IN (${inList})
    `);

    const result = new Map<string, number>();
    for (const row of rows) {
      if (!row.table_name) continue;
      const count = this.#adapter.toNumber(row.total_rows);
      if (count != null) result.set(row.table_name, count);
    }
    return result;
  }

  async #fromLegacyTables(
    dataset: string,
    inList: string,
  ): Promise<Map<string, number>> {
    const projectPrefix = this.#adapter.projectId
      ? `\`${this.#adapter.projectId}\`.`
      : '';
    const rows = await this.#adapter.runQuery<LegacyRowCountRow>(`
      SELECT table_id AS table_name, row_count
      FROM ${projectPrefix}\`${dataset}\`.__TABLES__
      WHERE table_id IN (${inList})
    `);

    const result = new Map<string, number>();
    for (const row of rows) {
      if (!row.table_name) continue;
      const count = this.#adapter.toNumber(row.row_count);
      if (count != null) result.set(row.table_name, count);
    }
    return result;
  }

  #classifyRowCount(count: number): Table['sizeHint'] {
    if (count < 100) return 'tiny';
    if (count < 1000) return 'small';
    if (count < 10000) return 'medium';
    if (count < 100000) return 'large';
    return 'huge';
  }

  protected override async getRowCount(
    _tableName: string,
  ): Promise<number | undefined> {
    return undefined;
  }
}
