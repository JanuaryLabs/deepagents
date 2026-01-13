import type { ContextFragment } from '@deepagents/context';

import {
  column,
  constraint,
  dialectInfo,
  index,
  relationship,
  table,
  view,
} from '../fragments/schema.ts';
import type { AbstractGrounding } from './groundings/abstract.grounding.ts';
import {
  type GroundingContext,
  createGroundingContext,
} from './groundings/context.ts';
import type { View } from './groundings/view.grounding.ts';

/**
 * Filter type for view/table names.
 * - string[]: explicit list of view names
 * - RegExp: pattern to match view names
 * - function: predicate to filter view names
 */
export type Filter = string[] | RegExp | ((viewName: string) => boolean);

export interface Table {
  name: string;
  schema?: string;
  rawName?: string;
  columns: {
    name: string;
    type: string;
    kind?: 'LowCardinality' | 'Enum';
    values?: string[];
    isIndexed?: boolean;
    stats?: ColumnStats;
  }[];
  rowCount?: number;
  sizeHint?: 'tiny' | 'small' | 'medium' | 'large' | 'huge';
  indexes?: TableIndex[];
  constraints?: TableConstraint[];
}

export interface TableIndex {
  name: string;
  columns: string[];
  unique?: boolean;
  type?: string;
}

export interface TableConstraint {
  name: string;
  type:
    | 'CHECK'
    | 'UNIQUE'
    | 'NOT_NULL'
    | 'DEFAULT'
    | 'PRIMARY_KEY'
    | 'FOREIGN_KEY';
  columns?: string[];
  definition?: string;
  defaultValue?: string;
  referencedTable?: string;
  referencedColumns?: string[];
}

export interface ColumnStats {
  min?: string;
  max?: string;
  nullFraction?: number;
}

export type Relationship = {
  table: string;
  from: string[];
  referenced_table: string;
  to: string[];
};

export type TablesFilter = string[] | RegExp;

export interface Introspection {
  tables: Table[];
  relationships: Relationship[];
}

export interface AdapterInfo {
  dialect: string;
  version?: string;
  database?: string;
  details?: Record<string, unknown>;
}

export type AdapterInfoProvider =
  | AdapterInfo
  | (() => Promise<AdapterInfo> | AdapterInfo);

export type IntrospectionPhase =
  | 'tables'
  | 'row_counts'
  | 'primary_keys'
  | 'indexes'
  | 'column_stats'
  | 'low_cardinality'
  | 'relationships';

export interface IntrospectionProgress {
  phase: IntrospectionPhase;
  message: string;
  current?: number;
  total?: number;
}

export type OnProgress = (progress: IntrospectionProgress) => void;

export interface IntrospectOptions {
  onProgress?: OnProgress;
}

export type GroundingFn = (adapter: Adapter) => AbstractGrounding;

export type ExecuteFunction = (sql: string) => Promise<any> | any;
export type ValidateFunction = (
  sql: string,
) => Promise<string | void> | string | void;

export abstract class Adapter {
  abstract grounding: GroundingFn[];

  /**
   * Default schema name for this database.
   * PostgreSQL: 'public', SQL Server: 'dbo', SQLite: undefined
   */
  abstract readonly defaultSchema: string | undefined;

  /**
   * System schemas to exclude from introspection by default.
   */
  abstract readonly systemSchemas: string[];

  /**
   * Introspect the database schema and return context fragments.
   *
   * Executes all configured groundings to populate the context, then
   * generates fragments from the complete context data.
   *
   * @param ctx - Optional grounding context for sharing state between groundings
   * @returns Array of context fragments representing the database schema
   */
  async introspect(ctx = createGroundingContext()): Promise<ContextFragment[]> {
    // Phase 1: All groundings populate ctx
    for (const fn of this.grounding) {
      const grounding = fn(this);
      await grounding.execute(ctx);
    }

    // Phase 2: Generate fragments from complete ctx
    return this.#toSchemaFragments(ctx);
  }

  /**
   * Convert complete grounding context to schema fragments.
   * Called after all groundings have populated ctx with data.
   */
  #toSchemaFragments(ctx: GroundingContext): ContextFragment[] {
    const fragments: ContextFragment[] = [];

    // Dialect info
    if (ctx.info) {
      fragments.push(
        dialectInfo({
          dialect: ctx.info.dialect,
          version: ctx.info.version,
          database: ctx.info.database,
        }),
      );
    }

