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

export function formatError(sql: string, error: any) {
  if (isSqliteError(error)) {
    const errorMessage =
      error instanceof Error ? error.message : 'Unknown error occurred';
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
  return error;
}

function isSqliteError(
  error: unknown,
): error is { message: string; code?: string } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    'code' in error &&
    error.code === 'ERR_SQLITE_ERROR'
  );
}
