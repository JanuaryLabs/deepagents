import { z } from 'zod';

import type { Relationship, Table } from '../adapter.ts';
import { nameRow } from '../groundings/rows.ts';
import {
  TableGrounding,
  type TableGroundingConfig,
} from '../groundings/table.grounding.ts';
import { columnRow } from './sqlserver-rows.ts';
import type { SqlServer } from './sqlserver.ts';

/** One column pair of a foreign key, read from sys.foreign_key_columns. */
const relationshipRow = z.object({
  constraint_name: z.string(),
  table_schema: z.string(),
  table_name: z.string(),
  column_name: z.string(),
  referenced_table_schema: z.string(),
  referenced_table_name: z.string(),
  referenced_column_name: z.string(),
});

export interface SqlServerTableGroundingConfig extends TableGroundingConfig {
  /** Schemas to include (defaults to the adapter's schemas option) */
  schemas?: string[];
}

/**
 * SQL Server implementation of TableGrounding.
 *
 * SQL Server can query incoming relationships directly via sys.foreign_keys,
 * so no caching is needed like SQLite.
 */
export class SqlServerTableGrounding extends TableGrounding {
  #adapter: SqlServer;
  #schemas?: string[];

  constructor(adapter: SqlServer, config: SqlServerTableGroundingConfig = {}) {
    super(config);
    this.#adapter = adapter;
    this.#schemas = config.schemas ?? adapter.schemas;
  }

  protected override async getAllTableNames(): Promise<string[]> {
    const rows = await this.#adapter.runQuery(
      `
      SELECT TABLE_SCHEMA + '.' + TABLE_NAME AS name
      FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_TYPE = 'BASE TABLE'
        ${this.#adapter.buildSchemaFilter('TABLE_SCHEMA', this.#schemas)}
      ORDER BY name
    `,
      nameRow,
    );
    return rows.map((r) => r.name);
  }

  protected override async getTable(tableName: string): Promise<Table> {
    const { schema, table } = this.#adapter.parseTableName(tableName);

    const columns = await this.#adapter.runQuery(
      `
      SELECT COLUMN_NAME AS column_name, DATA_TYPE AS data_type
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = '${this.#adapter.escapeString(schema)}'
        AND TABLE_NAME = '${this.#adapter.escapeString(table)}'
      ORDER BY ORDINAL_POSITION
    `,
      columnRow,
    );

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
    return this.#foreignKeys(
      `s.name = '${this.#adapter.escapeString(schema)}'
        AND t.name = '${this.#adapter.escapeString(table)}'`,
    );
  }

  protected override async findIncomingRelations(
    tableName: string,
  ): Promise<Relationship[]> {
    const { schema, table } = this.#adapter.parseTableName(tableName);
    return this.#foreignKeys(
      `ref_s.name = '${this.#adapter.escapeString(schema)}'
        AND ref_t.name = '${this.#adapter.escapeString(table)}'`,
    );
  }

  /**
   * The foreign keys matching `where`. sys.foreign_key_columns holds one row
   * per column pair in the key's own order, and every join goes by object id,
   * so a key comes back whole even when it references a unique index or
   * another schema repeats its constraint names.
   */
  async #foreignKeys(where: string): Promise<Relationship[]> {
    const rows = await this.#adapter.runQuery(
      `
      SELECT
        fk.name AS constraint_name,
        s.name AS table_schema,
        t.name AS table_name,
        COL_NAME(fkc.parent_object_id, fkc.parent_column_id) AS column_name,
        ref_s.name AS referenced_table_schema,
        ref_t.name AS referenced_table_name,
        COL_NAME(fkc.referenced_object_id, fkc.referenced_column_id) AS referenced_column_name
      FROM sys.foreign_keys AS fk
      JOIN sys.foreign_key_columns AS fkc ON fkc.constraint_object_id = fk.object_id
      JOIN sys.tables AS t ON t.object_id = fk.parent_object_id
      JOIN sys.schemas AS s ON s.schema_id = t.schema_id
      JOIN sys.tables AS ref_t ON ref_t.object_id = fk.referenced_object_id
      JOIN sys.schemas AS ref_s ON ref_s.schema_id = ref_t.schema_id
      WHERE ${where}
      ORDER BY s.name, t.name, fk.name, fkc.constraint_column_id
    `,
      relationshipRow,
    );

    const relationships = new Map<string, Relationship>();
    for (const row of rows) {
      const table = `${row.table_schema}.${row.table_name}`;
      const key = `${table}:${row.constraint_name}`;
      const relationship = relationships.get(key) ?? {
        table,
        from: [],
        referenced_table: `${row.referenced_table_schema}.${row.referenced_table_name}`,
        to: [],
      };
      relationship.from.push(row.column_name);
      relationship.to.push(row.referenced_column_name);
      relationships.set(key, relationship);
    }
    return Array.from(relationships.values());
  }
}
