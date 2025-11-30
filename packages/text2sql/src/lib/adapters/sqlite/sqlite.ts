import {
  Adapter,
  type ExecuteFunction,
  type GroundingFn,
  type ValidateFunction,
} from '../adapter.ts';

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

export type SqliteAdapterOptions = {
  execute: ExecuteFunction;
  validate?: ValidateFunction;
  grounding: GroundingFn[];
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
  override readonly grounding: GroundingFn[];
  override readonly defaultSchema = undefined;
  override readonly systemSchemas: string[] = [];

  constructor(options: SqliteAdapterOptions) {
    super();
    if (!options || typeof options.execute !== 'function') {
      throw new Error('Sqlite adapter requires an execute function.');
    }
    this.#options = options;
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
      return JSON.stringify(formatError(sql, error));
    }
  }

  #quoteIdentifier(name: string) {
    return `'${name.replace(/'/g, "''")}'`;
  }

  override async runQuery<Row>(sql: string): Promise<Row[]> {
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

  override quoteIdentifier(name: string): string {
    return `"${name.replace(/"/g, '""')}"`;
  }

  override escape(value: string): string {
    return value.replace(/"/g, '""');
  }
}
