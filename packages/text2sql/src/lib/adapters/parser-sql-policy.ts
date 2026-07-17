import nodeSqlParser from 'node-sql-parser';

import type { SQLScopeErrorPayload } from '../agents/exceptions.ts';
import { buildScopeParseErrorPayload } from '../sql-scope-error.ts';
import type {
  SqlPolicyAnalyzer,
  SqlPolicyContext,
  SqlPolicyViolation,
} from './sql-policy.ts';

export type ParserDialect =
  | 'bigquery'
  | 'mysql'
  | 'postgresql'
  | 'sqlite'
  | 'transactsql';

interface SqlEntityReference {
  db?: string | null;
  table: string;
}

type AstLike = Record<string, unknown>;

export type ParserReadOnlyPolicy = {
  blockedFunctions?: readonly string[];
  blockAssignments?: boolean;
  blockQualifiedFunctions?: boolean;
  blockLockingReads?: boolean;
  blockSelectInto?: boolean;
  blockTableHints?: boolean;
};

type ScopeVisitState = {
  cteNames: Set<string>;
  references: Map<string, SqlEntityReference>;
};

const READ_ONLY_MESSAGE = 'only SELECT or WITH queries allowed';
const { Parser } = nodeSqlParser;
const parser = new Parser();

/**
 * Internal base for dialect analyzers backed by node-sql-parser.
 * Server-backed analyzers implement SqlPolicyAnalyzer directly.
 */
export abstract class ParserSqlPolicyAnalyzer implements SqlPolicyAnalyzer {
  protected abstract readonly dialects: readonly ParserDialect[];
  protected readonly readOnlyPolicy: ParserReadOnlyPolicy = {};

  async analyze(
    sql: string,
    context: SqlPolicyContext,
  ): Promise<SqlPolicyViolation | null> {
    if (!this.#isReadOnly(sql)) {
      return { kind: 'read-only', message: READ_ONLY_MESSAGE };
    }

    const allowedEntities = await context.resolveAllowedEntities();
    const scopeError = this.#checkScope(sql, allowedEntities);
    return scopeError ? { kind: 'scope', payload: scopeError } : null;
  }

  #isReadOnly(sql: string): boolean {
    const statements = this.#readParsedStatements(sql);
    if (statements) {
      return (
        statements.length === 1 &&
        statements[0]?.type === 'select' &&
        !containsBlockedOperation(statements[0], this.readOnlyPolicy)
      );
    }

    const keyword = firstStatementKeyword(sql);
    return keyword === 'SELECT' || keyword === 'WITH';
  }

  #readParsedStatements(sql: string): AstLike[] | null {
    for (const dialect of this.dialects) {
      try {
        return parseStatements(sql, dialect);
      } catch {
        // Parser coverage failures are handled by scope/adapter validation later.
      }
    }
    return null;
  }

  #checkScope(
    sql: string,
    allowedEntities: readonly string[],
  ): SQLScopeErrorPayload | null {
    let references: SqlEntityReference[] | null = null;
    let lastError: unknown;
    let lastDialect = this.dialects[0]!;

    for (const dialect of this.dialects) {
      try {
        references = extractBaseEntityReferences(sql, dialect);
        break;
      } catch (error) {
        lastDialect = dialect;
        lastError = error;
      }
    }

    if (references === null) {
      return buildScopeParseErrorPayload(sql, lastDialect, lastError);
    }
    if (references.length === 0) return null;

    const allowedQualified = new Set(
      allowedEntities.map((entity) => entity.toLowerCase()),
    );
    const allowedUnqualified = new Set<string>();
    for (const entity of allowedEntities) {
      const dot = entity.lastIndexOf('.');
      allowedUnqualified.add(
        (dot === -1 ? entity : entity.slice(dot + 1)).toLowerCase(),
      );
    }

    const outOfScope = references
      .map((reference) =>
        reference.db ? `${reference.db}.${reference.table}` : reference.table,
      )
      .filter((name) => {
        const lower = name.toLowerCase();
        if (!name.includes('.')) {
          return !allowedQualified.has(lower) && !allowedUnqualified.has(lower);
        }
        if (allowedQualified.has(lower)) return false;

        const parts = lower.split('.');
        return (
          parts.length < 3 || !allowedQualified.has(parts.slice(-2).join('.'))
        );
      });

    return outOfScope.length === 0
      ? null
      : buildOutOfScopePayload(sql, outOfScope, [...allowedEntities]);
  }
}

function parseStatements(sql: string, dialect: ParserDialect): AstLike[] {
  const ast = parser.astify(sql, { database: dialect });
  const statements: unknown[] = Array.isArray(ast) ? ast : [ast];
  return statements.filter(isAstLike);
}

