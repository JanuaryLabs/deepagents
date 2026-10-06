import { z } from 'zod';

import {
  type View,
  ViewGrounding,
  type ViewGroundingConfig,
} from '../groundings/view.grounding.ts';
import { tableNameRow } from './bigquery-rows.ts';
import type { BigQuery } from './bigquery.ts';

/** TABLES.ddl: the CREATE [MATERIALIZED] VIEW statement. */
const viewDefinitionRow = z.object({ ddl: z.string().nullable() });

const columnRow = z.object({
  column_name: z.string().nullable(),
  data_type: z.string().nullable(),
});

export interface BigQueryViewGroundingConfig extends ViewGroundingConfig {}

export class BigQueryViewGrounding extends ViewGrounding {
  #adapter: BigQuery;

  constructor(adapter: BigQuery, config: BigQueryViewGroundingConfig = {}) {
    super(config);
    this.#adapter = adapter;
  }

  protected override async applyFilter(): Promise<string[]> {
    const names = await super.applyFilter();
    return names.filter((name) => this.#isViewInScope(name));
  }

  protected override async getAllViewNames(): Promise<string[]> {
    const names: string[] = [];

    for (const dataset of this.#adapter.datasets) {
      const rows = await this.#adapter.runQuery(
        `
        SELECT table_name
        FROM ${this.#adapter.infoSchemaView(dataset, 'TABLES')}
        WHERE table_type IN ('VIEW', 'MATERIALIZED VIEW')
        ORDER BY table_name
      `,
        tableNameRow,
      );

      for (const row of rows) {
        if (!row.table_name) continue;
        names.push(`${dataset}.${row.table_name}`);
      }
    }

    return names;
  }

  protected override async getView(viewName: string): Promise<View> {
    const { schema: dataset, table } = this.#adapter.parseTableName(viewName);

    let definition: string | undefined;
    if (this.includeDefinition) {
      const defRows = await this.#adapter.runQuery(
        `
        SELECT ddl
        FROM ${this.#adapter.infoSchemaView(dataset, 'TABLES')}
        WHERE table_name = '${this.#adapter.escapeString(table)}'
          AND table_type IN ('VIEW', 'MATERIALIZED VIEW')
        LIMIT 1
      `,
        viewDefinitionRow,
      );
      definition = defRows[0]?.ddl ?? undefined;
    }

    const columns = await this.#adapter.runQuery(
      `
      SELECT column_name, data_type
      FROM ${this.#adapter.infoSchemaView(dataset, 'COLUMNS')}
      WHERE table_name = '${this.#adapter.escapeString(table)}'
      ORDER BY ordinal_position
    `,
      columnRow,
    );

    return {
      name: `${dataset}.${table}`,
      schema: dataset,
      rawName: table,
      definition,
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
