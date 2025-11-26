import {
  Adapter,
  type AdapterInfo,
  type AdapterInfoProvider,
  type IntrospectOptions,
  type Introspection,
  type OnProgress,
  type Relationship,
  type Table,
} from './adapter.ts';

const SQL_ERROR_MAP: Array<{
  pattern: RegExp;
  type: string;
  hint: string;
}> = [
  {
    pattern: /^no such table: .+$/,
    type: 'MISSING_TABLE',
    hint: 'Check the database schema for the correct table name. The table you referenced does not exist.',
  },
  {
    pattern: /^no such column: .+$/,
    type: 'INVALID_COLUMN',
    hint: 'Check the table schema for correct column names. The column may not exist or is ambiguous (exists in multiple joined tables).',
  },
  {
    pattern: /^ambiguous column name: .+$/,
    type: 'INVALID_COLUMN',
    hint: 'Check the table schema for correct column names. The column may not exist or is ambiguous (exists in multiple joined tables).',
  },
  {
    pattern: /^near ".+": syntax error$/,
    type: 'SYNTAX_ERROR',
    hint: 'There is a SQL syntax error. Review the query structure, keywords, and punctuation.',
  },
  {
    pattern: /^no tables specified$/,
    type: 'SYNTAX_ERROR',
    hint: 'There is a SQL syntax error. Review the query structure, keywords, and punctuation.',
  },
  {
    pattern: /^attempt to write a readonly database$/,
    type: 'CONSTRAINT_ERROR',
    hint: 'A database constraint was violated. This should not happen with read-only queries.',
  },
];

type ExecuteFunction = (sql: string) => Promise<any> | any;
type ValidateFunction = (sql: string) => Promise<string | void> | string | void;
type IntrospectFunction = () => Promise<Introspection> | Introspection;

export type SqliteAdapterOptions = {
  execute: ExecuteFunction;
  validate?: ValidateFunction;
  introspect?: IntrospectFunction;
  info?: AdapterInfoProvider;
};

type TableNameRow = {
  name: string | null | undefined;
};

type ColumnRow = {
  name: string | null | undefined;
  type: string | null | undefined;
  pk?: number | null | undefined;
};

type IndexListRow = {
  seq?: number | null | undefined;
  name?: string | null | undefined;
  unique?: number | null | undefined;
  origin?: string | null | undefined;
};

type IndexInfoRow = {
  seqno?: number | null | undefined;
  cid?: number | null | undefined;
  name?: string | null | undefined;
};
type ForeignKeyRow = {
  id: number | null | undefined;
  table: string | null | undefined;
  from: string | null | undefined;
  to: string | null | undefined;
};

const LOW_CARDINALITY_LIMIT = 20;

export function formatError(sql: string, error: unknown) {
  const errorMessage =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : 'Unknown error occurred';
  const errorInfo = SQL_ERROR_MAP.find((it) => it.pattern.test(errorMessage));

  if (!errorInfo) {
    return {
      error: errorMessage,
      error_type: 'UNKNOWN_ERROR',
      suggestion: 'Review the query and try again',
      sql_attempted: sql,
    };
  }

  return {
    error: errorMessage,
    error_type: errorInfo.type,
    suggestion: errorInfo.hint,
    sql_attempted: sql,
  };
}

export class Sqlite extends Adapter {
  #options: SqliteAdapterOptions;
  #introspection: Introspection | null = null;
  #info: AdapterInfo | null = null;

  constructor(options: SqliteAdapterOptions) {
    super();
    if (!options || typeof options.execute !== 'function') {
      throw new Error('Sqlite adapter requires an execute function.');
    }
    this.#options = options;
  }

