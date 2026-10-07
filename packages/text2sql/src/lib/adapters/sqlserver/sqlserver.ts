import {
  Adapter,
  type ExecuteFunction,
  type GroundingFn,
  type ValidateFunction,
} from '../adapter.ts';
import { SqlServerSqlPolicyAnalyzer } from './sqlserver.sql-policy.ts';

export type SqlServerAdapterOptions = {
  execute: ExecuteFunction;
  validate?: ValidateFunction;
  grounding: GroundingFn[];
  schemas?: string[];
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
    hint: 'A column reference could not be bound. If the table is aliased (e.g. FROM dbo.users AS users), use the alias for columns (users.id), not the schema-qualified name (dbo.users.id).',
  },
  '1934': {
    type: 'CONSTRAINT_ERROR',
    hint: 'The query violates a constraint. Re-check join logic and filtering.',
  },
};

function getErrorCode(error: unknown) {
  if (
    typeof error === 'object' &&
    error !== null &&
    'number' in error &&
    typeof error.number === 'number'
  ) {
    return String(error.number);
  }

  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
  ) {
    return error.code;
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
    super(new SqlServerSqlPolicyAnalyzer());
    if (!options || typeof options.execute !== 'function') {
      throw new Error('SqlServer adapter requires an execute function.');
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

  /**
   * The schemas introspection is limited to; table and view discovery use
   * them unless a grounding lists its own.
   */
  get schemas(): string[] | undefined {
    return this.#options.schemas;
  }

  protected override async queryRows(sql: string): Promise<unknown[]> {
    const result: unknown = await this.#options.execute(sql);

    if (Array.isArray(result)) {
      return result;
    }

    if (typeof result === 'object' && result !== null) {
      if ('rows' in result && Array.isArray(result.rows)) {
        return result.rows;
      }

      if ('recordset' in result && Array.isArray(result.recordset)) {
        return result.recordset;
      }

      if (
        'recordsets' in result &&
        Array.isArray(result.recordsets) &&
        Array.isArray(result.recordsets[0])
      ) {
        return result.recordsets[0];
      }
    }

    throw new Error(
      'SqlServer adapter execute() must return an array of rows or an object with rows/recordset properties when introspecting.',
    );
  }
}
