import type { ContextFragment } from '@deepagents/context';

/**
 * Schema fragment builders.
 *
 * These fragments represent database schema metadata that can be injected
 * into AI prompts. Use with renderers (XML, Markdown, TOML, TOON) to format.
 *
 * @example
 * ```ts
 * import { dialectInfo, table, column, relationship } from '@deepagents/text2sql';
 *
 * const schemaFragments = [
 *   dialectInfo({ dialect: 'PostgreSQL', version: '14.5' }),
 *   table({
 *     name: 'users',
 *     columns: [
 *       column({ name: 'id', type: 'integer', pk: true }),
 *       column({ name: 'email', type: 'varchar', unique: true }),
 *     ],
 *   }),
 * ];
 * ```
 */

/**
 * Database dialect and version information.
 *
 * @param input.dialect - Database type (PostgreSQL, SQLite, SQL Server, etc.)
 * @param input.version - Database version string
 * @param input.database - Database name
 *
 * @example
 * dialectInfo({ dialect: 'PostgreSQL', version: '14.5', database: 'myapp' })
 */
export function dialectInfo(input: {
  dialect: string;
  version?: string;
  database?: string;
}): ContextFragment {
  return {
    name: 'dialectInfo',
    data: {
      dialect: input.dialect,
      ...(input.version && { version: input.version }),
      ...(input.database && { database: input.database }),
    },
  };
}

/**
 * Database table with columns and optional metadata.
 *
 * @param input.name - Table name
 * @param input.schema - Schema name (e.g., 'public' for PostgreSQL)
 * @param input.rowCount - Approximate row count
 * @param input.sizeHint - Size category for query optimization hints
 * @param input.columns - Array of column() fragments
 * @param input.indexes - Array of index() fragments
 * @param input.constraints - Array of constraint() fragments
 *
 * @example
 * table({
 *   name: 'users',
 *   rowCount: 1500,
 *   sizeHint: 'medium',
 *   columns: [
 *     column({ name: 'id', type: 'integer', pk: true }),
 *     column({ name: 'email', type: 'varchar', unique: true, indexed: true }),
 *   ],
 *   indexes: [
 *     index({ name: 'idx_email', columns: ['email'], unique: true }),
 *   ],
 * })
 */
export function table(input: {
  name: string;
  schema?: string;
  rowCount?: number;
  sizeHint?: 'tiny' | 'small' | 'medium' | 'large' | 'huge';
  columns: ContextFragment[];
  indexes?: ContextFragment[];
  constraints?: ContextFragment[];
}): ContextFragment {
  return {
    name: 'table',
    data: {
      name: input.name,
      ...(input.schema && { schema: input.schema }),
      ...(input.rowCount != null && { rowCount: input.rowCount }),
      ...(input.sizeHint && { sizeHint: input.sizeHint }),
      columns: input.columns,
      ...(input.indexes?.length && { indexes: input.indexes }),
      ...(input.constraints?.length && { constraints: input.constraints }),
    },
  };
}

/**
 * Table column with type and annotations.
 *
 * @param input.name - Column name
 * @param input.type - Column data type (e.g., 'integer', 'varchar(255)')
 * @param input.pk - Is primary key
 * @param input.fk - Foreign key reference in "table.column" format
 * @param input.unique - Has unique constraint
 * @param input.notNull - Has NOT NULL constraint
 * @param input.default - Default value expression
 * @param input.indexed - Has index on this column
 * @param input.values - Enum or low cardinality values
 * @param input.stats - Column statistics (min, max, null fraction)
 *
 * @example
 * column({
 *   name: 'status',
 *   type: 'varchar',
 *   notNull: true,
 *   indexed: true,
 *   values: ['active', 'inactive', 'suspended'],
 * })
 */
