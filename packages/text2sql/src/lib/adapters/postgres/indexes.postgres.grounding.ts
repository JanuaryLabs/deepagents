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
  column_position: number;
};

export interface PostgresIndexesGroundingConfig extends IndexesGroundingConfig {
  /** Schemas to include (defaults to excluding pg_catalog and information_schema) */
  schemas?: string[];
}

/**
 * PostgreSQL implementation of IndexesGrounding.
 */
export class PostgresIndexesGrounding extends IndexesGrounding {
  #adapter: Adapter;
  #schemas?: string[];

  constructor(adapter: Adapter, config: PostgresIndexesGroundingConfig = {}) {
    super(config);
    this.#adapter = adapter;
    this.#schemas = config.schemas;
  }

  protected override async getIndexes(tableName: string): Promise<TableIndex[]> {
    const { schema, table } = this.#adapter.parseTableName(tableName);

    const rows = await this.#adapter.runQuery<IndexRow>(`
      SELECT
        i.relname AS index_name,
        a.attname AS column_name,
        ix.indisunique AS is_unique,
        am.amname AS index_type,
        array_position(ix.indkey, a.attnum) AS column_position
      FROM pg_index ix
      JOIN pg_class i ON i.oid = ix.indexrelid
      JOIN pg_class t ON t.oid = ix.indrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey)
      JOIN pg_am am ON am.oid = i.relam
      WHERE n.nspname = '${this.#adapter.escapeString(schema)}'
        AND t.relname = '${this.#adapter.escapeString(table)}'
      ORDER BY i.relname, array_position(ix.indkey, a.attnum)
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
          type: row.index_type?.toUpperCase(),
        });
      }
    }

    return Array.from(indexes.values());
  }
}
