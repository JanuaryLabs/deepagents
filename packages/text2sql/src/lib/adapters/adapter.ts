import type { AbstractGrounding } from './grounding.ticket.ts';
import { createGroundingContext } from './groundings/context.ts';

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
    kind?: 'LowCardinality';
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
  type: 'CHECK' | 'UNIQUE' | 'NOT_NULL' | 'DEFAULT' | 'PRIMARY_KEY' | 'FOREIGN_KEY';
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

  async introspect() {
    const lines: { tag: string; fn: () => string | null }[] = [];
    const ctx = createGroundingContext();
    for (const fn of this.grounding) {
      const grounding = fn(this);
      lines.push({
        tag: grounding.tag,
        fn: await grounding.execute(ctx),
      });
    }
    return lines
      .map(({ fn, tag }) => {
        const description = fn();
        if (description === null) {
          return '';
        }
        return `<${tag}>\n${description}\n</${tag}>`;
      })
      .join('\n');
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
