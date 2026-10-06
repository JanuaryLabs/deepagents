import { z } from 'zod';

import type { Adapter, TableConstraint } from '../adapter.ts';
import {
  ConstraintGrounding,
  type ConstraintGroundingConfig,
} from '../groundings/constraint.grounding.ts';

// Names are sysname (strings); COL_NAME() resolves the column of an object the
// same catalog query already made visible.

/** A PRIMARY KEY or UNIQUE constraint column, in key order. */
const keyColumnRow = z.object({
  constraint_name: z.string(),
  column_name: z.string(),
});

const foreignKeyRow = z.object({
  constraint_name: z.string(),
  column_name: z.string(),
  ref_schema: z.string(),
  ref_table: z.string(),
  ref_column: z.string(),
});

/** sys.check_constraints.definition is nvarchar(max) and nullable. */
const checkConstraintRow = z.object({
  constraint_name: z.string(),
  definition: z.string().nullable(),
});

/**
 * sys.columns with its default. `default_definition` is NULL when the LEFT
 * JOIN finds no default; `is_nullable` is a bit, which tedious returns as a
 * boolean.
 */
const columnDefaultRow = z.object({
  column_name: z.string(),
  default_definition: z.string().nullable(),
  is_nullable: z.boolean(),
});

/**
 * SQL Server implementation of ConstraintGrounding.
 */
export class SqlServerConstraintGrounding extends ConstraintGrounding {
  #adapter: Adapter;

  constructor(adapter: Adapter, config: ConstraintGroundingConfig = {}) {
    super(config);
    this.#adapter = adapter;
  }

  protected override async getConstraints(
    tableName: string,
  ): Promise<TableConstraint[]> {
    const { schema, table } = this.#adapter.parseTableName(tableName);
    const constraints: TableConstraint[] = [];

    // Get PRIMARY KEY constraint
    const pkRows = await this.#adapter.runQuery(
      `
      SELECT
        kc.name AS constraint_name,
        COL_NAME(ic.object_id, ic.column_id) AS column_name
      FROM sys.key_constraints kc
      JOIN sys.index_columns ic ON kc.parent_object_id = ic.object_id AND kc.unique_index_id = ic.index_id
      JOIN sys.tables t ON kc.parent_object_id = t.object_id
      JOIN sys.schemas s ON t.schema_id = s.schema_id
      WHERE s.name = '${this.#adapter.escapeString(schema)}'
        AND t.name = '${this.#adapter.escapeString(table)}'
        AND kc.type = 'PK'
      ORDER BY ic.key_ordinal
    `,
      keyColumnRow,
    );

    if (pkRows.length > 0) {
      constraints.push({
        name: pkRows[0].constraint_name,
        type: 'PRIMARY_KEY',
        columns: pkRows.map((r) => r.column_name),
      });
    }

