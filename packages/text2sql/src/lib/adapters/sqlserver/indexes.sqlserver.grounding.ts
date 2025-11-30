import type { Adapter, TableIndex } from '../adapter.ts';
import {
  IndexesGrounding,
  type IndexesGroundingConfig,
} from '../groundings/indexes.grounding.ts';

type IndexRow = {
  index_name: string;
  column_name: string;
  is_unique: boolean;
  index_type: string;
  key_ordinal: number;
};

export interface SqlServerIndexesGroundingConfig extends IndexesGroundingConfig {
  /** Schemas to include (defaults to excluding INFORMATION_SCHEMA and sys) */
  schemas?: string[];
}

/**
 * SQL Server implementation of IndexesGrounding.
 */
export class SqlServerIndexesGrounding extends IndexesGrounding {
  #adapter: Adapter;
  #schemas?: string[];

  constructor(adapter: Adapter, config: SqlServerIndexesGroundingConfig = {}) {
    super(config);
    this.#adapter = adapter;
    this.#schemas = config.schemas;
  }

  protected override async getIndexes(tableName: string): Promise<TableIndex[]> {
    const { schema, table } = this.#adapter.parseTableName(tableName);

    const rows = await this.#adapter.runQuery<IndexRow>(`
      SELECT
        i.name AS index_name,
        COL_NAME(ic.object_id, ic.column_id) AS column_name,
        i.is_unique,
        i.type_desc AS index_type,
        ic.key_ordinal
      FROM sys.indexes i
      JOIN sys.index_columns ic
        ON i.object_id = ic.object_id
        AND i.index_id = ic.index_id
      JOIN sys.tables t
        ON i.object_id = t.object_id
      JOIN sys.schemas s
        ON t.schema_id = s.schema_id
      WHERE s.name = '${this.#adapter.escapeString(schema)}'
        AND t.name = '${this.#adapter.escapeString(table)}'
        AND i.name IS NOT NULL
        AND ic.is_included_column = 0
      ORDER BY i.name, ic.key_ordinal
    `);

    return this.#groupIndexes(rows);
  }

  #groupIndexes(rows: IndexRow[]): TableIndex[] {
    const indexes = new Map<string, TableIndex>();

    for (const row of rows) {
      if (!row.index_name || !row.column_name) continue;

      const existing = indexes.get(row.index_name);
      if (existing) {
        existing.columns.push(row.column_name);
      } else {
        indexes.set(row.index_name, {
          name: row.index_name,
          columns: [row.column_name],
          unique: row.is_unique,
          type: row.index_type,
        });
      }
    }

    return Array.from(indexes.values());
  }
}
