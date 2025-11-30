import type { Adapter, Relationship, Table } from '../adapter.ts';
import {
  TableGrounding,
  type TableGroundingConfig,
} from '../groundings/table.grounding.ts';

type ColumnRow = {
  column_name: string | null;
  data_type: string | null;
};

type RelationshipRow = {
  table_schema: string | null;
  table_name: string | null;
  column_name: string | null;
  foreign_table_schema: string | null;
  foreign_table_name: string | null;
  foreign_column_name: string | null;
  constraint_name: string | null;
};

export interface PostgresTableGroundingConfig extends TableGroundingConfig {
  /** Schemas to include (defaults to excluding pg_catalog and information_schema) */
  schemas?: string[];
}

/**
 * PostgreSQL implementation of TableGrounding.
 *
 * PostgreSQL can query incoming relationships directly via information_schema,
 * so no caching is needed like SQLite.
 */
export class PostgresTableGrounding extends TableGrounding {
  #adapter: Adapter;
  #schemas?: string[];

  constructor(adapter: Adapter, config: PostgresTableGroundingConfig = {}) {
    super(config);
    this.#adapter = adapter;
    this.#schemas = config.schemas;
  }

  protected override async getAllTableNames(): Promise<string[]> {
    const rows = await this.#adapter.runQuery<{ name: string }>(`
      SELECT DISTINCT table_schema || '.' || table_name AS name
      FROM information_schema.tables
      WHERE table_type = 'BASE TABLE'
        ${this.#adapter.buildSchemaFilter('table_schema', this.#schemas)}
      ORDER BY name
    `);
    return rows.map((r) => r.name);
  }

  protected override async getTable(tableName: string): Promise<Table> {
    const { schema, table } = this.#adapter.parseTableName(tableName);

    const columns = await this.#adapter.runQuery<ColumnRow>(`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_schema = '${this.#adapter.escapeString(schema)}'
        AND table_name = '${this.#adapter.escapeString(table)}'
      ORDER BY ordinal_position
    `);

    return {
      name: tableName,
      schema,
      rawName: table,
      columns: columns.map((col) => ({
        name: col.column_name ?? 'unknown',
        type: col.data_type ?? 'unknown',
      })),
    };
  }

  protected override async findOutgoingRelations(
    tableName: string,
  ): Promise<Relationship[]> {
    const { schema, table } = this.#adapter.parseTableName(tableName);

    const rows = await this.#adapter.runQuery<RelationshipRow>(`
      SELECT
        tc.constraint_name,
        tc.table_schema,
        tc.table_name,
        kcu.column_name,
        ccu.table_schema AS foreign_table_schema,
        ccu.table_name AS foreign_table_name,
        ccu.column_name AS foreign_column_name
      FROM information_schema.table_constraints AS tc
      JOIN information_schema.key_column_usage AS kcu
        ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
      JOIN information_schema.constraint_column_usage AS ccu
        ON ccu.constraint_name = tc.constraint_name
        AND ccu.table_schema = tc.table_schema
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND tc.table_schema = '${this.#adapter.escapeString(schema)}'
        AND tc.table_name = '${this.#adapter.escapeString(table)}'
      ORDER BY tc.constraint_name, kcu.ordinal_position
    `);

    return this.#groupRelationships(rows);
  }

  protected override async findIncomingRelations(
    tableName: string,
  ): Promise<Relationship[]> {
    const { schema, table } = this.#adapter.parseTableName(tableName);

    // PostgreSQL can query incoming relations directly - no cache needed
    const rows = await this.#adapter.runQuery<RelationshipRow>(`
      SELECT
        tc.constraint_name,
        tc.table_schema,
        tc.table_name,
        kcu.column_name,
        ccu.table_schema AS foreign_table_schema,
        ccu.table_name AS foreign_table_name,
        ccu.column_name AS foreign_column_name
      FROM information_schema.table_constraints AS tc
      JOIN information_schema.key_column_usage AS kcu
        ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
      JOIN information_schema.constraint_column_usage AS ccu
        ON ccu.constraint_name = tc.constraint_name
        AND ccu.table_schema = tc.table_schema
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND ccu.table_schema = '${this.#adapter.escapeString(schema)}'
        AND ccu.table_name = '${this.#adapter.escapeString(table)}'
      ORDER BY tc.constraint_name, kcu.ordinal_position
    `);

    return this.#groupRelationships(rows);
  }

  #groupRelationships(rows: RelationshipRow[]): Relationship[] {
    const relationships = new Map<string, Relationship>();
    const defaultSchema = this.#adapter.defaultSchema ?? 'public';

    for (const row of rows) {
      if (!row.table_name || !row.foreign_table_name || !row.constraint_name) {
        continue;
      }

      const schema = row.table_schema ?? defaultSchema;
      const referencedSchema = row.foreign_table_schema ?? defaultSchema;
      const key = `${schema}.${row.table_name}:${row.constraint_name}`;

      const relationship = relationships.get(key) ?? {
        table: `${schema}.${row.table_name}`,
        from: [],
        referenced_table: `${referencedSchema}.${row.foreign_table_name}`,
        to: [],
      };

      relationship.from.push(row.column_name ?? 'unknown');
      relationship.to.push(row.foreign_column_name ?? 'unknown');

      relationships.set(key, relationship);
    }

    return Array.from(relationships.values());
  }
}