  override async introspect(options?: IntrospectOptions): Promise<Introspection> {
    const onProgress = options?.onProgress;

    if (this.#introspection) {
      return this.#introspection;
    }

    if (this.#options.introspect) {
      this.#introspection = await this.#options.introspect();
      return this.#introspection;
    }

    onProgress?.({ phase: 'tables', message: 'Loading table names...' });
    const tableNames = await this.#getTableNames();
    onProgress?.({
      phase: 'tables',
      message: `Found ${tableNames.length} tables, loading schemas...`,
      total: tableNames.length,
    });
    const tables = await this.#loadTables(tableNames);
    onProgress?.({
      phase: 'tables',
      message: `Loaded ${tables.length} tables`,
      total: tables.length,
    });

    onProgress?.({ phase: 'row_counts', message: 'Counting table rows...' });
    await this.#annotateRowCounts(tables, onProgress);

    onProgress?.({ phase: 'column_stats', message: 'Collecting column statistics...' });
    await this.#annotateColumnStats(tables, onProgress);

    onProgress?.({ phase: 'indexes', message: 'Loading index information...' });
    await this.#annotateIndexes(tables, onProgress);

    onProgress?.({ phase: 'low_cardinality', message: 'Identifying low cardinality columns...' });
    await this.#annotateLowCardinalityColumns(tables, onProgress);

    onProgress?.({ phase: 'relationships', message: 'Loading foreign key relationships...' });
    const relationships = await this.#loadRelationships(tableNames);
    onProgress?.({
      phase: 'relationships',
      message: `Loaded ${relationships.length} relationships`,
    });

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
      return JSON.stringify(formatError(sql, error));
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

  async #getTableNames(): Promise<string[]> {
    const rows = await this.#runQuery<TableNameRow>(
      `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`,
    );

