import type { Adapter, TableConstraint } from '../adapter.ts';
import {
  ConstraintGrounding,
  type ConstraintGroundingConfig,
} from '../groundings/constraint.grounding.ts';

type TableInfoRow = {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
};

type SqliteMasterRow = {
  sql: string | null;
};

type ForeignKeyRow = {
  id: number;
  seq: number;
  table: string;
  from: string;
  to: string;
};

/**
 * SQLite implementation of ConstraintGrounding.
 *
 * SQLite stores constraints in the CREATE TABLE DDL, so we need to:
 * 1. Use PRAGMA table_info for NOT NULL and DEFAULT
 * 2. Parse the DDL for CHECK constraints
 */
export class SqliteConstraintGrounding extends ConstraintGrounding {
  #adapter: Adapter;

  constructor(adapter: Adapter, config: ConstraintGroundingConfig = {}) {
    super(config);
    this.#adapter = adapter;
  }

  protected override async getConstraints(
    tableName: string,
  ): Promise<TableConstraint[]> {
    const constraints: TableConstraint[] = [];

    // Get column info for NOT NULL, DEFAULT, and PRIMARY KEY constraints
    const columns = await this.#adapter.runQuery<TableInfoRow>(
      `PRAGMA table_info(${this.#quoteIdentifier(tableName)})`,
    );

    // Collect PRIMARY KEY columns (pk > 0, ordered by pk value for composite keys)
    const pkColumns = columns
      .filter((col) => col.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((col) => col.name);

    if (pkColumns.length > 0) {
      constraints.push({
        name: `${tableName}_pkey`,
        type: 'PRIMARY_KEY',
        columns: pkColumns,
      });
    }

    for (const col of columns) {
      // NOT NULL constraint (excluding primary keys which are implicitly NOT NULL)
      if (col.notnull === 1 && col.pk === 0) {
        constraints.push({
          name: `${tableName}_${col.name}_notnull`,
          type: 'NOT_NULL',
          columns: [col.name],
        });
      }

      // DEFAULT constraint
      if (col.dflt_value != null) {
        constraints.push({
          name: `${tableName}_${col.name}_default`,
          type: 'DEFAULT',
          columns: [col.name],
          defaultValue: col.dflt_value,
        });
      }
    }

    // Get FOREIGN KEY constraints
    const fkRows = await this.#adapter.runQuery<ForeignKeyRow>(
      `PRAGMA foreign_key_list(${this.#quoteIdentifier(tableName)})`,
    );

    // Group foreign keys by id (each FK can have multiple columns)
    const fkGroups = new Map<number, ForeignKeyRow[]>();
    for (const row of fkRows) {
      const group = fkGroups.get(row.id) ?? [];
      group.push(row);
      fkGroups.set(row.id, group);
    }

    for (const [id, rows] of fkGroups) {
      // Sort by seq to get correct column order
      rows.sort((a, b) => a.seq - b.seq);
      constraints.push({
        name: `${tableName}_fkey_${id}`,
        type: 'FOREIGN_KEY',
        columns: rows.map((r) => r.from),
        referencedTable: rows[0].table,
        referencedColumns: rows.map((r) => r.to),
      });
    }

    // Get CHECK and UNIQUE constraints from DDL
    const ddlRows = await this.#adapter.runQuery<SqliteMasterRow>(
      `SELECT sql FROM sqlite_master WHERE type='table' AND name=${this.#quoteIdentifier(tableName)}`,
    );

    if (ddlRows[0]?.sql) {
      const columnNames = columns.map((c) => c.name);
      const checkConstraints = this.#parseCheckConstraints(
        ddlRows[0].sql,
        tableName,
        columnNames,
      );
      constraints.push(...checkConstraints);
    }

    return constraints;
  }

  #parseCheckConstraints(
    ddl: string,
    tableName: string,
    columnNames: string[],
  ): TableConstraint[] {
    const constraints: TableConstraint[] = [];

    // Find CHECK constraints with proper parenthesis matching
    // Match: CONSTRAINT name CHECK or just CHECK
    const checkStartRegex =
      /(?:CONSTRAINT\s+["'`]?(\w+)["'`]?\s+)?CHECK\s*\(/gi;
    let startMatch;
    let index = 0;

    while ((startMatch = checkStartRegex.exec(ddl)) !== null) {
      const name = startMatch[1] || `${tableName}_check_${index}`;
      const startPos = startMatch.index + startMatch[0].length;

      // Find the matching closing parenthesis
      let depth = 1;
      let endPos = startPos;
      while (endPos < ddl.length && depth > 0) {
        if (ddl[endPos] === '(') depth++;
        else if (ddl[endPos] === ')') depth--;
        endPos++;
      }

      if (depth === 0) {
        const definition = ddl.slice(startPos, endPos - 1).trim();
        if (definition) {
          // Try to identify which columns this constraint applies to
          const constraintColumns = columnNames.filter((col) => {
            // Match column name as a word boundary
            const colRegex = new RegExp(`\\b${col}\\b`, 'i');
            return colRegex.test(definition);
          });

          constraints.push({
            name,
            type: 'CHECK',
            definition,
            columns:
              constraintColumns.length > 0 ? constraintColumns : undefined,
          });
          index++;
        }
      }
    }

    // Match UNIQUE constraints at table level
    const uniqueRegex =
      /(?:CONSTRAINT\s+["'`]?(\w+)["'`]?\s+)?UNIQUE\s*\(([^)]+)\)/gi;
    let uniqueIndex = 0;
    let uniqueMatch;

    while ((uniqueMatch = uniqueRegex.exec(ddl)) !== null) {
      const name = uniqueMatch[1] || `${tableName}_unique_${uniqueIndex}`;
      const columnsStr = uniqueMatch[2]?.trim();

      if (columnsStr) {
        const columns = columnsStr
          .split(',')
          .map((c) => c.trim().replace(/["'`]/g, ''));
        constraints.push({
          name,
          type: 'UNIQUE',
          columns,
        });
        uniqueIndex++;
      }
    }

    return constraints;
  }

  #quoteIdentifier(name: string): string {
    return `'${name.replace(/'/g, "''")}'`;
  }
}
