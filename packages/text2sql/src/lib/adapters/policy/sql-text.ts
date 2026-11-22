import nodeSqlParser from 'node-sql-parser';

import type { Calls, Relations, Statement, Statements } from './facts.ts';
import { type FactSource, UnreadableSql } from './source-policy.ts';

export type ParserDialect =
  'bigquery' | 'mysql' | 'postgresql' | 'sqlite' | 'transactsql';

/**
 * A construct of SQL text that a SELECT can hold:
 * - `table-hint`: a table hint such as SQL Server's `WITH (UPDLOCK)`
 * - `server-relation`: a relation on a linked server, `server.db.schema.table`
 * - `locking-read`: `FOR UPDATE` or `LOCK IN SHARE MODE`
 * - `assignment`: a variable assignment such as MySQL's `@x := 1`
 */
export type Construct =
  'assignment' | 'locking-read' | 'server-relation' | 'table-hint';

export interface Constructs {
  constructs(): Promise<ReadonlySet<Construct>>;
}

export type TextFacts = Statements & Relations & Calls & Constructs;

export interface SqlTextOptions {
  /**
   * The grammars of node-sql-parser, tried in order. The first grammar that
   * parses the SQL gives every fact; a parse error names the last grammar
   * and reports its error.
   */
  readonly dialects: readonly [ParserDialect, ...ParserDialect[]];
  /**
   * Rewrites SQL that a grammar rejects into equivalent SQL that it parses,
   * or gives null. It runs again after each failure, until it gives null or
   * SQL that it gave before.
   */
  readonly recover?: (sql: string, error: unknown) => string | null;
}

type AstLike = Record<string, unknown>;

type ScopeVisitState = {
  cteNames: Set<string>;
  references: Set<string>;
};

const { Parser } = nodeSqlParser;
const parser = new Parser();

/**
 * Reads SQL text with node-sql-parser. It parses the SQL once per read, when
 * a rule first asks for a fact. SQL that no grammar parses gives no fact but
 * its statements: SQL that starts with a keyword other than SELECT or WITH
 * is one statement of that name, and SQL with no keyword has no statement.
 * Every other fact of such SQL throws UnreadableSql.
 */
export class SqlText implements FactSource<TextFacts> {
  readonly dialect: ParserDialect;
  readonly #dialects: readonly ParserDialect[];
  readonly #recover: SqlTextOptions['recover'];

  constructor(options: SqlTextOptions) {
    this.#dialects = options.dialects;
    this.#recover = options.recover;
    [this.dialect] = options.dialects.slice(-1);
  }

  read(sql: string): TextFacts {
    let parsed: { ast: unknown } | { error: UnreadableSql } | undefined;
    const parse = () => (parsed ??= this.#parse(sql));
    const ast = () => {
      const result = parse();
      if ('error' in result) throw result.error;
      return result.ast;
    };

    return {
      statements: async () => {
        const result = parse();
        if ('ast' in result) return statementNodes(result.ast).map(toStatement);
        const keyword = firstStatementKeyword(sql);
        if (keyword === 'SELECT' || keyword === 'WITH') throw result.error;
        return keyword === null ? [] : [{ kind: 'other', name: keyword }];
      },
      relations: async () => baseRelations(ast()),
      calls: async () => calls(ast()),
      constructs: async () => constructs(ast()),
    };
  }

  #parse(sql: string): { ast: unknown } | { error: UnreadableSql } {
    let lastError: unknown;
    for (const dialect of this.#dialects) {
      try {
        return { ast: this.#astify(sql, dialect) };
      } catch (error) {
        lastError = error;
      }
    }
    return {
      error: new UnreadableSql(
        Error.isError(lastError) ? lastError.message : String(lastError),
        { cause: lastError },
      ),
    };
  }

  #astify(sql: string, dialect: ParserDialect): unknown {
    let parserSql = sql;
    const attempted = new Set([sql]);

    while (true) {
      try {
        return parser.astify(parserSql, { database: dialect });
      } catch (error) {
        const recovered = this.#recover?.(parserSql, error);
        if (!recovered || attempted.has(recovered)) throw error;
        attempted.add(recovered);
        parserSql = recovered;
      }
    }
  }
}

function statementNodes(ast: unknown): AstLike[] {
  const statements: unknown[] = Array.isArray(ast) ? ast : [ast];
  return statements.filter(isAstLike);
}

function toStatement(node: AstLike): Statement {
  if (node.type !== 'select') return { kind: 'other', name: String(node.type) };
  return nodes(node).some(
    (child) =>
      child.type === 'select' &&
      isAstLike(child.into) &&
      child.into.type === 'into',
  )
    ? { kind: 'select-into' }
    : { kind: 'select' };
}

function calls(ast: unknown): string[][] {
  return nodes(ast)
    .filter((node) => node.type === 'function')
    .map(functionNameParts)
    .filter((parts) => parts.length > 0)
    .toArray();
}

function constructs(ast: unknown): ReadonlySet<Construct> {
  const found = new Set<Construct>();
  for (const node of nodes(ast)) {
    if (node.table_hint != null) found.add('table-hint');
    if (node.locking_read != null) found.add('locking-read');
    if (node.type === 'assign') found.add('assignment');
    if (isTableReferenceNode(node) && typeof node.server === 'string') {
      found.add('server-relation');
    }
  }
  return found;
}

/** Every object node of the AST, depth first. */
function* nodes(node: unknown): Generator<AstLike, void, undefined> {
  if (Array.isArray(node)) {
    for (const item of node) yield* nodes(item);
    return;
  }
  if (!isAstLike(node)) return;
  yield node;
  for (const value of Object.values(node)) yield* nodes(value);
}

function functionNameParts(node: AstLike): string[] {
  if (!isAstLike(node.name)) return [];
  const parts: string[] = [];

  if (
    isAstLike(node.name.schema) &&
    typeof node.name.schema.value === 'string'
  ) {
    parts.push(...identifierParts(node.name.schema.value));
  }

  const names = Array.isArray(node.name.name) ? node.name.name : [];
  for (const name of names) {
    if (isAstLike(name) && typeof name.value === 'string') {
      parts.push(...identifierParts(name.value));
    }
  }

  return parts;
}

function identifierParts(value: string): string[] {
  return value.split('.').filter((part) => part.length > 0);
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

function baseRelations(ast: unknown): string[] {
  const state: ScopeVisitState = {
    cteNames: new Set<string>(),
    references: new Set<string>(),
  };

  visitNode(ast, state);
  return [...state.references];
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
    if (cteName) localState.cteNames.add(cteName.toLowerCase());
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
  if (!table || state.cteNames.has(table.toLowerCase())) return;

  const db = typeof node.db === 'string' ? node.db : null;
  state.references.add(db ? `${db}.${table}` : table);
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