    return rows
      .map((row) => row.name)
      .filter(
        (name): name is string =>
          typeof name === 'string' && !name.startsWith('sqlite_'),
      );
  }

  async #loadTables(tableNames: string[]): Promise<Table[]> {
    const tables = await Promise.all(
      tableNames.map(async (tableName) => {
        const columns = await this.#runQuery<ColumnRow>(
          `PRAGMA table_info(${this.#quoteIdentifier(tableName)})`,
        );

        return {
          name: tableName,
          rawName: tableName,
          columns: columns.map((col) => ({
            name: col.name ?? 'unknown',
            type: col.type ?? 'unknown',
            isPrimaryKey: (col.pk ?? 0) > 0,
          })),
        };
      }),
    );

    return tables;
  }

  async #loadRelationships(tableNames: string[]): Promise<Relationship[]> {
    const relationshipGroups = await Promise.all(
      tableNames.map(async (tableName) => {
        const rows = await this.#runQuery<ForeignKeyRow>(
          `PRAGMA foreign_key_list(${this.#quoteIdentifier(tableName)})`,
        );

        const groups = new Map<number, Relationship>();

        for (const row of rows) {
          if (
            row.id == null ||
            row.table == null ||
            row.from == null ||
            row.to == null
          ) {
            continue;
          }

          const id = Number(row.id);
          const existing = groups.get(id);
          if (!existing) {
            groups.set(id, {
              table: tableName,
              from: [String(row.from)],
              referenced_table: String(row.table),
              to: [String(row.to)],
            });
          } else {
            existing.from.push(String(row.from));
            existing.to.push(String(row.to));
          }
        }

        return Array.from(groups.values());
      }),
    );

    return relationshipGroups.flat();
  }

  async #annotateRowCounts(tables: Table[], onProgress?: OnProgress) {
    const total = tables.length;
    for (let i = 0; i < tables.length; i++) {
      const table = tables[i];
      const tableIdentifier = this.#formatTableIdentifier(table);
      onProgress?.({
        phase: 'row_counts',
        message: `Counting rows in ${table.name}...`,
        current: i + 1,
        total,
      });
      try {
        const rows = await this.#runQuery<{ count: number | string | bigint }>(
          `SELECT COUNT(*) as count FROM ${tableIdentifier}`,
        );
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

  async #annotateColumnStats(tables: Table[], onProgress?: OnProgress) {
    const total = tables.length;
    for (let i = 0; i < tables.length; i++) {
      const table = tables[i];
      const tableIdentifier = this.#formatTableIdentifier(table);
      onProgress?.({
        phase: 'column_stats',
        message: `Collecting stats for ${table.name}...`,
        current: i + 1,
        total,
      });
      for (const column of table.columns) {
        if (!this.#shouldCollectStats(column.type)) {
          continue;
        }
        const columnIdentifier = this.#quoteSqlIdentifier(column.name);
        const sql = `
          SELECT
            MIN(${columnIdentifier}) AS min_value,
            MAX(${columnIdentifier}) AS max_value,
            AVG(CASE WHEN ${columnIdentifier} IS NULL THEN 1.0 ELSE 0.0 END) AS null_fraction
          FROM ${tableIdentifier}
        `;
        try {
          const rows = await this.#runQuery<{
            min_value: unknown;
            max_value: unknown;
            null_fraction: number | string | null;
          }>(sql);
          if (!rows.length) {
            continue;
          }
          const min = this.#normalizeValue(rows[0]?.min_value);
          const max = this.#normalizeValue(rows[0]?.max_value);
          const nullFraction = this.#toNumber(rows[0]?.null_fraction);
          if (min != null || max != null || nullFraction != null) {
            column.stats = {
              min: min ?? undefined,
              max: max ?? undefined,
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

  async #annotateIndexes(tables: Table[], onProgress?: OnProgress) {
    const total = tables.length;
    for (let i = 0; i < tables.length; i++) {
      const table = tables[i];
      const tableIdentifier = this.#quoteIdentifier(table.rawName ?? table.name);
      onProgress?.({
        phase: 'indexes',
        message: `Loading indexes for ${table.name}...`,
        current: i + 1,
        total,
      });
      let indexes: Table['indexes'] = [];
      try {
        const indexList = await this.#runQuery<IndexListRow>(
          `PRAGMA index_list(${tableIdentifier})`,
        );
        indexes = await Promise.all(
          indexList
            .filter((index) => index.name)
            .map(async (index) => {
              const indexName = String(index.name);
              const indexInfo = await this.#runQuery<IndexInfoRow>(
                `PRAGMA index_info('${indexName.replace(/'/g, "''")}')`,
              );
              const columns = indexInfo
                .map((col) => col.name)
                .filter((name): name is string => Boolean(name));
              for (const columnName of columns) {
                const column = table.columns.find((col) => col.name === columnName);
                if (column) {
                  column.isIndexed = true;
                }
              }
              return {
                name: indexName,
                columns,
                unique: index.unique === 1,
                primary: index.origin === 'pk',
                type: index.origin ?? undefined,
              };
            }),
        );
      } catch {
        indexes = [];
      }
      if (indexes.length) {
        table.indexes = indexes;
      }
    }
  }

  async #annotateLowCardinalityColumns(tables: Table[], onProgress?: OnProgress) {
    const total = tables.length;
    for (let i = 0; i < tables.length; i++) {
      const table = tables[i];
      const tableIdentifier = this.#formatTableIdentifier(table);
      onProgress?.({
        phase: 'low_cardinality',
        message: `Analyzing cardinality in ${table.name}...`,
        current: i + 1,
        total,
      });
      for (const column of table.columns) {
        const columnIdentifier = this.#quoteSqlIdentifier(column.name);
        // add one to the limit to detect if it exceeds the limit
        const limit = LOW_CARDINALITY_LIMIT + 1;
        const sql = `
          SELECT DISTINCT ${columnIdentifier} AS value
          FROM ${tableIdentifier}
          WHERE ${columnIdentifier} IS NOT NULL
          LIMIT ${limit}
        `;

        let rows: Array<{ value: unknown }> = [];
        try {
          rows = await this.#runQuery<{ value: unknown }>(sql);
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

  #quoteIdentifier(name: string) {
    return `'${name.replace(/'/g, "''")}'`;
  }

  #quoteSqlIdentifier(identifier: string) {
    return `"${identifier.replace(/"/g, '""')}"`;
  }

  #formatTableIdentifier(table: Table) {
    const name = table.rawName ?? table.name;
    if (table.schema) {
      return `${this.#quoteSqlIdentifier(table.schema)}.${this.#quoteSqlIdentifier(name)}`;
    }
    return this.#quoteSqlIdentifier(name);
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

  #shouldCollectStats(type: string | undefined) {
    if (!type) {
      return false;
    }
    const normalized = type.toLowerCase();
    return /int|real|numeric|double|float|decimal|date|time|bool/.test(
      normalized,
    );
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

  async #runQuery<Row>(sql: string): Promise<Row[]> {
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
      'Sqlite adapter execute() must return an array of rows or an object with a rows array when introspecting.',
    );
  }

  async #resolveInfo(): Promise<AdapterInfo> {
    const { info } = this.#options;
    if (!info) {
      return { dialect: 'sqlite' };
    }
    if (typeof info === 'function') {
      return info();
    }
    return info;
  }
}
