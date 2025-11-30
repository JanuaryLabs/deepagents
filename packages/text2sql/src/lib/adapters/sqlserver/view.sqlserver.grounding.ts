import type { Adapter } from '../adapter.ts';
import {
  type View,
  ViewGrounding,
  type ViewGroundingConfig,
} from '../groundings/view.grounding.ts';

type ColumnRow = {
  column_name: string | null;
  data_type: string | null;
};

export interface SqlServerViewGroundingConfig extends ViewGroundingConfig {
  /** Schemas to include (defaults to excluding INFORMATION_SCHEMA and sys) */
  schemas?: string[];
}

/**
 * SQL Server implementation of ViewGrounding.
 */
export class SqlServerViewGrounding extends ViewGrounding {
  #adapter: Adapter;
  #schemas?: string[];

  constructor(adapter: Adapter, config: SqlServerViewGroundingConfig = {}) {
    super(config);
    this.#adapter = adapter;
    this.#schemas = config.schemas;
  }

  protected override async getAllViewNames(): Promise<string[]> {
    const rows = await this.#adapter.runQuery<{ name: string }>(`
      SELECT TABLE_SCHEMA + '.' + TABLE_NAME AS name
      FROM INFORMATION_SCHEMA.VIEWS
      WHERE 1=1
        ${this.#adapter.buildSchemaFilter('TABLE_SCHEMA', this.#schemas)}
      ORDER BY name
    `);
    return rows.map((r) => r.name);
  }

  protected override async getView(viewName: string): Promise<View> {
    const { schema, table: view } = this.#adapter.parseTableName(viewName);

    // Get view definition from sys.sql_modules
    const defRows = await this.#adapter.runQuery<{
      definition: string | null;
    }>(`
      SELECT m.definition
      FROM sys.views v
      JOIN sys.schemas s ON v.schema_id = s.schema_id
      JOIN sys.sql_modules m ON v.object_id = m.object_id
      WHERE s.name = '${this.#adapter.escapeString(schema)}'
        AND v.name = '${this.#adapter.escapeString(view)}'
    `);

    // Get columns from INFORMATION_SCHEMA
    const columns = await this.#adapter.runQuery<ColumnRow>(`
      SELECT COLUMN_NAME AS column_name, DATA_TYPE AS data_type
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = '${this.#adapter.escapeString(schema)}'
        AND TABLE_NAME = '${this.#adapter.escapeString(view)}'
      ORDER BY ORDINAL_POSITION
    `);

    return {
      name: viewName,
      schema,
      rawName: view,
      definition: defRows[0]?.definition ?? undefined,
      columns: columns.map((col) => ({
        name: col.column_name ?? 'unknown',
        type: col.data_type ?? 'unknown',
      })),
    };
  }
}
