import {
  Adapter,
  type ExecuteFunction,
  type GroundingFn,
  type OnProgress,
  type Relationship,
  type Table,
  type TableIndex,
  type ValidateFunction,
} from '../adapter.ts';

export type SqlServerAdapterOptions = {
  execute: ExecuteFunction;
  validate?: ValidateFunction;
  grounding: GroundingFn[];
  schemas?: string[];
};

type ColumnRow = {
  table_schema: string | null;
  table_name: string | null;
  column_name: string | null;
  data_type: string | null;
};

type RelationshipRow = {
  constraint_name: string | null;
  table_schema: string | null;
  table_name: string | null;
  column_name: string | null;
  referenced_table_schema: string | null;
  referenced_table_name: string | null;
  referenced_column_name: string | null;
};

type PrimaryKeyRow = {
  table_schema: string | null;
  table_name: string | null;
  column_name: string | null;
};

type IndexRow = {
  schema_name: string | null;
  table_name: string | null;
  index_name: string | null;
  column_name: string | null;
  is_unique: boolean | number | null;
  is_primary_key: boolean | number | null;
  type_desc: string | null;
  is_included_column: boolean | number | null;
};

const SQL_SERVER_ERROR_MAP: Record<string, { type: string; hint: string }> = {
  '208': {
    type: 'MISSING_TABLE',
    hint: 'Check that the table exists and include the schema prefix (e.g., dbo.TableName).',
  },
  '207': {
    type: 'INVALID_COLUMN',
    hint: 'Verify the column exists on the table and that any aliases are referenced correctly.',
  },
  '156': {
    type: 'SYNTAX_ERROR',
    hint: 'There is a SQL syntax error. Review keywords, punctuation, and clauses such as GROUP BY.',
  },
  '4104': {
    type: 'INVALID_COLUMN',
    hint: 'Columns must be qualified with table aliases when ambiguous. Double-check join aliases.',
  },
  '1934': {
    type: 'CONSTRAINT_ERROR',
    hint: 'The query violates a constraint. Re-check join logic and filtering.',
  },
};

const LOW_CARDINALITY_LIMIT = 20;

function getErrorCode(error: unknown) {
  if (
    typeof error === 'object' &&
    error !== null &&
    'number' in error &&
    typeof (error as { number?: unknown }).number === 'number'
  ) {
    return String((error as { number: number }).number);
  }

  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof (error as { code?: unknown }).code === 'string'
  ) {
    return (error as { code: string }).code;
  }

  return null;
}

export function formatSqlServerError(sql: string, error: unknown) {
  const errorMessage =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : 'Unknown error occurred';

  const code = getErrorCode(error);
  const metadata = code ? SQL_SERVER_ERROR_MAP[code] : undefined;

  if (metadata) {
    return {
      error: errorMessage,
      error_type: metadata.type,
      suggestion: metadata.hint,
      sql_attempted: sql,
    };
  }

  return {
    error: errorMessage,
    error_type: 'UNKNOWN_ERROR',
    suggestion: 'Review the query and try again',
    sql_attempted: sql,
  };
}

export class SqlServer extends Adapter {
  #options: SqlServerAdapterOptions;
  override readonly grounding: GroundingFn[];
  override readonly defaultSchema = 'dbo';
  override readonly systemSchemas = ['INFORMATION_SCHEMA', 'sys'];
  override readonly formatterLanguage = 'transactsql';

