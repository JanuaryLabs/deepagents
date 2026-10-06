import type { Adapter, TableIndex } from '../adapter.ts';
import {
  IndexesGrounding,
  type IndexesGroundingConfig,
} from '../groundings/indexes.grounding.ts';
import { indexInfoRow, indexListRow } from './sqlite-rows.ts';

/**
 * SQLite implementation of IndexesGrounding.
 */
export class SqliteIndexesGrounding extends IndexesGrounding {
  #adapter: Adapter;

  constructor(adapter: Adapter, config: IndexesGroundingConfig = {}) {
    super(config);
    this.#adapter = adapter;
  }

  protected override async getIndexes(
    tableName: string,
  ): Promise<TableIndex[]> {
    const indexListRows = await this.#adapter.runQuery(
      `PRAGMA index_list(${this.#quoteIdentifier(tableName)})`,
      indexListRow,
    );

    const indexes: TableIndex[] = [];

    for (const indexRow of indexListRows) {
      if (!indexRow.name) continue;

      const indexInfoRows = await this.#adapter.runQuery(
        `PRAGMA index_info(${this.#quoteIdentifier(indexRow.name)})`,
        indexInfoRow,
      );

      const columns = indexInfoRows
        .toSorted((a, b) => a.seqno - b.seqno)
        .flatMap((row) => (row.name === null ? [] : [row.name]));

      if (!columns.length) continue;

      indexes.push({
        name: indexRow.name,
        columns,
        unique: indexRow.unique === 1,
        type: indexRow.partial === 1 ? 'PARTIAL' : undefined,
      });
    }

    return indexes;
  }

  #quoteIdentifier(name: string): string {
    return `'${name.replace(/'/g, "''")}'`;
  }
}
