import { z } from 'zod';

import type { Adapter, Relationship, Table } from '../adapter.ts';
import { nameRow } from '../groundings/rows.ts';
import {
  TableGrounding,
  type TableGroundingConfig,
} from '../groundings/table.grounding.ts';
import { columnRow } from './postgres-rows.ts';

/** One column pair of a foreign key, read from pg_constraint. */
const relationshipRow = z.object({
  constraint_name: z.string(),
  table_schema: z.string(),
  table_name: z.string(),
  column_name: z.string(),
  foreign_table_schema: z.string(),
  foreign_table_name: z.string(),
  foreign_column_name: z.string(),
});

export interface PostgresTableGroundingConfig extends TableGroundingConfig {
  /** Schemas to include (defaults to excluding pg_catalog and information_schema) */
  schemas?: string[];
}

/**
 * PostgreSQL implementation of TableGrounding.
 *
 * PostgreSQL can query incoming relationships directly via pg_constraint,
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
    const rows = await this.#adapter.runQuery(
      `
      SELECT DISTINCT table_schema || '.' || table_name AS name
      FROM information_schema.tables
      WHERE table_type = 'BASE TABLE'
        ${this.#adapter.buildSchemaFilter('table_schema', this.#schemas)}
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
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_schema = '${this.#adapter.escapeString(schema)}'
        AND table_name = '${this.#adapter.escapeString(table)}'
      ORDER BY ordinal_position
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
      `nsp.nspname = '${this.#adapter.escapeString(schema)}'
        AND rel.relname = '${this.#adapter.escapeString(table)}'`,
    );
  }

  protected override async findIncomingRelations(
    tableName: string,
  ): Promise<Relationship[]> {
    const { schema, table } = this.#adapter.parseTableName(tableName);
    return this.#foreignKeys(
      `ref_nsp.nspname = '${this.#adapter.escapeString(schema)}'
        AND ref_rel.relname = '${this.#adapter.escapeString(table)}'`,
    );
  }

  /**
   * The foreign keys matching `where`. unnest(conkey, confkey) WITH
   * ORDINALITY pairs each column with the column it references by position,
   * and each side carries its own schema, so composite and cross-schema keys
   * come back whole.
   */
  async #foreignKeys(where: string): Promise<Relationship[]> {
    const rows = await this.#adapter.runQuery(
      `
      SELECT
        con.conname AS constraint_name,
        nsp.nspname AS table_schema,
        rel.relname AS table_name,
        att.attname AS column_name,
        ref_nsp.nspname AS foreign_table_schema,
        ref_rel.relname AS foreign_table_name,
        ref_att.attname AS foreign_column_name
      FROM pg_constraint AS con
      JOIN pg_class AS rel ON rel.oid = con.conrelid
      JOIN pg_namespace AS nsp ON nsp.oid = rel.relnamespace
      JOIN pg_class AS ref_rel ON ref_rel.oid = con.confrelid
      JOIN pg_namespace AS ref_nsp ON ref_nsp.oid = ref_rel.relnamespace
      CROSS JOIN LATERAL unnest(con.conkey, con.confkey)
        WITH ORDINALITY AS key(attnum, ref_attnum, ord)
      JOIN pg_attribute AS att
        ON att.attrelid = con.conrelid AND att.attnum = key.attnum
      JOIN pg_attribute AS ref_att
        ON ref_att.attrelid = con.confrelid AND ref_att.attnum = key.ref_attnum
      WHERE con.contype = 'f'
        AND ${where}
      ORDER BY nsp.nspname, rel.relname, con.conname, key.ord
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
        referenced_table: `${row.foreign_table_schema}.${row.foreign_table_name}`,
        to: [],
      };
      relationship.from.push(row.column_name);
      relationship.to.push(row.foreign_column_name);
      relationships.set(key, relationship);
    }
    return Array.from(relationships.values());
  }
}