  constructor(options: SqlServerAdapterOptions) {
    super();
    if (!options || typeof options.execute !== 'function') {
      throw new Error('SqlServer adapter requires an execute function.');
    }
    this.#options = {
      ...options,
      schemas: options.schemas?.length ? options.schemas : undefined,
    };
    this.grounding = options.grounding;
  }

  override async execute(sql: string) {
    return this.#options.execute(sql);
  }

  override async validate(sql: string) {
    const validator: ValidateFunction =
      this.#options.validate ??
      (async (text: string) => {
        await this.#options.execute(
          `SET PARSEONLY ON; ${text}; SET PARSEONLY OFF;`,
        );
      });

    try {
      return await validator(sql);
    } catch (error) {
      return JSON.stringify(formatSqlServerError(sql, error));
    }
  }

  override async runQuery<Row>(sql: string): Promise<Row[]> {
    return this.#runIntrospectionQuery<Row>(sql);
  }

  override quoteIdentifier(name: string): string {
    return `[${name.replace(/]/g, ']]')}]`;
  }

  override escape(value: string): string {
    return value.replace(/]/g, ']]');
  }

  override buildSampleRowsQuery(
    tableName: string,
    columns: string[] | undefined,
    limit: number,
  ): string {
    const { schema, table } = this.parseTableName(tableName);
    const tableIdentifier = `${this.quoteIdentifier(schema)}.${this.quoteIdentifier(table)}`;
    const columnList = columns?.length
      ? columns.map((c) => this.quoteIdentifier(c)).join(', ')
      : '*';
    return `SELECT TOP ${limit} ${columnList} FROM ${tableIdentifier}`;
  }

  async #loadTables(): Promise<Table[]> {
    const rows = await this.#runIntrospectionQuery<ColumnRow>(`
      SELECT
        c.TABLE_SCHEMA AS table_schema,
        c.TABLE_NAME AS table_name,
        c.COLUMN_NAME AS column_name,
        c.DATA_TYPE AS data_type
      FROM INFORMATION_SCHEMA.COLUMNS AS c
      JOIN INFORMATION_SCHEMA.TABLES AS t
        ON c.TABLE_SCHEMA = t.TABLE_SCHEMA
        AND c.TABLE_NAME = t.TABLE_NAME
      WHERE t.TABLE_TYPE = 'BASE TABLE'
        ${this.#buildSchemaFilter('c.TABLE_SCHEMA')}
      ORDER BY c.TABLE_SCHEMA, c.TABLE_NAME, c.ORDINAL_POSITION
    `);

    const tables = new Map<string, Table>();

    for (const row of rows) {
      if (!row.table_name) {
        continue;
      }
      const schema = row.table_schema ?? 'dbo';
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

  async #loadRelationships(
    filterTableNames?: string[],
  ): Promise<Relationship[]> {
    const tableFilter = this.#buildTableNamesFilter(filterTableNames);
    const rows = await this.#runIntrospectionQuery<RelationshipRow>(`
      SELECT
        fk.CONSTRAINT_NAME AS constraint_name,
        fk.TABLE_SCHEMA AS table_schema,
        fk.TABLE_NAME AS table_name,
        fk.COLUMN_NAME AS column_name,
        pk.TABLE_SCHEMA AS referenced_table_schema,
        pk.TABLE_NAME AS referenced_table_name,
        pk.COLUMN_NAME AS referenced_column_name
      FROM INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS AS rc
      JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE AS fk
        ON fk.CONSTRAINT_NAME = rc.CONSTRAINT_NAME
      JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE AS pk
        ON pk.CONSTRAINT_NAME = rc.UNIQUE_CONSTRAINT_NAME
        AND pk.ORDINAL_POSITION = fk.ORDINAL_POSITION
      WHERE 1 = 1
        ${this.#buildSchemaFilter('fk.TABLE_SCHEMA')}
        ${tableFilter}
      ORDER BY fk.TABLE_SCHEMA, fk.TABLE_NAME, fk.CONSTRAINT_NAME, fk.ORDINAL_POSITION
    `);

    const relationships = new Map<string, Relationship>();

    for (const row of rows) {
      if (
        !row.constraint_name ||
        !row.table_name ||
        !row.referenced_table_name
      ) {
        continue;
      }

      const schema = row.table_schema ?? 'dbo';
      const referencedSchema = row.referenced_table_schema ?? 'dbo';
      const key = `${schema}.${row.table_name}:${row.constraint_name}`;

      const relationship = relationships.get(key) ?? {
        table: `${schema}.${row.table_name}`,
        from: [],
        referenced_table: `${referencedSchema}.${row.referenced_table_name}`,
        to: [],
      };

      relationship.from.push(row.column_name ?? 'unknown');
      relationship.to.push(row.referenced_column_name ?? 'unknown');

      relationships.set(key, relationship);
    }

    return Array.from(relationships.values());
  }

  async #annotateRowCounts(tables: Table[], onProgress?: OnProgress) {
    const total = tables.length;
    for (let i = 0; i < tables.length; i++) {
      const table = tables[i];
      const tableIdentifier = this.#formatQualifiedTableName(table);
      onProgress?.({
        phase: 'row_counts',
        message: `Counting rows in ${table.name}...`,
        current: i + 1,
        total,
      });
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

  /**
   * @deprecated Primary keys are now handled via constraints grounding.
   * This method is kept for backward compatibility but does nothing.
   */
  async #annotatePrimaryKeys(_tables: Table[]) {
    // Primary keys are now derived from constraints, not stored on columns.
    // See ConstraintGrounding for the new approach.
  }

  async #annotateIndexes(tables: Table[]) {
    if (!tables.length) {
      return;
    }
    const tableMap = new Map(tables.map((table) => [table.name, table]));
    const rows = await this.#runIntrospectionQuery<IndexRow>(`
      SELECT
        sch.name AS schema_name,
        t.name AS table_name,
        ind.name AS index_name,
        col.name AS column_name,
        ind.is_unique,
        ind.is_primary_key,
        ind.type_desc,
        ic.is_included_column
      FROM sys.indexes AS ind
      JOIN sys.tables AS t ON ind.object_id = t.object_id
      JOIN sys.schemas AS sch ON t.schema_id = sch.schema_id
      JOIN sys.index_columns AS ic
        ON ind.object_id = ic.object_id
        AND ind.index_id = ic.index_id
      JOIN sys.columns AS col
        ON ic.object_id = col.object_id
        AND ic.column_id = col.column_id
      WHERE ind.is_hypothetical = 0
        AND ind.name IS NOT NULL
        ${this.#buildSchemaFilter('sch.name')}
      ORDER BY sch.name, t.name, ind.name, ic.key_ordinal
    `);

    const indexMap = new Map<string, TableIndex>();

    for (const row of rows) {
      if (!row.table_name || !row.index_name) {
        continue;
      }
      const schema = row.schema_name ?? 'dbo';
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
          unique: Boolean(row.is_unique),
          type: row.type_desc ?? undefined,
        };
        indexMap.set(indexKey, index);
        if (!table.indexes) {
          table.indexes = [];
        }
        table.indexes.push(index);
      }
      if (row.is_included_column) {
        continue;
      }
      if (row.column_name) {
        index!.columns.push(row.column_name);
        const column = table.columns.find(
          (col) => col.name === row.column_name,
        );
        if (column) {
          column.isIndexed = true;
        }
      }
    }
  }

  async #annotateColumnStats(tables: Table[], onProgress?: OnProgress) {
    if (!tables.length) {
      return;
    }
    const total = tables.length;
    for (let i = 0; i < tables.length; i++) {
      const table = tables[i];
      const tableIdentifier = this.#formatQualifiedTableName(table);
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
        const columnIdentifier = this.#quoteIdentifier(column.name);
        const sql = `
          SELECT
            CONVERT(NVARCHAR(4000), MIN(${columnIdentifier})) AS min_value,
            CONVERT(NVARCHAR(4000), MAX(${columnIdentifier})) AS max_value,
            AVG(CASE WHEN ${columnIdentifier} IS NULL THEN 1.0 ELSE 0.0 END) AS null_fraction
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
          const nullFraction = this.#toNumber(rows[0]?.null_fraction);
          if (
            rows[0]?.min_value != null ||
            rows[0]?.max_value != null ||
            nullFraction != null
          ) {
            column.stats = {
              min: rows[0]?.min_value ?? undefined,
              max: rows[0]?.max_value ?? undefined,
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

  async #annotateLowCardinalityColumns(
    tables: Table[],
    onProgress?: OnProgress,
  ) {
    const total = tables.length;
    for (let i = 0; i < tables.length; i++) {
      const table = tables[i];
      const tableIdentifier = this.#formatQualifiedTableName(table);
      onProgress?.({
        phase: 'low_cardinality',
        message: `Analyzing cardinality in ${table.name}...`,
        current: i + 1,
        total,
      });
      for (const column of table.columns) {
        const columnIdentifier = this.#quoteIdentifier(column.name);
        const limit = LOW_CARDINALITY_LIMIT + 1;
        const sql = `
          SELECT DISTINCT TOP (${limit}) ${columnIdentifier} AS value
          FROM ${tableIdentifier}
          WHERE ${columnIdentifier} IS NOT NULL
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

    return `AND ${columnName} NOT IN ('INFORMATION_SCHEMA', 'sys')`;
  }

  /**
   * Build a filter for table names (qualified as schema.table).
   * Matches if either the source table or referenced table is in the list.
   */
  #buildTableNamesFilter(tableNames?: string[]): string {
    if (!tableNames || tableNames.length === 0) {
      return '';
    }

    // Parse qualified names (schema.table) and unqualified names
    const conditions: string[] = [];

    for (const name of tableNames) {
      const escaped = name.replace(/'/g, "''");
      if (name.includes('.')) {
        const [schema, ...rest] = name.split('.');
        const tableName = rest.join('.');
        const escapedSchema = schema.replace(/'/g, "''");
        const escapedTable = tableName.replace(/'/g, "''");
        // Match source or target table
        conditions.push(
          `(fk.TABLE_SCHEMA = '${escapedSchema}' AND fk.TABLE_NAME = '${escapedTable}')`,
        );
        conditions.push(
          `(pk.TABLE_SCHEMA = '${escapedSchema}' AND pk.TABLE_NAME = '${escapedTable}')`,
        );
      } else {
        // Unqualified name - match just the table name
        conditions.push(`fk.TABLE_NAME = '${escaped}'`);
        conditions.push(`pk.TABLE_NAME = '${escaped}'`);
      }
    }

    return `AND (${conditions.join(' OR ')})`;
  }

  async #runIntrospectionQuery<Row>(sql: string): Promise<Row[]> {
    const result = await this.#options.execute(sql);

    if (Array.isArray(result)) {
      return result as Row[];
    }

    if (result && typeof result === 'object') {
      if (
        'rows' in result &&
        Array.isArray((result as { rows?: unknown }).rows)
      ) {
        return (result as { rows: Row[] }).rows;
      }

      if (
        'recordset' in result &&
        Array.isArray((result as { recordset?: unknown }).recordset)
      ) {
        return (result as { recordset: Row[] }).recordset;
      }

      if (
        'recordsets' in result &&
        Array.isArray((result as { recordsets?: unknown }).recordsets) &&
        Array.isArray((result as { recordsets: unknown[] }).recordsets[0])
      ) {
        return (result as { recordsets: Row[][] }).recordsets[0];
      }
    }

    throw new Error(
      'SqlServer adapter execute() must return an array of rows or an object with rows/recordset properties when introspecting.',
    );
  }

  #quoteIdentifier(name: string) {
    return `[${name.replace(/]/g, ']]')}]`;
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
    return /int|numeric|decimal|float|real|money|date|time|timestamp|bool/.test(
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
}