    // Tables (with all annotations now included)
    for (const t of ctx.tables) {
      fragments.push(this.#tableToFragment(t));
    }

    // Views
    for (const v of ctx.views) {
      fragments.push(this.#viewToFragment(v));
    }

    // Relationships
    const tableMap = new Map(ctx.tables.map((t) => [t.name, t]));
    for (const rel of ctx.relationships) {
      const sourceTable = tableMap.get(rel.table);
      const targetTable = tableMap.get(rel.referenced_table);
      fragments.push(
        this.#relationshipToFragment(rel, sourceTable, targetTable),
      );
    }

    // Business context
    if (ctx.report) {
      fragments.push({ name: 'businessContext', data: ctx.report });
    }

    return fragments;
  }

  /**
   * Convert a Table to a table fragment with nested column, index, and constraint fragments.
   */
  #tableToFragment(t: Table): ContextFragment {
    // Build constraint lookup maps for column-level annotations
    const pkConstraint = t.constraints?.find((c) => c.type === 'PRIMARY_KEY');
    const pkColumns = new Set(pkConstraint?.columns ?? []);

    const notNullColumns = new Set(
      t.constraints
        ?.filter((c) => c.type === 'NOT_NULL')
        .flatMap((c) => c.columns ?? []) ?? [],
    );

    const defaultByColumn = new Map<string, string>();
    for (const c of t.constraints?.filter((c) => c.type === 'DEFAULT') ?? []) {
      for (const col of c.columns ?? []) {
        if (c.defaultValue != null) {
          defaultByColumn.set(col, c.defaultValue);
        }
      }
    }

    // Single-column UNIQUE constraints
    const uniqueColumns = new Set(
      t.constraints
        ?.filter((c) => c.type === 'UNIQUE' && c.columns?.length === 1)
        .flatMap((c) => c.columns ?? []) ?? [],
    );

    // Foreign key lookup: column -> referenced table.column
    const fkByColumn = new Map<string, string>();
    for (const c of t.constraints?.filter((c) => c.type === 'FOREIGN_KEY') ??
      []) {
      const cols = c.columns ?? [];
      const refCols = c.referencedColumns ?? [];
      for (let i = 0; i < cols.length; i++) {
        const refCol = refCols[i] ?? refCols[0] ?? cols[i];
        fkByColumn.set(cols[i], `${c.referencedTable}.${refCol}`);
      }
    }

    // Build column fragments
    const columnFragments = t.columns.map((col) =>
      column({
        name: col.name,
        type: col.type,
        pk: pkColumns.has(col.name) || undefined,
        fk: fkByColumn.get(col.name),
        unique: uniqueColumns.has(col.name) || undefined,
        notNull: notNullColumns.has(col.name) || undefined,
        default: defaultByColumn.get(col.name),
        indexed: col.isIndexed || undefined,
        values: col.values,
        stats: col.stats,
      }),
    );

    // Build index fragments
    const indexFragments = (t.indexes ?? []).map((idx) =>
      index({
        name: idx.name,
        columns: idx.columns,
        unique: idx.unique,
        type: idx.type,
      }),
    );

    // Build constraint fragments for multi-column UNIQUE and CHECK constraints
    const constraintFragments = (t.constraints ?? [])
      .filter(
        (c) =>
          c.type === 'CHECK' ||
          (c.type === 'UNIQUE' && (c.columns?.length ?? 0) > 1),
      )
      .map((c) =>
        constraint({
          name: c.name,
          type: c.type,
          columns: c.columns,
          definition: c.definition,
        }),
      );

    return table({
      name: t.name,
      schema: t.schema,
      rowCount: t.rowCount,
      sizeHint: t.sizeHint,
      columns: columnFragments,
      indexes: indexFragments.length > 0 ? indexFragments : undefined,
      constraints:
        constraintFragments.length > 0 ? constraintFragments : undefined,
    });
  }

  /**
   * Convert a View to a view fragment with nested column fragments.
   */
  #viewToFragment(v: View): ContextFragment {
    const columnFragments = v.columns.map((col) =>
      column({
        name: col.name,
        type: col.type,
        values: col.values,
        stats: col.stats,
      }),
    );

