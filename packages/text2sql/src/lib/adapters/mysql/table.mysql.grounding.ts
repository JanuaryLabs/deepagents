import type { Adapter, Relationship, Table } from '../adapter.ts';
import {
  TableGrounding,
  type TableGroundingConfig,
} from '../groundings/table.grounding.ts';
import type { Mysql } from './mysql.ts';

type ColumnRow = {
  COLUMN_NAME: string | null;
  DATA_TYPE: string | null;
  COLUMN_TYPE: string | null;
};

type RelationshipRow = {
  TABLE_SCHEMA: string | null;
  TABLE_NAME: string | null;
  COLUMN_NAME: string | null;
  REFERENCED_TABLE_SCHEMA: string | null;
  REFERENCED_TABLE_NAME: string | null;
  REFERENCED_COLUMN_NAME: string | null;
  CONSTRAINT_NAME: string | null;
};

export interface MysqlTableGroundingConfig extends TableGroundingConfig {
  /** Databases to include (defaults to excluding system databases) */
  databases?: string[];
}

/**
 * MySQL/MariaDB implementation of TableGrounding.
 *
 * Uses INFORMATION_SCHEMA for introspection which is compatible
 * with both MySQL and MariaDB.
 */
export class MysqlTableGrounding extends TableGrounding {
  #adapter: Adapter;
  #databases?: string[];

  constructor(adapter: Adapter, config: MysqlTableGroundingConfig = {}) {
    super(config);
    this.#adapter = adapter;
    this.#databases = config.databases ?? (adapter as Mysql).databases;
  }

  protected override async getAllTableNames(): Promise<string[]> {
    const rows = await this.#adapter.runQuery<{ name: string }>(`
      SELECT DISTINCT CONCAT(TABLE_SCHEMA, '.', TABLE_NAME) AS name
      FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_TYPE = 'BASE TABLE'
        ${this.#buildDatabaseFilter('TABLE_SCHEMA')}
      ORDER BY name
    `);
    return rows.map((r) => r.name);
  }

  protected override async getTable(tableName: string): Promise<Table> {
    const { schema, table } = this.#adapter.parseTableName(tableName);
    const database = schema || (await this.#getCurrentDatabase());

    const columns = await this.#adapter.runQuery<ColumnRow>(`
      SELECT COLUMN_NAME, DATA_TYPE, COLUMN_TYPE
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = '${this.#adapter.escapeString(database)}'
        AND TABLE_NAME = '${this.#adapter.escapeString(table)}'
      ORDER BY ORDINAL_POSITION
    `);

    return {
      name: tableName,
      schema: database,
      rawName: table,
      columns: columns.map((col) => ({
        name: col.COLUMN_NAME ?? 'unknown',
        type: col.DATA_TYPE ?? 'unknown',
      })),
    };
  }

  protected override async findOutgoingRelations(
    tableName: string,
  ): Promise<Relationship[]> {
    const { schema, table } = this.#adapter.parseTableName(tableName);
    const database = schema || (await this.#getCurrentDatabase());

    const rows = await this.#adapter.runQuery<RelationshipRow>(`
      SELECT
        kcu.CONSTRAINT_NAME,
        kcu.TABLE_SCHEMA,
        kcu.TABLE_NAME,
        kcu.COLUMN_NAME,
        kcu.REFERENCED_TABLE_SCHEMA,
        kcu.REFERENCED_TABLE_NAME,
        kcu.REFERENCED_COLUMN_NAME
      FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
      WHERE kcu.TABLE_SCHEMA = '${this.#adapter.escapeString(database)}'
        AND kcu.TABLE_NAME = '${this.#adapter.escapeString(table)}'
        AND kcu.REFERENCED_TABLE_NAME IS NOT NULL
      ORDER BY kcu.CONSTRAINT_NAME, kcu.ORDINAL_POSITION
    `);

    return this.#groupRelationships(rows);
  }

  protected override async findIncomingRelations(
    tableName: string,
  ): Promise<Relationship[]> {
    const { schema, table } = this.#adapter.parseTableName(tableName);
    const database = schema || (await this.#getCurrentDatabase());

    const rows = await this.#adapter.runQuery<RelationshipRow>(`
      SELECT
        kcu.CONSTRAINT_NAME,
        kcu.TABLE_SCHEMA,
        kcu.TABLE_NAME,
        kcu.COLUMN_NAME,
        kcu.REFERENCED_TABLE_SCHEMA,
        kcu.REFERENCED_TABLE_NAME,
        kcu.REFERENCED_COLUMN_NAME
      FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
      WHERE kcu.REFERENCED_TABLE_SCHEMA = '${this.#adapter.escapeString(database)}'
        AND kcu.REFERENCED_TABLE_NAME = '${this.#adapter.escapeString(table)}'
      ORDER BY kcu.CONSTRAINT_NAME, kcu.ORDINAL_POSITION
    `);

    return this.#groupRelationships(rows);
  }

  #groupRelationships(rows: RelationshipRow[]): Relationship[] {
    const relationships = new Map<string, Relationship>();

    for (const row of rows) {
      if (
        !row.TABLE_NAME ||
        !row.REFERENCED_TABLE_NAME ||
        !row.CONSTRAINT_NAME
      ) {
        continue;
      }

      const schema = row.TABLE_SCHEMA ?? '';
      const referencedSchema = row.REFERENCED_TABLE_SCHEMA ?? '';
      const key = `${schema}.${row.TABLE_NAME}:${row.CONSTRAINT_NAME}`;

      const relationship = relationships.get(key) ?? {
        table: `${schema}.${row.TABLE_NAME}`,
        from: [],
        referenced_table: `${referencedSchema}.${row.REFERENCED_TABLE_NAME}`,
        to: [],
      };

      relationship.from.push(row.COLUMN_NAME ?? 'unknown');
      relationship.to.push(row.REFERENCED_COLUMN_NAME ?? 'unknown');

      relationships.set(key, relationship);
    }

    return Array.from(relationships.values());
  }

  #buildDatabaseFilter(columnName: string): string {
    if (this.#databases && this.#databases.length > 0) {
      const values = this.#databases
        .map((db) => `'${this.#adapter.escapeString(db)}'`)
        .join(', ');
      return `AND ${columnName} IN (${values})`;
    }

    // Exclude system databases by default
    const systemDbs = this.#adapter.systemSchemas
      .map((db) => `'${this.#adapter.escapeString(db)}'`)
      .join(', ');
    return `AND ${columnName} NOT IN (${systemDbs})`;
  }

  async #getCurrentDatabase(): Promise<string> {
    const rows = await this.#adapter.runQuery<{ db: string | null }>(
      'SELECT DATABASE() AS db',
    );
    return rows[0]?.db ?? '';
  }
}
