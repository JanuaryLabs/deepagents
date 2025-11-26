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

export type AdapterInfoProvider =
  | AdapterInfo
  | (() => Promise<AdapterInfo> | AdapterInfo);

export interface IntrospectOptions {
  onProgress?: OnProgress;
}

export abstract class Adapter {
  abstract introspect(options?: IntrospectOptions): Promise<Introspection> | Introspection;

  abstract execute(sql: string): Promise<any[]> | any[];
  abstract validate(sql: string): Promise<string|void> | string|void;
  abstract info(): Promise<AdapterInfo> | AdapterInfo;
  abstract formatInfo(info: AdapterInfo): string;
}