    return view({
      name: v.name,
      schema: v.schema,
      columns: columnFragments,
      definition: v.definition,
    });
  }

  /**
   * Convert a Relationship to a relationship fragment.
   * Infers cardinality from row counts if available.
   */
  #relationshipToFragment(
    rel: Relationship,
    sourceTable?: Table,
    targetTable?: Table,
  ): ContextFragment {
    const sourceCount = sourceTable?.rowCount;
    const targetCount = targetTable?.rowCount;

    let cardinality:
      | 'one-to-one'
      | 'one-to-many'
      | 'many-to-one'
      | 'many-to-many'
      | undefined;

    if (sourceCount != null && targetCount != null && targetCount > 0) {
      const ratio = sourceCount / targetCount;
      if (ratio > 5) {
        cardinality = 'many-to-one';
      } else if (ratio < 1.2 && ratio > 0.8) {
        cardinality = 'one-to-one';
      } else if (ratio < 0.2) {
        cardinality = 'one-to-many';
      }
    }

    return relationship({
      from: { table: rel.table, columns: rel.from },
      to: { table: rel.referenced_table, columns: rel.to },
      cardinality,
    });
  }
  abstract execute(sql: string): Promise<any[]> | any[];
  abstract validate(sql: string): Promise<string | void> | string | void;
  abstract runQuery<Row>(sql: string): Promise<Row[]> | Row[];

  /**
   * Quote an identifier (table/column name) for safe use in SQL.
   * Each database uses different quoting styles.
   */
  abstract quoteIdentifier(name: string): string;

  /**
   * Escape a string value for safe use in SQL.
   * Each database escapes different characters.
   */
  abstract escape(value: string): string;

  /**
   * Build a SELECT query to sample rows from a table.
   * Each database uses different syntax for limiting rows (LIMIT vs TOP).
   */
  abstract buildSampleRowsQuery(
    tableName: string,
    columns: string[] | undefined,
    limit: number,
  ): string;

  /**
   * Convert unknown database value to number.
   * Handles number, bigint, and string types.
   */
  toNumber(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === 'bigint') {
      return Number(value);
    }
    if (typeof value === 'string' && value.trim() !== '') {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : undefined;
    }
    return undefined;
  }

  /**
   * Parse a potentially qualified table name into schema and table parts.
   */
  parseTableName(name: string): { schema: string; table: string } {
    if (name.includes('.')) {
      const [schema, ...rest] = name.split('.');
      return { schema, table: rest.join('.') };
    }
    return { schema: this.defaultSchema ?? '', table: name };
  }

  /**
   * Escape a string value for use in SQL string literals (single quotes).
   * Used in WHERE clauses like: WHERE name = '${escapeString(value)}'
   */
  escapeString(value: string): string {
    return value.replace(/'/g, "''");
  }

  /**
   * Build a SQL filter clause to include/exclude schemas.
   * @param columnName - The schema column name (e.g., 'TABLE_SCHEMA')
   * @param allowedSchemas - If provided, filter to these schemas only
   */
  buildSchemaFilter(columnName: string, allowedSchemas?: string[]): string {
    if (allowedSchemas && allowedSchemas.length > 0) {
      const values = allowedSchemas
        .map((s) => `'${this.escapeString(s)}'`)
        .join(', ');
      return `AND ${columnName} IN (${values})`;
    }
    if (this.systemSchemas.length > 0) {
      const values = this.systemSchemas
        .map((s) => `'${this.escapeString(s)}'`)
        .join(', ');
      return `AND ${columnName} NOT IN (${values})`;
    }
    return '';
  }
}

export function filterTablesByName<T extends { name: string }>(
  tables: T[],
  filter: TablesFilter | undefined,
): T[] {
  if (!filter) return tables;
  return tables.filter((table) => matchesFilter(table.name, filter));
}

export function filterRelationshipsByTables(
  relationships: Relationship[],
  tableNames: Set<string> | undefined,
): Relationship[] {
  if (tableNames === undefined) {
    return relationships;
  }
  if (tableNames.size === 0) {
    return [];
  }
  return relationships.filter(
    (it) => tableNames.has(it.table) || tableNames.has(it.referenced_table),
  );
}

export function applyTablesFilter(
  tables: Table[],
  relationships: Relationship[],
  filter: TablesFilter | undefined,
): { tables: Table[]; relationships: Relationship[] } {
  if (!filter) {
    return { tables, relationships };
  }

  const allowedNames = new Set(
    getTablesWithRelated(tables, relationships, filter),
  );

  return {
    tables: tables.filter((table) => allowedNames.has(table.name)),
    relationships: filterRelationshipsByTables(relationships, allowedNames),
  };
}

export function matchesFilter(
  tableName: string,
  filter: TablesFilter,
): boolean {
  if (Array.isArray(filter)) {
    return filter.includes(tableName);
  }
  return filter.test(tableName);
}

export function getTablesWithRelated(
  allTables: Table[],
  relationships: Relationship[],
  filter: TablesFilter,
): string[] {
  const matchedTables = filterTablesByName(allTables, filter).map(
    (it) => it.name,
  );

  if (matchedTables.length === 0) {
    return [];
  }

  const adjacency = new Map<string, Set<string>>();

  for (const rel of relationships) {
    if (!adjacency.has(rel.table)) {
      adjacency.set(rel.table, new Set());
    }
    if (!adjacency.has(rel.referenced_table)) {
      adjacency.set(rel.referenced_table, new Set());
    }
    adjacency.get(rel.table)!.add(rel.referenced_table);
    adjacency.get(rel.referenced_table)!.add(rel.table);
  }

  const result = new Set<string>(matchedTables);
  const queue = [...matchedTables];

  while (queue.length > 0) {
    const current = queue.shift()!;
    const neighbors = adjacency.get(current);

    if (!neighbors) {
      continue;
    }

    for (const neighbor of neighbors) {
      if (!result.has(neighbor)) {
        result.add(neighbor);
        queue.push(neighbor);
      }
    }
  }

  return Array.from(result);
}
