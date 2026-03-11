import nodeSqlParser from 'node-sql-parser';

import type { SQLScopeErrorPayload } from '../agents/exceptions.ts';

export type RuntimeScopeDialect =
  | 'bigquery'
  | 'mysql'
  | 'postgresql'
  | 'sqlite'
  | 'transactsql';

export interface RuntimeEntityReference {
  db?: string | null;
  table: string;
}

type AstLike = Record<string, unknown>;

type ScopeVisitState = {
  cteNames: Set<string>;
  references: Map<string, RuntimeEntityReference>;
};

const { Parser } = nodeSqlParser;
const parser = new Parser();

/**
 * Parse SQL and return the base table/view references used by the query.
 * CTE aliases and derived table aliases are excluded from the result.
 */
export function extractBaseEntityReferences(
  sql: string,
  dialect: RuntimeScopeDialect,
): RuntimeEntityReference[] {
  const ast = parser.astify(sql, { database: dialect });
  const state: ScopeVisitState = {
    cteNames: new Set<string>(),
    references: new Map<string, RuntimeEntityReference>(),
  };

  visitNode(ast, state);
  return Array.from(state.references.values());
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

export function buildScopeParseErrorPayload(
  sql: string,
  dialect: RuntimeScopeDialect,
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
    parser_dialect: dialect,
    parser_error: parserError,
  };
}

function visitNode(node: unknown, state: ScopeVisitState): void {
  if (Array.isArray(node)) {
    for (const item of node) {
      visitNode(item, state);
    }
    return;
  }

  if (!isAstLike(node)) {
    return;
  }

  if (isStatementNode(node)) {
    visitStatement(node, state);
    return;
  }

  if (isTableReferenceNode(node)) {
    addReference(node, state);
  }

  for (const value of Object.values(node)) {
    visitNode(value, state);
  }
}

function visitStatement(node: AstLike, parentState: ScopeVisitState): void {
  const localState: ScopeVisitState = {
    cteNames: new Set(parentState.cteNames),
    references: parentState.references,
  };

  const withItems = Array.isArray(node.with)
    ? (node.with as unknown[])
    : ([] as unknown[]);

  for (const item of withItems) {
    if (!isAstLike(item)) {
      continue;
    }
    const cteName = readCteName(item);
    if (cteName) {
      localState.cteNames.add(caseFold(cteName));
    }
  }

  for (const item of withItems) {
    if (!isAstLike(item)) {
      continue;
    }
    visitNode(item.stmt, localState);
  }

  for (const [key, value] of Object.entries(node)) {
    if (key === 'with') {
      continue;
    }
    visitNode(value, localState);
  }
}

function addReference(node: AstLike, state: ScopeVisitState): void {
  const table = typeof node.table === 'string' ? node.table : null;
  if (!table) {
    return;
  }

  if (state.cteNames.has(caseFold(table))) {
    return;
  }

  const db = typeof node.db === 'string' ? node.db : null;
  const key = db ? `${db}.${table}` : table;

  if (!state.references.has(key)) {
    state.references.set(key, { db, table });
  }
}

function readCteName(node: AstLike): string | undefined {
  const name = node.name;
  if (typeof name === 'string') {
    return name;
  }
  if (!isAstLike(name)) {
    return undefined;
  }
  const value = name.value;
  return typeof value === 'string' ? value : undefined;
}

function isStatementNode(node: AstLike): boolean {
  const type = node.type;
  return (
    typeof type === 'string' &&
    ['delete', 'insert', 'replace', 'select', 'update'].includes(type)
  );
}

function isTableReferenceNode(node: AstLike): boolean {
  if (node.type === 'column_ref') {
    return false;
  }

  if (typeof node.table !== 'string') {
    return false;
  }

  return (
    'addition' in node ||
    'as' in node ||
    'db' in node ||
    'join' in node ||
    'operator' in node ||
    'surround' in node ||
    'table_hint' in node ||
    'temporal_table' in node
  );
}

function isAstLike(value: unknown): value is AstLike {
  return typeof value === 'object' && value !== null;
}

function caseFold(value: string): string {
  return value.toLowerCase();
}
