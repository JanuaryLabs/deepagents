import {
  Adapter,
  type AdapterInfo,
  type AdapterInfoProvider,
  type Introspection,
  type Relationship,
  type Table,
  type TableIndex,
} from './adapter.ts';

type ExecuteFunction = (sql: string) => Promise<any> | any;
type ValidateFunction = (sql: string) => Promise<string | void> | string | void;
type IntrospectFunction = () => Promise<Introspection> | Introspection;

export type PostgresAdapterOptions = {
  execute: ExecuteFunction;
  validate?: ValidateFunction;
  introspect?: IntrospectFunction;
  schemas?: string[];
  info?: AdapterInfoProvider;
};

type TableRow = {
  table_schema: string | null;
  table_name: string | null;
  column_name: string | null;
  data_type: string | null;
};

type RelationshipRow = {
  table_schema: string | null;
  table_name: string | null;
  column_name: string | null;
  foreign_table_schema: string | null;
  foreign_table_name: string | null;
  foreign_column_name: string | null;
  constraint_name: string | null;
};

type PrimaryKeyRow = {
  table_schema: string | null;
  table_name: string | null;
  column_name: string | null;
};

type IndexRow = {
  table_schema: string | null;
  table_name: string | null;
  index_name: string | null;
  column_name: string | null;
  indisunique: boolean | null;
  indisprimary: boolean | null;
  indisclustered: boolean | null;
  method: string | null;
};

const POSTGRES_ERROR_MAP: Record<string, { type: string; hint: string }> = {
  '42P01': {
    type: 'MISSING_TABLE',
    hint: 'Check the database schema for the correct table name. Include the schema prefix if necessary.',
  },
  '42703': {
    type: 'INVALID_COLUMN',
    hint: 'Verify the column exists on the referenced table and use table aliases to disambiguate.',
  },
  '42601': {
    type: 'SYNTAX_ERROR',
    hint: 'There is a SQL syntax error. Review keywords, punctuation, and the overall query shape.',
  },
  '42P10': {
    type: 'INVALID_COLUMN',
    hint: 'Columns referenced in GROUP BY/SELECT must exist. Double-check the column names and aliases.',
  },
  '42883': {
    type: 'INVALID_FUNCTION',
    hint: 'The function or operator you used is not recognized. Confirm its name and argument types.',
  },
};

const LOW_CARDINALITY_LIMIT = 20;

function isPostgresError(
  error: unknown,
): error is { code?: string; message?: string } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof (error as { code?: unknown }).code === 'string'
  );
}

export function formatPostgresError(sql: string, error: unknown) {
  const errorMessage =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : 'Unknown error occurred';

  if (isPostgresError(error)) {
    const metadata = POSTGRES_ERROR_MAP[error.code ?? ''];
    if (metadata) {
      return {
        error: errorMessage,
        error_type: metadata.type,
        suggestion: metadata.hint,
        sql_attempted: sql,
      };
    }
  }

  return {
    error: errorMessage,
    error_type: 'UNKNOWN_ERROR',
    suggestion: 'Review the query and try again',
    sql_attempted: sql,
  };
}

export class Postgres extends Adapter {
  #options: PostgresAdapterOptions;
  #introspection: Introspection | null = null;
  #info: AdapterInfo | null = null;

