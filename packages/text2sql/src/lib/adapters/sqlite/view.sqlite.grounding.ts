import type { Adapter } from '../adapter.ts';
import {
  type View,
  ViewGrounding,
  type ViewGroundingConfig,
} from '../groundings/view.grounding.ts';

type ColumnRow = {
  name: string | null | undefined;
  type: string | null | undefined;
};

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
    const rows = await this.#adapter.runQuery<{
      name: string | null | undefined;
    }>(`SELECT name FROM sqlite_master WHERE type='view' ORDER BY name`);

    return rows
      .map((row) => row.name)
      .filter((name): name is string => typeof name === 'string');
  }

  protected override async getView(viewName: string): Promise<View> {
    // Get view definition from sqlite_master
    const defRows = await this.#adapter.runQuery<{
      sql: string | null | undefined;
    }>(
      `SELECT sql FROM sqlite_master WHERE type='view' AND name=${this.#quoteIdentifier(viewName)}`,
    );

    // Get columns via PRAGMA table_info (works for views too)
    const columns = await this.#adapter.runQuery<ColumnRow>(
      `PRAGMA table_info(${this.#quoteIdentifier(viewName)})`,
    );

    return {
      name: viewName,
      definition: defRows[0]?.sql ?? undefined,
      columns: columns.map((col) => ({
        name: col.name ?? 'unknown',
        type: col.type ?? 'unknown',
      })),
    };
  }

  #quoteIdentifier(name: string) {
    return `'${name.replace(/'/g, "''")}'`;
  }
}