    // Get FOREIGN KEY constraints
    const fkRows = await this.#adapter.runQuery(
      `
      SELECT
        fk.name AS constraint_name,
        COL_NAME(fkc.parent_object_id, fkc.parent_column_id) AS column_name,
        ref_s.name AS ref_schema,
        ref_t.name AS ref_table,
        COL_NAME(fkc.referenced_object_id, fkc.referenced_column_id) AS ref_column
      FROM sys.foreign_keys fk
      JOIN sys.foreign_key_columns fkc ON fk.object_id = fkc.constraint_object_id
      JOIN sys.tables t ON fk.parent_object_id = t.object_id
      JOIN sys.schemas s ON t.schema_id = s.schema_id
      JOIN sys.tables ref_t ON fk.referenced_object_id = ref_t.object_id
      JOIN sys.schemas ref_s ON ref_t.schema_id = ref_s.schema_id
      WHERE s.name = '${this.#adapter.escapeString(schema)}'
        AND t.name = '${this.#adapter.escapeString(table)}'
      ORDER BY fk.name, fkc.constraint_column_id
    `,
      foreignKeyRow,
    );

    // Group foreign keys by name
    const fkMap = new Map<
      string,
      {
        columns: string[];
        refSchema: string;
        refTable: string;
        refColumns: string[];
      }
    >();
    for (const row of fkRows) {
      const existing = fkMap.get(row.constraint_name);
      if (existing) {
        existing.columns.push(row.column_name);
        existing.refColumns.push(row.ref_column);
      } else {
        fkMap.set(row.constraint_name, {
          columns: [row.column_name],
          refSchema: row.ref_schema,
          refTable: row.ref_table,
          refColumns: [row.ref_column],
        });
      }
    }

    for (const [name, data] of fkMap) {
      constraints.push({
        name,
        type: 'FOREIGN_KEY',
        columns: data.columns,
        referencedTable: `${data.refSchema}.${data.refTable}`,
        referencedColumns: data.refColumns,
      });
    }

    // Get CHECK constraints
    const checkRows = await this.#adapter.runQuery(
      `
      SELECT
        cc.name AS constraint_name,
        cc.definition
      FROM sys.check_constraints cc
      JOIN sys.tables t ON cc.parent_object_id = t.object_id
      JOIN sys.schemas s ON t.schema_id = s.schema_id
      WHERE s.name = '${this.#adapter.escapeString(schema)}'
        AND t.name = '${this.#adapter.escapeString(table)}'
    `,
      checkConstraintRow,
    );

    for (const row of checkRows) {
      constraints.push({
        name: row.constraint_name,
        type: 'CHECK',
        definition: row.definition?.replace(/^\(/, '').replace(/\)$/, ''),
      });
    }

    // Get UNIQUE constraints
    const uniqueRows = await this.#adapter.runQuery(
      `
      SELECT
        i.name AS constraint_name,
        COL_NAME(ic.object_id, ic.column_id) AS column_name
      FROM sys.indexes i
      JOIN sys.index_columns ic ON i.object_id = ic.object_id AND i.index_id = ic.index_id
      JOIN sys.tables t ON i.object_id = t.object_id
      JOIN sys.schemas s ON t.schema_id = s.schema_id
      WHERE s.name = '${this.#adapter.escapeString(schema)}'
        AND t.name = '${this.#adapter.escapeString(table)}'
        AND i.is_unique_constraint = 1
      ORDER BY i.name, ic.key_ordinal
    `,
      keyColumnRow,
    );

    // Group unique constraints by name
    const uniqueMap = new Map<string, string[]>();
    for (const row of uniqueRows) {
      const existing = uniqueMap.get(row.constraint_name);
      if (existing) {
        existing.push(row.column_name);
      } else {
        uniqueMap.set(row.constraint_name, [row.column_name]);
      }
    }

    for (const [name, columns] of uniqueMap) {
      constraints.push({
        name,
        type: 'UNIQUE',
        columns,
      });
    }

    // Get NOT NULL and DEFAULT constraints
    const columnRows = await this.#adapter.runQuery(
      `
      SELECT
        c.name AS column_name,
        dc.definition AS default_definition,
        c.is_nullable
      FROM sys.columns c
      JOIN sys.tables t ON c.object_id = t.object_id
      JOIN sys.schemas s ON t.schema_id = s.schema_id
      LEFT JOIN sys.default_constraints dc ON c.default_object_id = dc.object_id
      WHERE s.name = '${this.#adapter.escapeString(schema)}'
        AND t.name = '${this.#adapter.escapeString(table)}'
    `,
      columnDefaultRow,
    );

    // Get primary key columns to exclude from NOT NULL
    const pkConstraint = constraints.find((c) => c.type === 'PRIMARY_KEY');
    const pkColumns = new Set(pkConstraint?.columns ?? []);

    for (const col of columnRows) {
      // NOT NULL constraint (exclude primary key columns which are implicitly NOT NULL)
      if (!col.is_nullable && !pkColumns.has(col.column_name)) {
        constraints.push({
          name: `${table}_${col.column_name}_notnull`,
          type: 'NOT_NULL',
          columns: [col.column_name],
        });
      }

      // DEFAULT constraint
      if (col.default_definition != null) {
        constraints.push({
          name: `${table}_${col.column_name}_default`,
          type: 'DEFAULT',
          columns: [col.column_name],
          defaultValue: col.default_definition
            .replace(/^\(/, '')
            .replace(/\)$/, ''),
        });
      }
    }

    return constraints;
  }
}