function containsBlockedOperation(
  node: unknown,
  policy: ParserReadOnlyPolicy,
): boolean {
  if (Array.isArray(node)) {
    return node.some((item) => containsBlockedOperation(item, policy));
  }
  if (!isAstLike(node)) return false;

  if (
    policy.blockSelectInto &&
    node.type === 'select' &&
    isAstLike(node.into) &&
    node.into.type === 'into'
  ) {
    return true;
  }
  if (policy.blockLockingReads && node.locking_read != null) return true;
  if (policy.blockAssignments && node.type === 'assign') return true;
  if (policy.blockTableHints && node.table_hint != null) return true;

  if (node.type === 'function') {
    const functionIdentifier = readFunctionIdentifier(node);
    if (
      functionIdentifier &&
      policy.blockQualifiedFunctions &&
      functionIdentifier.parts.length > 1
    ) {
      return true;
    }
    if (
      functionIdentifier &&
      policy.blockedFunctions?.some(
        (blocked) => blocked.toLowerCase() === functionIdentifier.parts.at(-1),
      )
    ) {
      return true;
    }
  }

  return Object.values(node).some((value) =>
    containsBlockedOperation(value, policy),
  );
}

function readFunctionIdentifier(node: AstLike): { parts: string[] } | null {
  if (!isAstLike(node.name)) return null;
  const parts: string[] = [];

  if (
    isAstLike(node.name.schema) &&
    typeof node.name.schema.value === 'string'
  ) {
    parts.push(node.name.schema.value.toLowerCase());
  }

  const names = Array.isArray(node.name.name) ? node.name.name : [];
  for (const name of names) {
    if (isAstLike(name) && typeof name.value === 'string') {
      parts.push(name.value.toLowerCase());
    }
  }

  return parts.length > 0 ? { parts } : null;
}

function extractBaseEntityReferences(
  sql: string,
  dialect: ParserDialect,
): SqlEntityReference[] {
  const ast = parser.astify(sql, { database: dialect });
  const state: ScopeVisitState = {
    cteNames: new Set<string>(),
    references: new Map<string, SqlEntityReference>(),
  };

  visitNode(ast, state);
  return Array.from(state.references.values());
}

function firstStatementKeyword(sql: string): string | null {
  let offset = 0;

  while (offset < sql.length) {
    if (/\s/.test(sql[offset])) {
      offset++;
      continue;
    }

    if (sql.startsWith('--', offset)) {
      offset += 2;
      while (
        offset < sql.length &&
        sql[offset] !== '\n' &&
        sql[offset] !== '\r'
      ) {
        offset++;
      }
      continue;
    }

    if (sql.startsWith('/*', offset)) {
      const commentEnd = sql.indexOf('*/', offset + 2);
      if (commentEnd === -1) return null;
      offset = commentEnd + 2;
      continue;
    }

    const keyword = /^[A-Za-z]+/.exec(sql.slice(offset));
    return keyword ? keyword[0].toUpperCase() : null;
  }

  return null;
}

function buildOutOfScopePayload(
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

function visitNode(node: unknown, state: ScopeVisitState): void {
  if (Array.isArray(node)) {
    for (const item of node) visitNode(item, state);
    return;
  }
  if (!isAstLike(node)) return;

  if (isStatementNode(node)) {
    visitStatement(node, state);
    return;
  }

  if (isTableReferenceNode(node)) addReference(node, state);
  for (const value of Object.values(node)) visitNode(value, state);
}

function visitStatement(node: AstLike, parentState: ScopeVisitState): void {
  const localState: ScopeVisitState = {
    cteNames: new Set(parentState.cteNames),
    references: parentState.references,
  };
  const withItems = Array.isArray(node.with) ? node.with : [];

  for (const item of withItems) {
    if (!isAstLike(item)) continue;
    const cteName = readCteName(item);
    if (cteName) localState.cteNames.add(caseFold(cteName));
  }

  for (const item of withItems) {
    if (isAstLike(item)) visitNode(item.stmt, localState);
  }

  for (const [key, value] of Object.entries(node)) {
    if (key !== 'with') visitNode(value, localState);
  }
}

function addReference(node: AstLike, state: ScopeVisitState): void {
  const table = typeof node.table === 'string' ? node.table : null;
  if (!table || state.cteNames.has(caseFold(table))) return;

  const db = typeof node.db === 'string' ? node.db : null;
  const key = db ? `${db}.${table}` : table;
  if (!state.references.has(key)) state.references.set(key, { db, table });
}

function readCteName(node: AstLike): string | undefined {
  const name = node.name;
  if (typeof name === 'string') return name;
  if (!isAstLike(name)) return undefined;
  return typeof name.value === 'string' ? name.value : undefined;
}

function isStatementNode(node: AstLike): boolean {
  return (
    typeof node.type === 'string' &&
    ['delete', 'insert', 'replace', 'select', 'update'].includes(node.type)
  );
}

function isTableReferenceNode(node: AstLike): boolean {
  if (node.type === 'column_ref' || typeof node.table !== 'string')
    return false;

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
