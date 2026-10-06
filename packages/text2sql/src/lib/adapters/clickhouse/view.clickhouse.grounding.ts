import { z } from 'zod';

import type { Adapter } from '../adapter.ts';
import { nameRow } from '../groundings/rows.ts';
import {
  type View,
  ViewGrounding,
  type ViewGroundingConfig,
} from '../groundings/view.grounding.ts';
import { columnRow } from './clickhouse-rows.ts';

/** `system.tables.create_table_query`: the CREATE VIEW statement. */
const definitionRow = z.object({ definition: z.string() });

export class ClickHouseViewGrounding extends ViewGrounding {
  readonly #adapter: Adapter;

  constructor(adapter: Adapter, config: ViewGroundingConfig = {}) {
    super(config);
    this.#adapter = adapter;
  }

  protected override async getAllViewNames(): Promise<string[]> {
    const rows = await this.#adapter.runQuery(
      `
      SELECT concat(database, '.', name) AS name
      FROM system.tables
      WHERE database NOT IN ('system', 'information_schema', 'INFORMATION_SCHEMA')
        AND is_temporary = 0
        AND endsWith(engine, 'View')
      ORDER BY database, name
    `,
      nameRow,
    );
    return rows.map((row) => row.name);
  }

  protected override async getView(viewName: string): Promise<View> {
    const { schema, table } = this.#adapter.parseTableName(viewName);
    if (!schema) {
      throw new Error(
        `ClickHouse view grounding requires a qualified view name: ${viewName}`,
      );
    }

    const [columns, definitionRows] = await Promise.all([
      this.#adapter.runQuery(
        `
        SELECT name, type
        FROM system.columns
        WHERE database = '${this.#adapter.escapeString(schema)}'
          AND table = '${this.#adapter.escapeString(table)}'
        ORDER BY position
      `,
        columnRow,
      ),
      this.includeDefinition
        ? this.#adapter.runQuery(
            `
            SELECT create_table_query AS definition
            FROM system.tables
            WHERE database = '${this.#adapter.escapeString(schema)}'
              AND name = '${this.#adapter.escapeString(table)}'
              AND endsWith(engine, 'View')
          `,
            definitionRow,
          )
        : Promise.resolve([]),
    ]);

    return {
      name: viewName,
      schema,
      rawName: table,
      definition: definitionRows[0]?.definition,
      columns: columns.map((column) => ({
        name: column.name,
        type: column.type,
      })),
    };
  }
}
