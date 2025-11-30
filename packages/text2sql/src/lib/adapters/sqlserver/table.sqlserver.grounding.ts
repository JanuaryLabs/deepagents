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
  constraint_name: string | null;
  table_schema: string | null;
  table_name: string | null;
  column_name: string | null;
  referenced_table_schema: string | null;
  referenced_table_name: string | null;
  referenced_column_name: string | null;
};

export interface SqlServerTableGroundingConfig extends TableGroundingConfig {
  /** Schemas to include (defaults to excluding INFORMATION_SCHEMA and sys) */
  schemas?: string[];
}

/**
 * SQL Server implementation of TableGrounding.
 *
 * SQL Server can query incoming relationships directly via INFORMATION_SCHEMA,
 * so no caching is needed like SQLite.
 */
export class SqlServerTableGrounding extends TableGrounding {
  #adapter: Adapter;
  #schemas?: string[];

  constructor(adapter: Adapter, config: SqlServerTableGroundingConfig = {}) {
    super(config);
    this.#adapter = adapter;
    this.#schemas = config.schemas;
  }

  protected override async getAllTableNames(): Promise<string[]> {
    const rows = await this.#adapter.runQuery<{ name: string }>(`
      SELECT TABLE_SCHEMA + '.' + TABLE_NAME AS name
      FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_TYPE = 'BASE TABLE'
        ${this.#adapter.buildSchemaFilter('TABLE_SCHEMA', this.#schemas)}
      ORDER BY name
    `);
    return rows.map((r) => r.name);
  }

  protected override async getTable(tableName: string): Promise<Table> {
    const { schema, table } = this.#adapter.parseTableName(tableName);

    const columns = await this.#adapter.runQuery<ColumnRow>(`
      SELECT COLUMN_NAME AS column_name, DATA_TYPE AS data_type
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = '${this.#adapter.escapeString(schema)}'
        AND TABLE_NAME = '${this.#adapter.escapeString(table)}'
      ORDER BY ORDINAL_POSITION
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
        fk.CONSTRAINT_NAME AS constraint_name,
        fk.TABLE_SCHEMA AS table_schema,
        fk.TABLE_NAME AS table_name,
        fk.COLUMN_NAME AS column_name,
        pk.TABLE_SCHEMA AS referenced_table_schema,
        pk.TABLE_NAME AS referenced_table_name,
        pk.COLUMN_NAME AS referenced_column_name
      FROM INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS AS rc
      JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE AS fk
        ON fk.CONSTRAINT_NAME = rc.CONSTRAINT_NAME
      JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE AS pk
        ON pk.CONSTRAINT_NAME = rc.UNIQUE_CONSTRAINT_NAME
        AND pk.ORDINAL_POSITION = fk.ORDINAL_POSITION
      WHERE fk.TABLE_SCHEMA = '${this.#adapter.escapeString(schema)}'
        AND fk.TABLE_NAME = '${this.#adapter.escapeString(table)}'
      ORDER BY fk.CONSTRAINT_NAME, fk.ORDINAL_POSITION
    `);

    return this.#groupRelationships(rows);
  }

  protected override async findIncomingRelations(
    tableName: string,
  ): Promise<Relationship[]> {
    const { schema, table } = this.#adapter.parseTableName(tableName);

    // SQL Server can query incoming relations directly - no cache needed
    const rows = await this.#adapter.runQuery<RelationshipRow>(`
      SELECT
        fk.CONSTRAINT_NAME AS constraint_name,
        fk.TABLE_SCHEMA AS table_schema,
        fk.TABLE_NAME AS table_name,
        fk.COLUMN_NAME AS column_name,
        pk.TABLE_SCHEMA AS referenced_table_schema,
        pk.TABLE_NAME AS referenced_table_name,
        pk.COLUMN_NAME AS referenced_column_name
      FROM INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS AS rc
      JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE AS fk
        ON fk.CONSTRAINT_NAME = rc.CONSTRAINT_NAME
      JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE AS pk
        ON pk.CONSTRAINT_NAME = rc.UNIQUE_CONSTRAINT_NAME
        AND pk.ORDINAL_POSITION = fk.ORDINAL_POSITION
      WHERE pk.TABLE_SCHEMA = '${this.#adapter.escapeString(schema)}'
        AND pk.TABLE_NAME = '${this.#adapter.escapeString(table)}'
      ORDER BY fk.CONSTRAINT_NAME, fk.ORDINAL_POSITION
    `);

    return this.#groupRelationships(rows);
  }

  #groupRelationships(rows: RelationshipRow[]): Relationship[] {
    const relationships = new Map<string, Relationship>();
    const defaultSchema = this.#adapter.defaultSchema ?? 'dbo';

    for (const row of rows) {
      if (
        !row.constraint_name ||
        !row.table_name ||
        !row.referenced_table_name
      ) {
        continue;
      }

      const schema = row.table_schema ?? defaultSchema;
      const referencedSchema = row.referenced_table_schema ?? defaultSchema;
      const key = `${schema}.${row.table_name}:${row.constraint_name}`;

      const relationship = relationships.get(key) ?? {
        table: `${schema}.${row.table_name}`,
        from: [],
        referenced_table: `${referencedSchema}.${row.referenced_table_name}`,
        to: [],
      };

      relationship.from.push(row.column_name ?? 'unknown');
      relationship.to.push(row.referenced_column_name ?? 'unknown');

      relationships.set(key, relationship);
    }

    return Array.from(relationships.values());
  }
}
