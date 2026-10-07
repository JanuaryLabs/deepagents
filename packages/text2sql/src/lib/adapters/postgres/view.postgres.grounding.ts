import { nameRow, viewDefinitionRow } from '../groundings/rows.ts';
import {
  type View,
  ViewGrounding,
  type ViewGroundingConfig,
} from '../groundings/view.grounding.ts';
import { columnRow } from './postgres-rows.ts';
import type { Postgres } from './postgres.ts';

export interface PostgresViewGroundingConfig extends ViewGroundingConfig {
  /** Schemas to include (defaults to the adapter's schemas option) */
  schemas?: string[];
}

/**
 * PostgreSQL implementation of ViewGrounding.
 */
export class PostgresViewGrounding extends ViewGrounding {
  #adapter: Postgres;
  #schemas?: string[];

  constructor(adapter: Postgres, config: PostgresViewGroundingConfig = {}) {
    super(config);
    this.#adapter = adapter;
    this.#schemas = config.schemas ?? adapter.schemas;
  }

  protected override async getAllViewNames(): Promise<string[]> {
    const rows = await this.#adapter.runQuery(
      `
      SELECT table_schema || '.' || table_name AS name
      FROM information_schema.views
      WHERE 1=1
        ${this.#adapter.buildSchemaFilter('table_schema', this.#schemas)}
      ORDER BY name
    `,
      nameRow,
    );
    return rows.map((r) => r.name);
  }

  protected override async getView(viewName: string): Promise<View> {
    const { schema, table: view } = this.#adapter.parseTableName(viewName);

    let definition: string | undefined;
    if (this.includeDefinition) {
      const defRows = await this.#adapter.runQuery(
        `
        SELECT definition
        FROM pg_views
        WHERE schemaname = '${this.#adapter.escapeString(schema)}'
          AND viewname = '${this.#adapter.escapeString(view)}'
      `,
        viewDefinitionRow,
      );
      definition = defRows[0]?.definition ?? undefined;
    }

    const columns = await this.#adapter.runQuery(
      `
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_schema = '${this.#adapter.escapeString(schema)}'
        AND table_name = '${this.#adapter.escapeString(view)}'
      ORDER BY ordinal_position
    `,
      columnRow,
    );

    return {
      name: viewName,
      schema,
      rawName: view,
      definition,
      columns: columns.map((col) => ({
        name: col.column_name ?? 'unknown',
        type: col.data_type ?? 'unknown',
      })),
    };
  }
}
