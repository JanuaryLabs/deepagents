import {
  Adapter,
  type ExecuteFunction,
  type GroundingFn,
  type ValidateFunction,
} from '../adapter.ts';

export type MysqlAdapterOptions = {
  execute: ExecuteFunction;
  validate?: ValidateFunction;
  grounding: GroundingFn[];
  /** Database names to include (defaults to excluding system databases) */
  databases?: string[];
};

const MYSQL_ERROR_MAP: Record<string, { type: string; hint: string }> = {
  '1146': {
    type: 'MISSING_TABLE',
    hint: 'Check the database for the correct table name. Include the database prefix if necessary.',
  },
  '1054': {
    type: 'INVALID_COLUMN',
    hint: 'Verify the column exists on the referenced table and use table aliases to disambiguate.',
  },
  '1064': {
    type: 'SYNTAX_ERROR',
    hint: 'There is a SQL syntax error. Review keywords, punctuation, and the overall query shape.',
  },
  '1630': {
    type: 'INVALID_FUNCTION',
    hint: 'The function does not exist or the arguments are invalid.',
  },
  '1305': {
    type: 'INVALID_FUNCTION',
    hint: 'The function or procedure you used is not recognized. Confirm its name and argument types.',
  },
  '1109': {
    type: 'MISSING_TABLE',
    hint: 'Unknown table in the query. Verify table name and database.',
  },
  '1051': {
    type: 'MISSING_TABLE',
    hint: 'Unknown table. Check if the table exists in the current database.',
  },
};

function isMysqlError(
  error: unknown,
): error is { errno?: number; code?: string; message?: string } {
  return (
    typeof error === 'object' &&
    error !== null &&
    ('errno' in error || 'code' in error)
  );
}

export function formatMysqlError(sql: string, error: unknown) {
  const errorMessage =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : 'Unknown error occurred';

  if (isMysqlError(error)) {
    const errorCode = error.errno?.toString() ?? error.code ?? '';
    const metadata = MYSQL_ERROR_MAP[errorCode];
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

export class Mysql extends Adapter {
  #options: MysqlAdapterOptions;
  override readonly grounding: GroundingFn[];
  override readonly defaultSchema: string | undefined = undefined;
  override readonly systemSchemas = [
    'mysql',
    'information_schema',
    'performance_schema',
    'sys',
  ];

  constructor(options: MysqlAdapterOptions) {
    super();
    if (!options || typeof options.execute !== 'function') {
      throw new Error('Mysql adapter requires an execute function.');
    }
    this.#options = {
      ...options,
      databases: options.databases?.length ? options.databases : undefined,
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
        await this.#options.execute(`EXPLAIN ${text}`);
      });

    try {
      return await validator(sql);
    } catch (error) {
      return JSON.stringify(formatMysqlError(sql, error));
    }
  }

  override async runQuery<Row>(sql: string): Promise<Row[]> {
    return this.#runIntrospectionQuery<Row>(sql);
  }

  override quoteIdentifier(name: string): string {
    return `\`${name.replace(/`/g, '``')}\``;
  }

  override escape(value: string): string {
    return value.replace(/`/g, '``');
  }

  override buildSampleRowsQuery(
    tableName: string,
    columns: string[] | undefined,
    limit: number,
  ): string {
    const { schema, table } = this.parseTableName(tableName);
    const tableIdentifier = schema
      ? `${this.quoteIdentifier(schema)}.${this.quoteIdentifier(table)}`
      : this.quoteIdentifier(table);
    const columnList = columns?.length
      ? columns.map((c) => this.quoteIdentifier(c)).join(', ')
      : '*';
    return `SELECT ${columnList} FROM ${tableIdentifier} LIMIT ${limit}`;
  }

  /**
   * Get the configured databases filter.
   */
  get databases(): string[] | undefined {
    return this.#options.databases;
  }

  async #runIntrospectionQuery<Row>(sql: string): Promise<Row[]> {
    const result = await this.#options.execute(sql);

    // Handle mysql2 results: [rows, fields]
    if (Array.isArray(result)) {
      // If it's [rows, fields], use the first element
      if (
        result.length >= 1 &&
        Array.isArray(result[0]) &&
        (result.length === 1 ||
          (result.length === 2 && !Array.isArray(result[1]?.[0])))
      ) {
        return result[0] as Row[];
      }
      return result as Row[];
    }

    // Handle object with rows property
    if (
      result &&
      typeof result === 'object' &&
      'rows' in result &&
      Array.isArray((result as { rows?: unknown }).rows)
    ) {
      return (result as { rows: Row[] }).rows;
    }

    throw new Error(
      'Mysql adapter execute() must return an array of rows or an object with a rows array when introspecting.',
    );
  }
}

// Re-export as Mariadb for convenience
export { Mysql as Mariadb };
