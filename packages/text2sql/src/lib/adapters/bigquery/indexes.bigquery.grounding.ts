import type { Table, TableIndex } from '../adapter.ts';
import type { GroundingContext } from '../groundings/context.ts';
import {
  IndexesGrounding,
  type IndexesGroundingConfig,
} from '../groundings/indexes.grounding.ts';
import type { BigQuery } from './bigquery.ts';

type IndexHintRow = {
  table_name: string | null;
  column_name: string | null;
  is_partitioning_column: string | null;
  clustering_ordinal_position: number | null;
};

export interface BigQueryIndexesGroundingConfig extends IndexesGroundingConfig {}

export class BigQueryIndexesGrounding extends IndexesGrounding {
  #adapter: BigQuery;

  constructor(adapter: BigQuery, config: BigQueryIndexesGroundingConfig = {}) {
    super(config);
    this.#adapter = adapter;
  }

  override async execute(ctx: GroundingContext): Promise<void> {
    const byDataset = new Map<string, Table[]>();
    for (const table of ctx.tables) {
      const { schema: dataset } = this.#adapter.parseTableName(table.name);
      const list = byDataset.get(dataset) ?? [];
      list.push(table);
      byDataset.set(dataset, list);
    }

    for (const [dataset, tables] of byDataset) {
      try {
        await this.#batchIndexes(dataset, tables);
      } catch {
        // Skip silently — indexes are non-critical
      }
    }
  }

  async #batchIndexes(dataset: string, tables: Table[]): Promise<void> {
    const tableNames = tables.map(
      (t) => this.#adapter.parseTableName(t.name).table,
    );
    const inList = tableNames
      .map((n) => `'${this.#adapter.escapeString(n)}'`)
      .join(', ');

    const rows = await this.#adapter.runQuery<IndexHintRow>(`
      SELECT table_name, column_name, is_partitioning_column, clustering_ordinal_position
      FROM ${this.#adapter.infoSchemaView(dataset, 'COLUMNS')}
      WHERE table_name IN (${inList})
        AND (is_partitioning_column = 'YES' OR clustering_ordinal_position IS NOT NULL)
      ORDER BY table_name, clustering_ordinal_position
    `);

    const byTable = new Map<
      string,
      {
        partition: string[];
        clustering: Array<{ name: string; pos: number }>;
      }
    >();

    for (const row of rows) {
      if (!row.table_name || !row.column_name) continue;
      const entry = byTable.get(row.table_name) ?? {
        partition: [],
        clustering: [],
      };

      if ((row.is_partitioning_column ?? '').toUpperCase() === 'YES') {
        entry.partition.push(row.column_name);
      }
      if (row.clustering_ordinal_position != null) {
        entry.clustering.push({
          name: row.column_name,
          pos: row.clustering_ordinal_position,
        });
      }

      byTable.set(row.table_name, entry);
    }

    for (const table of tables) {
      const rawName = this.#adapter.parseTableName(table.name).table;
      const entry = byTable.get(rawName);
      if (!entry) continue;

      const indexes: TableIndex[] = [];

      if (entry.partition.length > 0) {
        indexes.push({
          name: `${rawName}_partition`,
          columns: entry.partition,
          type: 'PARTITION',
        });
      }

      if (entry.clustering.length > 0) {
        entry.clustering.sort((a, b) => a.pos - b.pos);
        indexes.push({
          name: `${rawName}_clustering`,
          columns: entry.clustering.map((c) => c.name),
          type: 'CLUSTERING',
        });
      }

      table.indexes = indexes;
      for (const idx of indexes) {
        for (const colName of idx.columns) {
          const column = table.columns.find((c) => c.name === colName);
          if (column) column.isIndexed = true;
        }
      }
    }
  }

  protected override async getIndexes(
    _tableName: string,
  ): Promise<TableIndex[]> {
    return [];
  }
}