  constructor(options: PostgresAdapterOptions) {
    super();
    if (!options || typeof options.execute !== 'function') {
      throw new Error('Postgres adapter requires an execute function.');
    }
    this.#options = {
      ...options,
      schemas: options.schemas?.length ? options.schemas : undefined,
    };
  }

  override async introspect(): Promise<Introspection> {
    if (this.#introspection) {
      return this.#introspection;
    }

    if (this.#options.introspect) {
      this.#introspection = await this.#options.introspect();
      return this.#introspection;
    }

    const tables = await this.#loadTables();
    await this.#annotateRowCounts(tables);
    await this.#annotatePrimaryKeys(tables);
    await this.#annotateIndexes(tables);
    await this.#annotateColumnStats(tables);
    await this.#annotateLowCardinalityColumns(tables);
    const relationships = await this.#loadRelationships();

    this.#introspection = { tables, relationships };
    return this.#introspection;
  }

  override async execute(sql: string) {
    return this.#options.execute(sql);
  }

  override async validate(sql: string) {
    const validator: ValidateFunction =
      this.#options.validate ??
      (async (text: string) => {
        await this.#options.execute(`EXPLAIN ${text}`);
      });

    try {
      return await validator(sql);
    } catch (error) {
      return JSON.stringify(formatPostgresError(sql, error));
    }
  }

  override async info(): Promise<AdapterInfo> {
    if (this.#info) {
      return this.#info;
    }
    this.#info = await this.#resolveInfo();
    return this.#info;
  }

  override formatInfo(info: AdapterInfo): string {
    const lines = [`Dialect: ${info.dialect ?? 'unknown'}`];
    if (info.version) {
      lines.push(`Version: ${info.version}`);
    }
    if (info.database) {
      lines.push(`Database: ${info.database}`);
    }
    if (info.host) {
      lines.push(`Host: ${info.host}`);
    }
    if (info.details && Object.keys(info.details).length) {
      lines.push(`Details: ${JSON.stringify(info.details)}`);
    }
    return lines.join('\n');
  }

  async #loadTables(): Promise<Table[]> {
    const rows = await this.#runIntrospectionQuery<TableRow>(`
      SELECT
        c.table_schema,
        c.table_name,
        c.column_name,
        c.data_type
      FROM information_schema.columns AS c
      JOIN information_schema.tables AS t
        ON c.table_schema = t.table_schema
        AND c.table_name = t.table_name
      WHERE t.table_type = 'BASE TABLE'
        ${this.#buildSchemaFilter('c.table_schema')}
      ORDER BY c.table_schema, c.table_name, c.ordinal_position
    `);

    const tables = new Map<string, Table>();

    for (const row of rows) {
      if (!row.table_name) {
        continue;
      }
      const schema = row.table_schema ?? 'public';
      const tableName = row.table_name;
      const qualifiedName = `${schema}.${tableName}`;
      const table = tables.get(qualifiedName) ?? {
        name: qualifiedName,
        schema,
        rawName: tableName,
        columns: [],
      };
      table.columns.push({
        name: row.column_name ?? 'unknown',
        type: row.data_type ?? 'unknown',
      });
      tables.set(qualifiedName, table);
    }

    return Array.from(tables.values());
  }

  async #loadRelationships(): Promise<Relationship[]> {
    const rows = await this.#runIntrospectionQuery<RelationshipRow>(`
      SELECT
        tc.constraint_name,
        tc.table_schema,
        tc.table_name,
        kcu.column_name,
        ccu.table_schema AS foreign_table_schema,
        ccu.table_name AS foreign_table_name,
        ccu.column_name AS foreign_column_name
      FROM information_schema.table_constraints AS tc
      JOIN information_schema.key_column_usage AS kcu
        ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
      JOIN information_schema.constraint_column_usage AS ccu
        ON ccu.constraint_name = tc.constraint_name
        AND ccu.table_schema = tc.table_schema
      WHERE tc.constraint_type = 'FOREIGN KEY'
        ${this.#buildSchemaFilter('tc.table_schema')}
      ORDER BY tc.table_schema, tc.table_name, tc.constraint_name, kcu.ordinal_position
    `);

    const relationships = new Map<string, Relationship>();

    for (const row of rows) {
      if (!row.table_name || !row.foreign_table_name || !row.constraint_name) {
        continue;
      }

      const schema = row.table_schema ?? 'public';
      const referencedSchema = row.foreign_table_schema ?? 'public';
      const key = `${schema}.${row.table_name}:${row.constraint_name}`;

      const relationship = relationships.get(key) ?? {
        table: `${schema}.${row.table_name}`,
        from: [],
        referenced_table: `${referencedSchema}.${row.foreign_table_name}`,
        to: [],
      };

      relationship.from.push(row.column_name ?? 'unknown');
      relationship.to.push(row.foreign_column_name ?? 'unknown');

      relationships.set(key, relationship);
    }

    return Array.from(relationships.values());
  }

  async #annotateRowCounts(tables: Table[]) {
    for (const table of tables) {
      const tableIdentifier = this.#formatQualifiedTableName(table);
      try {
        const rows = await this.#runIntrospectionQuery<{
          count: number | string | bigint | null;
        }>(`SELECT COUNT(*) as count FROM ${tableIdentifier}`);
        const rowCount = this.#toNumber(rows[0]?.count);
        if (rowCount != null) {
          table.rowCount = rowCount;
          table.sizeHint = this.#classifyRowCount(rowCount);
        }
      } catch {
        continue;
      }
    }
  }

  async #annotatePrimaryKeys(tables: Table[]) {
    if (!tables.length) {
      return;
    }
    const tableMap = new Map(tables.map((table) => [table.name, table]));
    const rows = await this.#runIntrospectionQuery<PrimaryKeyRow>(`
      SELECT
        tc.table_schema,
        tc.table_name,
        kcu.column_name
      FROM information_schema.table_constraints AS tc
      JOIN information_schema.key_column_usage AS kcu
        ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
      WHERE tc.constraint_type = 'PRIMARY KEY'
        ${this.#buildSchemaFilter('tc.table_schema')}
    `);
    for (const row of rows) {
      if (!row.table_name) {
        continue;
      }
      const schema = row.table_schema ?? 'public';
      const qualifiedName = `${schema}.${row.table_name}`;
      const table = tableMap.get(qualifiedName);
      if (!table) {
        continue;
      }
      const column = table.columns.find(
        (col) => col.name === row.column_name,
      );
      if (column) {
        column.isPrimaryKey = true;
      }
    }
  }

  async #annotateIndexes(tables: Table[]) {
    if (!tables.length) {
      return;
    }
    const tableMap = new Map(tables.map((table) => [table.name, table]));
    const rows = await this.#runIntrospectionQuery<IndexRow>(`
      SELECT
        n.nspname AS table_schema,
        t.relname AS table_name,
        i.relname AS index_name,
        a.attname AS column_name,
        ix.indisunique,
        ix.indisprimary,
        ix.indisclustered,
        am.amname AS method
      FROM pg_index ix
      JOIN pg_class t ON t.oid = ix.indrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      JOIN pg_class i ON i.oid = ix.indexrelid
      JOIN pg_am am ON am.oid = i.relam
      LEFT JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY AS key(attnum, ordinality) ON TRUE
      LEFT JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = key.attnum
      WHERE t.relkind = 'r'
        ${this.#buildSchemaFilter('n.nspname')}
      ORDER BY n.nspname, t.relname, i.relname, key.ordinality
    `);

    const indexMap = new Map<string, TableIndex>();

    for (const row of rows) {
      if (!row.table_name || !row.index_name) {
        continue;
      }
      const schema = row.table_schema ?? 'public';
      const tableKey = `${schema}.${row.table_name}`;
      const table = tableMap.get(tableKey);
      if (!table) {
        continue;
      }
      const indexKey = `${tableKey}:${row.index_name}`;
      let index = indexMap.get(indexKey);
      if (!index) {
        index = {
          name: row.index_name,
          columns: [],
          unique: Boolean(row.indisunique ?? false),
          primary: Boolean(row.indisprimary ?? false),
          type: row.indisclustered ? 'clustered' : row.method ?? undefined,
        };
        indexMap.set(indexKey, index);
        if (!table.indexes) {
          table.indexes = [];
        }
        table.indexes.push(index);
      }
      if (row.column_name) {
        index.columns.push(row.column_name);
        const column = table.columns.find((col) => col.name === row.column_name);
        if (column) {
          column.isIndexed = true;
        }
      }
    }
  }

  async #annotateColumnStats(tables: Table[]) {
    if (!tables.length) {
      return;
    }
    for (const table of tables) {
      const tableIdentifier = this.#formatQualifiedTableName(table);
      for (const column of table.columns) {
        if (!this.#shouldCollectStats(column.type)) {
          continue;
        }
        const columnIdentifier = this.#quoteIdentifier(column.name);
        const sql = `
          SELECT
            MIN(${columnIdentifier})::text AS min_value,
            MAX(${columnIdentifier})::text AS max_value,
            AVG(CASE WHEN ${columnIdentifier} IS NULL THEN 1.0 ELSE 0.0 END)::float AS null_fraction
          FROM ${tableIdentifier}
        `;
        try {
          const rows = await this.#runIntrospectionQuery<{
            min_value: string | null;
            max_value: string | null;
            null_fraction: number | string | null;
          }>(sql);
          if (!rows.length) {
            continue;
          }
          const min = rows[0]?.min_value ?? undefined;
          const max = rows[0]?.max_value ?? undefined;
          const nullFraction = this.#toNumber(rows[0]?.null_fraction);
          if (min != null || max != null || nullFraction != null) {
            column.stats = {
              min,
              max,
              nullFraction:
                nullFraction != null && Number.isFinite(nullFraction)
                  ? Math.max(0, Math.min(1, nullFraction))
                  : undefined,
            };
          }
        } catch {
          continue;
        }
      }
    }
  }

  async #annotateLowCardinalityColumns(tables: Table[]) {
    for (const table of tables) {
      const tableIdentifier = this.#formatQualifiedTableName(table);
      for (const column of table.columns) {
        const columnIdentifier = this.#quoteIdentifier(column.name);
        const limit = LOW_CARDINALITY_LIMIT + 1;
        const sql = `
          SELECT DISTINCT ${columnIdentifier} AS value
          FROM ${tableIdentifier}
          WHERE ${columnIdentifier} IS NOT NULL
          LIMIT ${limit}
        `;

        let rows: Array<{ value: unknown }> = [];
        try {
          rows = await this.#runIntrospectionQuery<{ value: unknown }>(sql);
        } catch {
          continue;
        }

        if (!rows.length || rows.length > LOW_CARDINALITY_LIMIT) {
          continue;
        }

        const values: string[] = [];
        let shouldSkip = false;
        for (const row of rows) {
          const formatted = this.#normalizeValue(row.value);
          if (formatted == null) {
            shouldSkip = true;
            break;
          }
          values.push(formatted);
        }

        if (shouldSkip || !values.length) {
          continue;
        }

        column.kind = 'LowCardinality';
        column.values = values;
      }
    }
  }

  #buildSchemaFilter(columnName: string) {
    if (this.#options.schemas && this.#options.schemas.length > 0) {
      const values = this.#options.schemas
        .map((schema) => `'${schema.replace(/'/g, "''")}'`)
        .join(', ');
      return `AND ${columnName} IN (${values})`;
    }

    return `AND ${columnName} NOT IN ('pg_catalog', 'information_schema')`;
  }

  async #runIntrospectionQuery<Row>(sql: string): Promise<Row[]> {
    const result = await this.#options.execute(sql);

    if (Array.isArray(result)) {
      return result as Row[];
    }

    if (
      result &&
      typeof result === 'object' &&
      'rows' in result &&
      Array.isArray((result as { rows?: unknown }).rows)
    ) {
      return (result as { rows: Row[] }).rows;
    }

    throw new Error(
      'Postgres adapter execute() must return an array of rows or an object with a rows array when introspecting.',
    );
  }

  #quoteIdentifier(name: string) {
    return `"${name.replace(/"/g, '""')}"`;
  }

  #formatQualifiedTableName(table: Table) {
    if (table.schema && table.rawName) {
      return `${this.#quoteIdentifier(table.schema)}.${this.#quoteIdentifier(table.rawName)}`;
    }

    if (table.name.includes('.')) {
      const [schemaPart, ...rest] = table.name.split('.');
      const tablePart = rest.join('.') || schemaPart;
      if (rest.length === 0) {
        return this.#quoteIdentifier(schemaPart);
      }
      return `${this.#quoteIdentifier(schemaPart)}.${this.#quoteIdentifier(tablePart)}`;
    }

    return this.#quoteIdentifier(table.name);
  }

  #toNumber(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === 'bigint') {
      return Number(value);
    }
    if (typeof value === 'string' && value.trim() !== '') {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  }

  #shouldCollectStats(type: string | undefined) {
    if (!type) {
      return false;
    }
    const normalized = type.toLowerCase();
    return /int|numeric|decimal|double|real|money|date|time|timestamp|bool/.test(
      normalized,
    );
  }

  #classifyRowCount(count: number): Table['sizeHint'] {
    if (count < 100) {
      return 'tiny';
    }
    if (count < 1000) {
      return 'small';
    }
    if (count < 10000) {
      return 'medium';
    }
    if (count < 100000) {
      return 'large';
    }
    return 'huge';
  }

  #normalizeValue(value: unknown): string | null {
    if (value === null || value === undefined) {
      return null;
    }
    if (typeof value === 'string') {
      return value;
    }
    if (typeof value === 'number' || typeof value === 'bigint') {
      return String(value);
    }
    if (typeof value === 'boolean') {
      return value ? 'true' : 'false';
    }
    if (value instanceof Date) {
      return value.toISOString();
    }
    if (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) {
      return value.toString('utf-8');
    }
    return null;
  }

  async #resolveInfo(): Promise<AdapterInfo> {
    const { info } = this.#options;
    if (!info) {
      return { dialect: 'postgresql' };
    }
    if (typeof info === 'function') {
      return info();
    }
    return info;
  }
}
