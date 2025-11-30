import type { Adapter, TableConstraint } from '../adapter.ts';
import {
  ConstraintGrounding,
  type ConstraintGroundingConfig,
} from '../groundings/constraint.grounding.ts';

type ConstraintRow = {
  constraint_name: string;
  constraint_type: string;
  definition: string | null;
  column_name: string | null;
  ref_schema: string | null;
  ref_table: string | null;
  ref_column: string | null;
};

type ColumnDefaultRow = {
  column_name: string;
  column_default: string | null;
  is_nullable: string;
};

/**
 * PostgreSQL implementation of ConstraintGrounding.
 */
export class PostgresConstraintGrounding extends ConstraintGrounding {
  #adapter: Adapter;

  constructor(adapter: Adapter, config: ConstraintGroundingConfig = {}) {
    super(config);
    this.#adapter = adapter;
  }

  protected override async getConstraints(tableName: string): Promise<TableConstraint[]> {
    const { schema, table } = this.#adapter.parseTableName(tableName);
    const constraints: TableConstraint[] = [];

    // Get PRIMARY KEY, FOREIGN KEY, CHECK, and UNIQUE constraints from pg_constraint
    // contype: p=primary key, f=foreign key, c=check, u=unique
    const constraintRows = await this.#adapter.runQuery<ConstraintRow>(`
      SELECT
        con.conname AS constraint_name,
        con.contype AS constraint_type,
        pg_get_constraintdef(con.oid) AS definition,
        a.attname AS column_name,
        ref_nsp.nspname AS ref_schema,
        ref_rel.relname AS ref_table,
        ref_a.attname AS ref_column
      FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
      JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
      LEFT JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS key(attnum, ord) ON TRUE
      LEFT JOIN pg_attribute a ON a.attrelid = rel.oid AND a.attnum = key.attnum
      LEFT JOIN pg_class ref_rel ON ref_rel.oid = con.confrelid
      LEFT JOIN pg_namespace ref_nsp ON ref_nsp.oid = ref_rel.relnamespace
      LEFT JOIN LATERAL unnest(con.confkey) WITH ORDINALITY AS ref_key(attnum, ord) ON key.ord = ref_key.ord
      LEFT JOIN pg_attribute ref_a ON ref_a.attrelid = ref_rel.oid AND ref_a.attnum = ref_key.attnum
      WHERE nsp.nspname = '${this.#adapter.escapeString(schema)}'
        AND rel.relname = '${this.#adapter.escapeString(table)}'
        AND con.contype IN ('p', 'f', 'c', 'u')
      ORDER BY con.conname, key.ord
    `);

    // Group by constraint name
    const constraintMap = new Map<string, {
      type: string;
      definition: string | null;
      columns: string[];
      refSchema: string | null;
      refTable: string | null;
      refColumns: string[];
    }>();

    for (const row of constraintRows) {
      const existing = constraintMap.get(row.constraint_name);
      if (existing) {
        if (row.column_name && !existing.columns.includes(row.column_name)) {
          existing.columns.push(row.column_name);
        }
        if (row.ref_column && !existing.refColumns.includes(row.ref_column)) {
          existing.refColumns.push(row.ref_column);
        }
      } else {
        constraintMap.set(row.constraint_name, {
          type: row.constraint_type,
          definition: row.definition,
          columns: row.column_name ? [row.column_name] : [],
          refSchema: row.ref_schema,
          refTable: row.ref_table,
          refColumns: row.ref_column ? [row.ref_column] : [],
        });
      }
    }

    for (const [name, data] of constraintMap) {
      if (data.type === 'p') {
        // PRIMARY KEY constraint
        constraints.push({
          name,
          type: 'PRIMARY_KEY',
          columns: data.columns,
        });
      } else if (data.type === 'f') {
        // FOREIGN KEY constraint
        const referencedTable = data.refSchema && data.refTable
          ? `${data.refSchema}.${data.refTable}`
          : data.refTable ?? undefined;
        constraints.push({
          name,
          type: 'FOREIGN_KEY',
          columns: data.columns,
          referencedTable,
          referencedColumns: data.refColumns,
        });
      } else if (data.type === 'c') {
        // CHECK constraint
        constraints.push({
          name,
          type: 'CHECK',
          definition: data.definition?.replace(/^CHECK\s*\(/i, '').replace(/\)$/, '') || undefined,
          columns: data.columns.length > 0 ? data.columns : undefined,
        });
      } else if (data.type === 'u') {
        // UNIQUE constraint
        constraints.push({
          name,
          type: 'UNIQUE',
          columns: data.columns,
        });
      }
    }

    // Get NOT NULL and DEFAULT from information_schema
    const columnRows = await this.#adapter.runQuery<ColumnDefaultRow>(`
      SELECT
        column_name,
        column_default,
        is_nullable
      FROM information_schema.columns
      WHERE table_schema = '${this.#adapter.escapeString(schema)}'
        AND table_name = '${this.#adapter.escapeString(table)}'
    `);

    for (const col of columnRows) {
      // NOT NULL constraint (exclude primary key columns which are implicitly NOT NULL)
      const pkConstraint = constraints.find((c) => c.type === 'PRIMARY_KEY');
      const isPkColumn = pkConstraint?.columns?.includes(col.column_name);
      if (col.is_nullable === 'NO' && !isPkColumn) {
        constraints.push({
          name: `${table}_${col.column_name}_notnull`,
          type: 'NOT_NULL',
          columns: [col.column_name],
        });
      }

      // DEFAULT constraint
      if (col.column_default != null) {
        constraints.push({
          name: `${table}_${col.column_name}_default`,
          type: 'DEFAULT',
          columns: [col.column_name],
          defaultValue: col.column_default,
        });
      }
    }

    return constraints;
  }
}
