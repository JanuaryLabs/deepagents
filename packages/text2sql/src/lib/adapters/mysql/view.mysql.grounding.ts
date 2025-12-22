import type { Adapter } from '../adapter.ts';
import {
  type View,
  ViewGrounding,
  type ViewGroundingConfig,
} from '../groundings/view.grounding.ts';
import type { Mysql } from './mysql.ts';

type ColumnRow = {
  COLUMN_NAME: string | null;
  DATA_TYPE: string | null;
};

type ViewRow = {
  VIEW_DEFINITION: string | null;
};

export interface MysqlViewGroundingConfig extends ViewGroundingConfig {
  /** Databases to include (defaults to excluding system databases) */
  databases?: string[];
}

/**
 * MySQL/MariaDB implementation of ViewGrounding.
 *
 * Uses INFORMATION_SCHEMA for view introspection.
 */
export class MysqlViewGrounding extends ViewGrounding {
  #adapter: Adapter;
  #databases?: string[];

  constructor(adapter: Adapter, config: MysqlViewGroundingConfig = {}) {
    super(config);
    this.#adapter = adapter;
    this.#databases = config.databases ?? (adapter as Mysql).databases;
  }

  protected override async getAllViewNames(): Promise<string[]> {
    const rows = await this.#adapter.runQuery<{ name: string }>(`
      SELECT DISTINCT CONCAT(TABLE_SCHEMA, '.', TABLE_NAME) AS name
      FROM INFORMATION_SCHEMA.VIEWS
      WHERE 1=1
        ${this.#buildDatabaseFilter('TABLE_SCHEMA')}
      ORDER BY name
    `);
    return rows.map((r) => r.name);
  }

  protected override async getView(viewName: string): Promise<View> {
    const { schema, table } = this.#adapter.parseTableName(viewName);
    const database = schema || (await this.#getCurrentDatabase());

    // Get columns
    const columns = await this.#adapter.runQuery<ColumnRow>(`
      SELECT COLUMN_NAME, DATA_TYPE
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = '${this.#adapter.escapeString(database)}'
        AND TABLE_NAME = '${this.#adapter.escapeString(table)}'
      ORDER BY ORDINAL_POSITION
    `);

    // Get view definition
    const viewRows = await this.#adapter.runQuery<ViewRow>(`
      SELECT VIEW_DEFINITION
      FROM INFORMATION_SCHEMA.VIEWS
      WHERE TABLE_SCHEMA = '${this.#adapter.escapeString(database)}'
        AND TABLE_NAME = '${this.#adapter.escapeString(table)}'
    `);

    return {
      name: viewName,
      schema: database,
      rawName: table,
      definition: viewRows[0]?.VIEW_DEFINITION ?? undefined,
      columns: columns.map((col) => ({
        name: col.COLUMN_NAME ?? 'unknown',
        type: col.DATA_TYPE ?? 'unknown',
      })),
    };
  }

  #buildDatabaseFilter(columnName: string): string {
    if (this.#databases && this.#databases.length > 0) {
      const values = this.#databases
        .map((db) => `'${this.#adapter.escapeString(db)}'`)
        .join(', ');
      return `AND ${columnName} IN (${values})`;
    }

    // Exclude system databases by default
    const systemDbs = this.#adapter.systemSchemas
      .map((db) => `'${this.#adapter.escapeString(db)}'`)
      .join(', ');
    return `AND ${columnName} NOT IN (${systemDbs})`;
  }

  async #getCurrentDatabase(): Promise<string> {
    const rows = await this.#adapter.runQuery<{ db: string | null }>(
      'SELECT DATABASE() AS db',
    );
    return rows[0]?.db ?? '';
  }
}
