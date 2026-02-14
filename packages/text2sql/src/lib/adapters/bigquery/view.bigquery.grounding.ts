import type { Adapter } from '../adapter.ts';
import {
  type View,
  ViewGrounding,
  type ViewGroundingConfig,
} from '../groundings/view.grounding.ts';
import type { BigQuery } from './bigquery.ts';

type ViewNameRow = {
  table_name: string | null;
};

type ViewDefinitionRow = {
  ddl: string | null;
};

type ColumnRow = {
  column_name: string | null;
  data_type: string | null;
};

export interface BigQueryViewGroundingConfig extends ViewGroundingConfig {}

export class BigQueryViewGrounding extends ViewGrounding {
  #adapter: BigQuery;

  constructor(adapter: Adapter, config: BigQueryViewGroundingConfig = {}) {
    super(config);
    this.#adapter = adapter as BigQuery;
  }

  protected override async applyFilter(): Promise<string[]> {
    const names = await super.applyFilter();
    return names.filter((name) => this.#isViewInScope(name));
  }

  protected override async getAllViewNames(): Promise<string[]> {
    const names: string[] = [];

    for (const dataset of this.#adapter.datasets) {
      const rows = await this.#adapter.runQuery<ViewNameRow>(`
        SELECT table_name
        FROM ${this.#adapter.infoSchemaView(dataset, 'TABLES')}
        WHERE table_type IN ('VIEW', 'MATERIALIZED VIEW')
        ORDER BY table_name
      `);

      for (const row of rows) {
        if (!row.table_name) continue;
        names.push(`${dataset}.${row.table_name}`);
      }
    }

    return names;
  }

  protected override async getView(viewName: string): Promise<View> {
    const { schema: dataset, table } = this.#adapter.parseTableName(viewName);

    const defRows = await this.#adapter.runQuery<ViewDefinitionRow>(`
      SELECT ddl
      FROM ${this.#adapter.infoSchemaView(dataset, 'TABLES')}
      WHERE table_name = '${this.#adapter.escapeString(table)}'
        AND table_type IN ('VIEW', 'MATERIALIZED VIEW')
      LIMIT 1
    `);

    const columns = await this.#adapter.runQuery<ColumnRow>(`
      SELECT column_name, data_type
      FROM ${this.#adapter.infoSchemaView(dataset, 'COLUMNS')}
      WHERE table_name = '${this.#adapter.escapeString(table)}'
      ORDER BY ordinal_position
    `);

    return {
      name: `${dataset}.${table}`,
      schema: dataset,
      rawName: table,
      definition: defRows[0]?.ddl ?? undefined,
      columns: columns.map((c) => ({
        name: c.column_name ?? 'unknown',
        type: c.data_type ?? 'unknown',
      })),
    };
  }

  #isViewInScope(viewName: string): boolean {
    const { schema } = this.#adapter.parseTableName(viewName);
    return this.#adapter.isDatasetAllowed(schema);
  }
}
