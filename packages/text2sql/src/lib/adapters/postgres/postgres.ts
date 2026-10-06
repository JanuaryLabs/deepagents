import {
  Adapter,
  type ExecuteFunction,
  type GroundingFn,
  type ValidateFunction,
} from '../adapter.ts';
import { PostgresSqlPolicyAnalyzer } from './postgres.sql-policy.ts';

export type PostgresAdapterOptions = {
  execute: ExecuteFunction;
  validate?: ValidateFunction;
  grounding: GroundingFn[];
  schemas?: string[];
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

function isPostgresError(
  error: unknown,
): error is { code?: string; message?: string } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
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
  override readonly grounding: GroundingFn[];
  override readonly defaultSchema = 'public';
  override readonly systemSchemas = ['pg_catalog', 'information_schema'];
  override readonly formatterLanguage = 'postgresql';

  constructor(options: PostgresAdapterOptions) {
    super(new PostgresSqlPolicyAnalyzer());
    if (!options || typeof options.execute !== 'function') {
      throw new Error('Postgres adapter requires an execute function.');
    }
    this.#options = {
      ...options,
      schemas: options.schemas?.length ? options.schemas : undefined,
    };
    this.grounding = options.grounding;
  }

  override async executeImpl(sql: string) {
    return this.#options.execute(sql);
  }

  override async validateImpl(sql: string) {
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

  override quoteIdentifier(name: string): string {
    return `"${name.replace(/"/g, '""')}"`;
  }

  override escape(value: string): string {
    return value.replace(/"/g, '""');
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

  protected override async queryRows(sql: string): Promise<unknown[]> {
    const result: unknown = await this.#options.execute(sql);

    if (Array.isArray(result)) {
      return result;
    }

    if (
      typeof result === 'object' &&
      result !== null &&
      'rows' in result &&
      Array.isArray(result.rows)
    ) {
      return result.rows;
    }

    throw new Error(
      'Postgres adapter execute() must return an array of rows or an object with a rows array when introspecting.',
    );
  }
}
