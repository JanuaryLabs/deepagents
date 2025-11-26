export interface Table {
  name: string;
  schema?: string;
  rawName?: string;
  columns: {
    name: string;
    type: string;
    kind?: 'LowCardinality';
    values?: string[];
    isPrimaryKey?: boolean;
    isIndexed?: boolean;
    stats?: ColumnStats;
  }[];
  rowCount?: number;
  sizeHint?: 'tiny' | 'small' | 'medium' | 'large' | 'huge';
  indexes?: TableIndex[];
}

export interface TableIndex {
  name: string;
  columns: string[];
  unique?: boolean;
  primary?: boolean;
  type?: string;
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
  host?: string;
  details?: Record<string, unknown>;
}

export type AdapterInfoProvider =
  | AdapterInfo
  | (() => Promise<AdapterInfo> | AdapterInfo);

export abstract class Adapter {
  abstract introspect(): Promise<Introspection> | Introspection;

  abstract execute(sql: string): Promise<any[]> | any[];
  abstract validate(sql: string): Promise<string | void> | string | void;
  abstract info(): Promise<AdapterInfo> | AdapterInfo;
  abstract formatInfo(info: AdapterInfo): string;

  abstract getTables(): Promise<Table[]> | Table[];
  abstract getRelationships(): Promise<Relationship[]> | Relationship[];

  async resolveTables(filter: TablesFilter): Promise<string[]> {
    const allTables = await this.getTables();
    const relationships = await this.getRelationships();
    return getTablesWithRelated(allTables, relationships, filter);
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
