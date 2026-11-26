import { z } from 'zod';

import type { Table } from '../adapter.ts';
import type { GroundingContext } from '../groundings/context.ts';
import {
  RowCountGrounding,
  type RowCountGroundingConfig,
} from '../groundings/row-count.grounding.ts';
import { numericValue } from '../groundings/rows.ts';
import type { BigQuery } from './bigquery.ts';

/** A source of BigQuery row counts failed; the grounding tries the next source, or goes on without row counts. */
class RowCountSourceWarning extends Error {
  readonly code = 'DEEPAGENTS_TEXT2SQL_BIGQUERY_ROW_COUNT_SOURCE_FAILED';
  readonly detail: string;

  constructor(
    failure: unknown,
    source: 'INFORMATION_SCHEMA.TABLE_STORAGE' | '__TABLES__',
    next: string,
    dataset: string,
  ) {
    super(
      `Reading row counts from ${source} failed, and ${next}: ${Error.isError(failure) ? failure.message : String(failure)}`,
      { cause: failure },
    );
    this.name = 'RowCountSourceWarning';
    this.detail = `dataset: ${dataset}`;
  }
}

/** TABLE_STORAGE: total_rows is an INT64. */
const tableStorageRow = z.object({
  table_name: z.string().nullable(),
  total_rows: numericValue.nullable(),
});

/** Legacy __TABLES__: row_count is an INT64. */
const legacyRowCountRow = z.object({
  table_name: z.string().nullable(),
  row_count: numericValue.nullable(),
});

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

    let current = 0;
    const total = ctx.tables.length;
    for (const [dataset, tables] of byDataset) {
      for (const table of tables) {
        current++;
        ctx.onProgress({
          type: 'phase:progress',
          phase: 'row_counts',
          table: table.name,
          message: `Counting rows in ${table.name}...`,
          current,
          total,
        });
      }
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
    } catch (error) {
      // TABLE_STORAGE may not be accessible on cross-project public datasets
      process.emitWarning(
        new RowCountSourceWarning(
          error,
          'INFORMATION_SCHEMA.TABLE_STORAGE',
          'the grounding reads __TABLES__ instead',
          dataset,
        ),
      );
    }

    try {
      return await this.#fromLegacyTables(dataset, inList);
    } catch (error) {
      // __TABLES__ may also be unavailable in some contexts
      process.emitWarning(
        new RowCountSourceWarning(
          error,
          '__TABLES__',
          'the dataset has no row counts',
          dataset,
        ),
      );
    }

    return new Map();
  }

  async #fromTableStorage(
    dataset: string,
    inList: string,
  ): Promise<Map<string, number>> {
    const rows = await this.#adapter.runQuery(
      `
      SELECT table_name, total_rows
      FROM ${this.#adapter.infoSchemaView(dataset, 'TABLE_STORAGE')}
      WHERE table_name IN (${inList})
    `,
      tableStorageRow,
    );

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
    const rows = await this.#adapter.runQuery(
      `
      SELECT table_id AS table_name, row_count
      FROM ${projectPrefix}\`${dataset}\`.__TABLES__
      WHERE table_id IN (${inList})
    `,
      legacyRowCountRow,
    );

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
