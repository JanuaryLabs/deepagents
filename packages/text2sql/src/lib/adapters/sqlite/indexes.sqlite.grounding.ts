import type { Adapter, TableIndex } from '../adapter.ts';
import {
  IndexesGrounding,
  type IndexesGroundingConfig,
} from '../groundings/indexes.grounding.ts';

type IndexListRow = {
  seq: number;
  name: string;
  unique: number;
  origin: string; // 'c' = CREATE INDEX, 'pk' = PRIMARY KEY, 'u' = UNIQUE constraint
  partial: number;
};

type IndexInfoRow = {
  seqno: number;
  cid: number;
  name: string | null;
};

/**
 * SQLite implementation of IndexesGrounding.
 */
export class SqliteIndexesGrounding extends IndexesGrounding {
  #adapter: Adapter;

  constructor(adapter: Adapter, config: IndexesGroundingConfig = {}) {
    super(config);
    this.#adapter = adapter;
  }

  protected override async getIndexes(tableName: string): Promise<TableIndex[]> {
    const indexListRows = await this.#adapter.runQuery<IndexListRow>(
      `PRAGMA index_list(${this.#quoteIdentifier(tableName)})`,
    );

    const indexes: TableIndex[] = [];

    for (const indexRow of indexListRows) {
      if (!indexRow.name) continue;

      const indexInfoRows = await this.#adapter.runQuery<IndexInfoRow>(
        `PRAGMA index_info(${this.#quoteIdentifier(indexRow.name)})`,
      );

      const columns = indexInfoRows
        .filter((row) => row.name != null)
        .sort((a, b) => a.seqno - b.seqno)
        .map((row) => row.name as string);

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