export function column(input: {
  name: string;
  type: string;
  pk?: boolean;
  fk?: string;
  unique?: boolean;
  notNull?: boolean;
  default?: string;
  indexed?: boolean;
  values?: string[];
  stats?: {
    min?: string;
    max?: string;
    nullFraction?: number;
  };
}): ContextFragment {
  return {
    name: 'column',
    data: {
      name: input.name,
      type: input.type,
      ...(input.pk && { pk: true }),
      ...(input.fk && { fk: input.fk }),
      ...(input.unique && { unique: true }),
      ...(input.notNull && { notNull: true }),
      ...(input.default && { default: input.default }),
      ...(input.indexed && { indexed: true }),
      ...(input.values?.length && { values: input.values }),
      ...(input.stats && { stats: input.stats }),
    },
  };
}

/**
 * Table index.
 *
 * @param input.name - Index name
 * @param input.columns - Columns included in the index
 * @param input.unique - Is unique index
 * @param input.type - Index type (BTREE, HASH, GIN, etc.)
 *
 * @example
 * index({ name: 'idx_user_email', columns: ['email'], unique: true, type: 'BTREE' })
 */
export function index(input: {
  name: string;
  columns: string[];
  unique?: boolean;
  type?: string;
}): ContextFragment {
  return {
    name: 'index',
    data: {
      name: input.name,
      columns: input.columns,
      ...(input.unique && { unique: true }),
      ...(input.type && { type: input.type }),
    },
  };
}

/**
 * Table constraint (CHECK, UNIQUE, PRIMARY_KEY, FOREIGN_KEY, etc).
 *
 * @param input.name - Constraint name
 * @param input.type - Constraint type
 * @param input.columns - Columns involved in the constraint
 * @param input.definition - CHECK constraint SQL definition
 * @param input.defaultValue - DEFAULT constraint value
 * @param input.referencedTable - For FK: referenced table name
 * @param input.referencedColumns - For FK: referenced column names
 *
 * @example
 * constraint({
 *   name: 'chk_amount_positive',
 *   type: 'CHECK',
 *   definition: 'amount > 0',
 * })
 *
 * @example
 * constraint({
 *   name: 'fk_order_user',
 *   type: 'FOREIGN_KEY',
 *   columns: ['user_id'],
 *   referencedTable: 'users',
 *   referencedColumns: ['id'],
 * })
 */
export function constraint(input: {
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
}): ContextFragment {
  return {
    name: 'constraint',
    data: {
      name: input.name,
      type: input.type,
      ...(input.columns?.length && { columns: input.columns }),
      ...(input.definition && { definition: input.definition }),
      ...(input.defaultValue && { defaultValue: input.defaultValue }),
      ...(input.referencedTable && { referencedTable: input.referencedTable }),
      ...(input.referencedColumns?.length && {
        referencedColumns: input.referencedColumns,
      }),
    },
  };
}

/**
 * Database view.
 *
 * @param input.name - View name
 * @param input.schema - Schema name
 * @param input.columns - Array of column() fragments
 * @param input.definition - View SQL definition
 *
 * @example
 * view({
 *   name: 'active_users',
 *   columns: [
 *     column({ name: 'id', type: 'integer' }),
 *     column({ name: 'email', type: 'varchar' }),
 *   ],
 *   definition: "SELECT id, email FROM users WHERE status = 'active'",
 * })
 */
export function view(input: {
  name: string;
  schema?: string;
  columns: ContextFragment[];
  definition?: string;
}): ContextFragment {
  return {
    name: 'view',
    data: {
      name: input.name,
      ...(input.schema && { schema: input.schema }),
      columns: input.columns,
      ...(input.definition && { definition: input.definition }),
    },
  };
}

/**
 * Relationship between tables (foreign key connection).
 *
 * @param input.from - Source table and columns
 * @param input.to - Referenced table and columns
 * @param input.cardinality - Relationship cardinality
 *
 * @example
 * relationship({
 *   from: { table: 'orders', columns: ['user_id'] },
 *   to: { table: 'users', columns: ['id'] },
 *   cardinality: 'many-to-one',
 * })
 */
export function relationship(input: {
  from: { table: string; columns: string[] };
  to: { table: string; columns: string[] };
  cardinality?: 'one-to-one' | 'one-to-many' | 'many-to-one' | 'many-to-many';
}): ContextFragment {
  return {
    name: 'relationship',
    data: {
      from: input.from,
      to: input.to,
      ...(input.cardinality && { cardinality: input.cardinality }),
    },
  };
}
