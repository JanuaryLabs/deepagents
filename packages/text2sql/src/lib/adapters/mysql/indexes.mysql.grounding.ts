import type { Adapter, TableIndex } from '../adapter.ts';
import {
  IndexesGrounding,
  type IndexesGroundingConfig,
} from '../groundings/indexes.grounding.ts';

type IndexRow = {
  INDEX_NAME: string | null;
  COLUMN_NAME: string | null;
  NON_UNIQUE: number | null;
  INDEX_TYPE: string | null;
  SEQ_IN_INDEX: number | null;
};

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

    const rows = await this.#adapter.runQuery<IndexRow>(`
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
    `);

    const indexMap = new Map<string, TableIndex>();

    for (const row of rows) {
      if (!row.INDEX_NAME) continue;

      let index = indexMap.get(row.INDEX_NAME);
      if (!index) {
        index = {
          name: row.INDEX_NAME,
          columns: [],
          unique: row.NON_UNIQUE === 0,
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
    const rows = await this.#adapter.runQuery<{ db: string | null }>(
      'SELECT DATABASE() AS db',
    );
    return rows[0]?.db ?? '';
  }
}
