import { z } from 'zod';

import type { Adapter, TableIndex } from '../adapter.ts';
import {
  IndexesGrounding,
  type IndexesGroundingConfig,
} from '../groundings/indexes.grounding.ts';
import { numericValue } from '../groundings/rows.ts';
import { currentDatabaseRow } from './mysql-rows.ts';

/**
 * INFORMATION_SCHEMA.STATISTICS. NON_UNIQUE and SEQ_IN_INDEX are INT on MySQL
 * but BIGINT on MariaDB, so they arrive as numbers, bigints (mariadb
 * connector) or strings (mysql2 bigNumberStrings, the mysql CLI). COLUMN_NAME
 * is NULL for a functional key part.
 */
const indexRow = z.object({
  INDEX_NAME: z.string().nullable(),
  COLUMN_NAME: z.string().nullable(),
  NON_UNIQUE: numericValue.nullable(),
  INDEX_TYPE: z.string().nullable(),
  SEQ_IN_INDEX: numericValue.nullable(),
});

/**
 * MySQL/MariaDB implementation of IndexesGrounding.
 *
 * Uses INFORMATION_SCHEMA.STATISTICS for index metadata.
 */
export class MysqlIndexesGrounding extends IndexesGrounding {
  #adapter: Adapter;

  constructor(adapter: Adapter, config: IndexesGroundingConfig = {}) {
    super(config);
    this.#adapter = adapter;
  }

  protected override async getIndexes(
    tableName: string,
  ): Promise<TableIndex[]> {
    const { schema, table } = this.#adapter.parseTableName(tableName);
    const database = schema || (await this.#getCurrentDatabase());

    const rows = await this.#adapter.runQuery(
      `
      SELECT
        INDEX_NAME,
        COLUMN_NAME,
        NON_UNIQUE,
        INDEX_TYPE,
        SEQ_IN_INDEX
      FROM INFORMATION_SCHEMA.STATISTICS
      WHERE TABLE_SCHEMA = '${this.#adapter.escapeString(database)}'
        AND TABLE_NAME = '${this.#adapter.escapeString(table)}'
      ORDER BY INDEX_NAME, SEQ_IN_INDEX
    `,
      indexRow,
    );

    const indexMap = new Map<string, TableIndex>();

    for (const row of rows) {
      if (!row.INDEX_NAME) continue;

      let index = indexMap.get(row.INDEX_NAME);
      if (!index) {
        index = {
          name: row.INDEX_NAME,
          columns: [],
          unique: this.#adapter.toNumber(row.NON_UNIQUE) === 0,
          type: row.INDEX_TYPE ?? undefined,
        };
        indexMap.set(row.INDEX_NAME, index);
      }

      if (row.COLUMN_NAME) {
        index.columns.push(row.COLUMN_NAME);
      }
    }

    return Array.from(indexMap.values());
  }

  async #getCurrentDatabase(): Promise<string> {
    const rows = await this.#adapter.runQuery(
      'SELECT DATABASE() AS db',
      currentDatabaseRow,
    );
    return rows[0]?.db ?? '';
  }
}
