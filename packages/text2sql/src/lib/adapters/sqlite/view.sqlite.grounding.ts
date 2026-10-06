import type { Adapter } from '../adapter.ts';
import { nameRow } from '../groundings/rows.ts';
import {
  type View,
  ViewGrounding,
  type ViewGroundingConfig,
} from '../groundings/view.grounding.ts';
import { sqliteMasterSqlRow, tableInfoRow } from './sqlite-rows.ts';

/**
 * SQLite implementation of ViewGrounding.
 */
export class SqliteViewGrounding extends ViewGrounding {
  #adapter: Adapter;

  constructor(adapter: Adapter, config: ViewGroundingConfig = {}) {
    super(config);
    this.#adapter = adapter;
  }

  protected override async getAllViewNames(): Promise<string[]> {
    const rows = await this.#adapter.runQuery(
      `SELECT name FROM sqlite_master WHERE type='view' ORDER BY name`,
      nameRow,
    );

    return rows.map((row) => row.name);
  }

  protected override async getView(viewName: string): Promise<View> {
    let definition: string | undefined;
    if (this.includeDefinition) {
      const defRows = await this.#adapter.runQuery(
        `SELECT sql FROM sqlite_master WHERE type='view' AND name=${this.#quoteIdentifier(viewName)}`,
        sqliteMasterSqlRow,
      );
      definition = defRows[0]?.sql ?? undefined;
    }

    const columns = await this.#adapter.runQuery(
      `PRAGMA table_info(${this.#quoteIdentifier(viewName)})`,
      tableInfoRow,
    );

    return {
      name: viewName,
      definition,
      columns: columns.map((col) => ({ name: col.name, type: col.type })),
    };
  }

  #quoteIdentifier(name: string) {
    return `'${name.replace(/'/g, "''")}'`;
  }
}
