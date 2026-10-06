import { z } from 'zod';

import type { Adapter, TableConstraint } from '../adapter.ts';
import {
  ConstraintGrounding,
  type ConstraintGroundingConfig,
} from '../groundings/constraint.grounding.ts';
import { currentDatabaseRow } from './mysql-rows.ts';

/**
 * TABLE_CONSTRAINTS LEFT JOIN KEY_COLUMN_USAGE: the key columns are NULL for a
 * constraint without key columns.
 */
const constraintRow = z.object({
  CONSTRAINT_NAME: z.string().nullable(),
  CONSTRAINT_TYPE: z.string().nullable(),
  COLUMN_NAME: z.string().nullable(),
  REFERENCED_TABLE_SCHEMA: z.string().nullable(),
  REFERENCED_TABLE_NAME: z.string().nullable(),
  REFERENCED_COLUMN_NAME: z.string().nullable(),
});

/** INFORMATION_SCHEMA.COLUMNS: IS_NULLABLE is 'YES' or 'NO'. */
const columnConstraintRow = z.object({
  COLUMN_NAME: z.string().nullable(),
  IS_NULLABLE: z.string().nullable(),
  COLUMN_DEFAULT: z.string().nullable(),
});

const checkConstraintRow = z.object({
  CONSTRAINT_NAME: z.string().nullable(),
  CHECK_CLAUSE: z.string().nullable(),
});

const checkTableRow = z.object({
  CONSTRAINT_NAME: z.string(),
  TABLE_NAME: z.string(),
});

/**
 * MySQL/MariaDB implementation of ConstraintGrounding.
 *
 * Collects PRIMARY KEY, FOREIGN KEY, UNIQUE, NOT_NULL, DEFAULT, and CHECK constraints.
 */
export class MysqlConstraintGrounding extends ConstraintGrounding {
  #adapter: Adapter;

  constructor(adapter: Adapter, config: ConstraintGroundingConfig = {}) {
    super(config);
    this.#adapter = adapter;
  }

  protected override async getConstraints(
    tableName: string,
  ): Promise<TableConstraint[]> {
    const { schema, table } = this.#adapter.parseTableName(tableName);
    const database = schema || (await this.#getCurrentDatabase());
    const constraints: TableConstraint[] = [];

    // Get PRIMARY KEY, UNIQUE, and FOREIGN KEY constraints
    const constraintRows = await this.#adapter.runQuery(
      `
      SELECT
        tc.CONSTRAINT_NAME,
        tc.CONSTRAINT_TYPE,
        kcu.COLUMN_NAME,
        kcu.REFERENCED_TABLE_SCHEMA,
        kcu.REFERENCED_TABLE_NAME,
        kcu.REFERENCED_COLUMN_NAME
      FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
      LEFT JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
        ON tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
        AND tc.TABLE_SCHEMA = kcu.TABLE_SCHEMA
        AND tc.TABLE_NAME = kcu.TABLE_NAME
      WHERE tc.TABLE_SCHEMA = '${this.#adapter.escapeString(database)}'
        AND tc.TABLE_NAME = '${this.#adapter.escapeString(table)}'
        AND tc.CONSTRAINT_TYPE IN ('PRIMARY KEY', 'UNIQUE', 'FOREIGN KEY')
      ORDER BY tc.CONSTRAINT_NAME, kcu.ORDINAL_POSITION
    `,
      constraintRow,
    );

    // Group by constraint name
    const constraintMap = new Map<
      string,
      {
        type: TableConstraint['type'];
        columns: string[];
        referencedTable?: string;
        referencedColumns?: string[];
      }
    >();

    for (const row of constraintRows) {
      if (!row.CONSTRAINT_NAME || !row.COLUMN_NAME) continue;

      const existing = constraintMap.get(row.CONSTRAINT_NAME);
      if (existing) {
        existing.columns.push(row.COLUMN_NAME);
        if (row.REFERENCED_COLUMN_NAME) {
          existing.referencedColumns = existing.referencedColumns ?? [];
          existing.referencedColumns.push(row.REFERENCED_COLUMN_NAME);
        }
      } else {
        const type = this.#mapConstraintType(row.CONSTRAINT_TYPE);
        if (!type) continue;

        const entry: {
          type: TableConstraint['type'];
          columns: string[];
          referencedTable?: string;
          referencedColumns?: string[];
        } = {
          type,
          columns: [row.COLUMN_NAME],
        };

        if (type === 'FOREIGN_KEY' && row.REFERENCED_TABLE_NAME) {
          entry.referencedTable = row.REFERENCED_TABLE_SCHEMA
            ? `${row.REFERENCED_TABLE_SCHEMA}.${row.REFERENCED_TABLE_NAME}`
            : row.REFERENCED_TABLE_NAME;
          if (row.REFERENCED_COLUMN_NAME) {
            entry.referencedColumns = [row.REFERENCED_COLUMN_NAME];
          }
        }

        constraintMap.set(row.CONSTRAINT_NAME, entry);
      }
    }

    for (const [name, data] of constraintMap) {
      constraints.push({
        name,
        type: data.type,
        columns: data.columns,
        referencedTable: data.referencedTable,
        referencedColumns: data.referencedColumns,
      });
    }

    // Get NOT_NULL and DEFAULT constraints from column metadata
    const columnRows = await this.#adapter.runQuery(
      `
      SELECT COLUMN_NAME, IS_NULLABLE, COLUMN_DEFAULT
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = '${this.#adapter.escapeString(database)}'
        AND TABLE_NAME = '${this.#adapter.escapeString(table)}'
    `,
      columnConstraintRow,
    );

