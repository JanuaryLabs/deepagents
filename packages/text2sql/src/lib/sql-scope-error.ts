import type { SQLScopeErrorPayload } from './agents/exceptions.ts';

export function buildScopeParseErrorPayload(
  sql: string,
  parserDialect: string,
  error: unknown,
): SQLScopeErrorPayload {
  const parserError =
    error instanceof Error ? error.message : String(error ?? 'Unknown error');

  return {
    error: `SQL scope analysis failed before validation/execution: ${parserError}`,
    error_type: 'SQL_SCOPE_PARSE_ERROR',
    suggestion:
      'Rewrite the query into simpler SQL that can be analyzed safely, or extend parser coverage for this dialect feature.',
    sql_attempted: sql,
    parser_dialect: parserDialect,
    parser_error: parserError,
  };
}
