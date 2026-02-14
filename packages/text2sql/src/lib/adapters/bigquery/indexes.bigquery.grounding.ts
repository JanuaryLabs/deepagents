import type { Adapter, TableIndex } from '../adapter.ts';
import {
  IndexesGrounding,
  type IndexesGroundingConfig,
} from '../groundings/indexes.grounding.ts';
import type { BigQuery } from './bigquery.ts';

type IndexHintRow = {
  column_name: string | null;
  is_partitioning_column: string | null;
  clustering_ordinal_position: number | null;
};

export interface BigQueryIndexesGroundingConfig extends IndexesGroundingConfig {}

/**
 * BigQuery doesn't have traditional indexes; we map partitioning and clustering
 * metadata into index-like hints to guide query planning.
 */
export class BigQueryIndexesGrounding extends IndexesGrounding {
  #adapter: BigQuery;

  constructor(adapter: Adapter, config: BigQueryIndexesGroundingConfig = {}) {
    super(config);
    this.#adapter = adapter as BigQuery;
  }

  protected override async getIndexes(
    tableName: string,
  ): Promise<TableIndex[]> {
    const { schema: dataset, table } = this.#adapter.parseTableName(tableName);

    const rows = await this.#adapter.runQuery<IndexHintRow>(`
      SELECT column_name, is_partitioning_column, clustering_ordinal_position
      FROM ${this.#adapter.infoSchemaView(dataset, 'COLUMNS')}
      WHERE table_name = '${this.#adapter.escapeString(table)}'
        AND (is_partitioning_column = 'YES' OR clustering_ordinal_position IS NOT NULL)
      ORDER BY clustering_ordinal_position
    `);

    const partitionColumns: string[] = [];
    const clusteringColumns: Array<{ name: string; pos: number }> = [];

    for (const row of rows) {
      if (!row.column_name) continue;

      if ((row.is_partitioning_column ?? '').toUpperCase() === 'YES') {
        partitionColumns.push(row.column_name);
      }

      if (row.clustering_ordinal_position != null) {
        clusteringColumns.push({
          name: row.column_name,
          pos: row.clustering_ordinal_position,
        });
      }
    }

    const indexes: TableIndex[] = [];

    if (partitionColumns.length > 0) {
      indexes.push({
        name: `${table}_partition`,
        columns: partitionColumns,
        type: 'PARTITION',
      });
    }

    if (clusteringColumns.length > 0) {
      clusteringColumns.sort((a, b) => a.pos - b.pos);
      indexes.push({
        name: `${table}_clustering`,
        columns: clusteringColumns.map((c) => c.name),
        type: 'CLUSTERING',
      });
    }

    return indexes;
  }
}
