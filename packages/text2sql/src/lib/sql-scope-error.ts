import type { SQLScopeErrorPayload } from './agents/exceptions.ts';

export function buildScopeParseErrorPayload(
  sql: string,
  parserDialect: string,
  error: unknown,
): SQLScopeErrorPayload {
  const parserError = Error.isError(error)
    ? error.message
    : String(error ?? 'Unknown error');

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

export function buildOutOfScopePayload(
  sql: string,
  referencedEntities: string[],
  allowedEntities: string[],
): SQLScopeErrorPayload {
  return {
    error: `Query references entities outside grounded scope: ${referencedEntities.join(', ')}`,
    error_type: 'OUT_OF_SCOPE',
    suggestion:
      'Restrict the query to grounded tables/views or expand grounding to include the referenced entities.',
    sql_attempted: sql,
    referenced_entities: referencedEntities,
    allowed_entities: allowedEntities,
  };
}
