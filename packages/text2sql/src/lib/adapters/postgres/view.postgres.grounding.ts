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

export interface PostgresViewGroundingConfig extends ViewGroundingConfig {
  /** Schemas to include (defaults to excluding pg_catalog and information_schema) */
  schemas?: string[];
}

/**
 * PostgreSQL implementation of ViewGrounding.
 */
export class PostgresViewGrounding extends ViewGrounding {
  #adapter: Adapter;
  #schemas?: string[];

  constructor(adapter: Adapter, config: PostgresViewGroundingConfig = {}) {
    super(config);
    this.#adapter = adapter;
    this.#schemas = config.schemas;
  }

  protected override async getAllViewNames(): Promise<string[]> {
    const rows = await this.#adapter.runQuery<{ name: string }>(`
      SELECT table_schema || '.' || table_name AS name
      FROM information_schema.views
      WHERE 1=1
        ${this.#adapter.buildSchemaFilter('table_schema', this.#schemas)}
      ORDER BY name
    `);
    return rows.map((r) => r.name);
  }

  protected override async getView(viewName: string): Promise<View> {
    const { schema, table: view } = this.#adapter.parseTableName(viewName);

    // Get view definition from pg_views
    const defRows = await this.#adapter.runQuery<{
      definition: string | null;
    }>(`
      SELECT definition
      FROM pg_views
      WHERE schemaname = '${this.#adapter.escapeString(schema)}'
        AND viewname = '${this.#adapter.escapeString(view)}'
    `);

    // Get columns from information_schema
    const columns = await this.#adapter.runQuery<ColumnRow>(`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_schema = '${this.#adapter.escapeString(schema)}'
        AND table_name = '${this.#adapter.escapeString(view)}'
      ORDER BY ordinal_position
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
