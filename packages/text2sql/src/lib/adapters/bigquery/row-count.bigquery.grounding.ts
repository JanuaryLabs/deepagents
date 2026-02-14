import type { Adapter } from '../adapter.ts';
import {
  RowCountGrounding,
  type RowCountGroundingConfig,
} from '../groundings/row-count.grounding.ts';
import type { BigQuery } from './bigquery.ts';

type RowCountRow = {
  total_rows: number | string | null;
};

export interface BigQueryRowCountGroundingConfig extends RowCountGroundingConfig {}

/**
 * BigQuery row counts are metadata-only.
 * Uses INFORMATION_SCHEMA.TABLE_STORAGE and never issues COUNT(*).
 */
export class BigQueryRowCountGrounding extends RowCountGrounding {
  #adapter: BigQuery;

  constructor(adapter: Adapter, config: BigQueryRowCountGroundingConfig = {}) {
    super(config);
    this.#adapter = adapter as BigQuery;
  }

  protected override async getRowCount(
    tableName: string,
  ): Promise<number | undefined> {
    const { schema: dataset, table } = this.#adapter.parseTableName(tableName);

    const rows = await this.#adapter.runQuery<RowCountRow>(`
      SELECT total_rows
      FROM ${this.#adapter.infoSchemaView(dataset, 'TABLE_STORAGE')}
      WHERE table_name = '${this.#adapter.escapeString(table)}'
      LIMIT 1
    `);

    const value = rows[0]?.total_rows;
    return this.#adapter.toNumber(value);
  }
}