    // Find PK columns to exclude from NOT_NULL (PK columns are implicitly NOT NULL)
    const pkConstraint = constraints.find((c) => c.type === 'PRIMARY_KEY');
    const pkColumns = new Set(pkConstraint?.columns ?? []);

    for (const row of columnRows) {
      if (!row.COLUMN_NAME) continue;

      // NOT NULL constraint - exclude PK columns which are implicitly NOT NULL
      if (row.IS_NULLABLE === 'NO' && !pkColumns.has(row.COLUMN_NAME)) {
        constraints.push({
          name: `${row.COLUMN_NAME}_not_null`,
          type: 'NOT_NULL',
          columns: [row.COLUMN_NAME],
        });
      }

      if (row.COLUMN_DEFAULT !== null) {
        constraints.push({
          name: `${row.COLUMN_NAME}_default`,
          type: 'DEFAULT',
          columns: [row.COLUMN_NAME],
          defaultValue: row.COLUMN_DEFAULT,
        });
      }
    }

    // Get CHECK constraints (MySQL 8.0.16+ and MariaDB 10.2.1+)
    try {
      const checkRows = await this.#adapter.runQuery(
        `
        SELECT CONSTRAINT_NAME, CHECK_CLAUSE
        FROM INFORMATION_SCHEMA.CHECK_CONSTRAINTS
        WHERE CONSTRAINT_SCHEMA = '${this.#adapter.escapeString(database)}'
      `,
        checkConstraintRow,
      );

      // Get constraint-to-table mapping
      const checkTableRows = await this.#adapter.runQuery(
        `
        SELECT CONSTRAINT_NAME, TABLE_NAME
        FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
        WHERE TABLE_SCHEMA = '${this.#adapter.escapeString(database)}'
          AND TABLE_NAME = '${this.#adapter.escapeString(table)}'
          AND CONSTRAINT_TYPE = 'CHECK'
      `,
        checkTableRow,
      );

      const checkTableMap = new Map(
        checkTableRows.map((r) => [r.CONSTRAINT_NAME, r.TABLE_NAME]),
      );

      for (const row of checkRows) {
        if (!row.CONSTRAINT_NAME) continue;
        // Only include checks for this table
        if (checkTableMap.get(row.CONSTRAINT_NAME) !== table) continue;

        constraints.push({
          name: row.CONSTRAINT_NAME,
          type: 'CHECK',
          definition: row.CHECK_CLAUSE ?? undefined,
        });
      }
    } catch {
      // CHECK_CONSTRAINTS table might not exist in older MySQL versions
    }

    return constraints;
  }

  #mapConstraintType(type: string | null): TableConstraint['type'] | null {
    switch (type) {
      case 'PRIMARY KEY':
        return 'PRIMARY_KEY';
      case 'UNIQUE':
        return 'UNIQUE';
      case 'FOREIGN KEY':
        return 'FOREIGN_KEY';
      default:
        return null;
    }
  }

  async #getCurrentDatabase(): Promise<string> {
    const rows = await this.#adapter.runQuery(
      'SELECT DATABASE() AS db',
      currentDatabaseRow,
    );
    return rows[0]?.db ?? '';
  }
}
