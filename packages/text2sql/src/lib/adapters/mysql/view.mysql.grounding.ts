import { z } from 'zod';

import { nameRow } from '../groundings/rows.ts';
import {
  type View,
  ViewGrounding,
  type ViewGroundingConfig,
} from '../groundings/view.grounding.ts';
import { columnRow, currentDatabaseRow } from './mysql-rows.ts';
import type { Mysql } from './mysql.ts';

const viewDefinitionRow = z.object({ VIEW_DEFINITION: z.string().nullable() });

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
  #adapter: Mysql;
  #databases?: string[];

  constructor(adapter: Mysql, config: MysqlViewGroundingConfig = {}) {
    super(config);
    this.#adapter = adapter;
    this.#databases = config.databases ?? adapter.databases;
  }

  protected override async getAllViewNames(): Promise<string[]> {
    const rows = await this.#adapter.runQuery(
      `
      SELECT DISTINCT CONCAT(TABLE_SCHEMA, '.', TABLE_NAME) AS name
      FROM INFORMATION_SCHEMA.VIEWS
      WHERE 1=1
        ${this.#buildDatabaseFilter('TABLE_SCHEMA')}
      ORDER BY name
    `,
      nameRow,
    );
    return rows.map((r) => r.name);
  }

  protected override async getView(viewName: string): Promise<View> {
    const { schema, table } = this.#adapter.parseTableName(viewName);
    const database = schema || (await this.#getCurrentDatabase());

    const columns = await this.#adapter.runQuery(
      `
      SELECT COLUMN_NAME, DATA_TYPE
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = '${this.#adapter.escapeString(database)}'
        AND TABLE_NAME = '${this.#adapter.escapeString(table)}'
      ORDER BY ORDINAL_POSITION
    `,
      columnRow,
    );

    let definition: string | undefined;
    if (this.includeDefinition) {
      const viewRows = await this.#adapter.runQuery(
        `
        SELECT VIEW_DEFINITION
        FROM INFORMATION_SCHEMA.VIEWS
        WHERE TABLE_SCHEMA = '${this.#adapter.escapeString(database)}'
          AND TABLE_NAME = '${this.#adapter.escapeString(table)}'
      `,
        viewDefinitionRow,
      );
      definition = viewRows[0]?.VIEW_DEFINITION ?? undefined;
    }

    return {
      name: viewName,
      schema: database,
      rawName: table,
      definition,
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
    const rows = await this.#adapter.runQuery(
      'SELECT DATABASE() AS db',
      currentDatabaseRow,
    );
    return rows[0]?.db ?? '';
  }
}
