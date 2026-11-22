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

/**
 * Why SQL is out of scope: it reads entities outside the grounded scope, or
 * the database refused it for the principal that compiled it, in the
 * database's own words.
 */
export type OutOfScope =
  | { readonly referenced: string[]; readonly allowed: string[] }
  | { readonly denial: string };

export function buildOutOfScopePayload(
  sql: string,
  scope: OutOfScope,
): SQLScopeErrorPayload {
  if ('denial' in scope) {
    return {
      error: scope.denial,
      error_type: 'OUT_OF_SCOPE',
      suggestion:
        'Read only the tables and views that the database grants, in one SELECT that writes nothing.',
      sql_attempted: sql,
    };
  }
  return {
    error: `Query references entities outside grounded scope: ${scope.referenced.join(', ')}`,
    error_type: 'OUT_OF_SCOPE',
    suggestion:
      'Restrict the query to grounded tables/views or expand grounding to include the referenced entities.',
    sql_attempted: sql,
    referenced_entities: scope.referenced,
    allowed_entities: scope.allowed,
  };
}
