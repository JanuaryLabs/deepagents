import type { SQLScopeErrorPayload } from '../../agents/exceptions.ts';
import { buildScopeParseErrorPayload } from '../../sql-scope-error.ts';
import type { ExecuteFunction } from '../adapter.ts';
import type {
  SqlPolicyAnalyzer,
  SqlPolicyContext,
  SqlPolicyViolation,
} from '../sql-policy.ts';

const READ_ONLY_MESSAGE = 'only SELECT queries allowed';

type ExplainNode = {
  text: string;
  children: ExplainNode[];
};

export class ClickHouseSqlPolicyAnalyzer implements SqlPolicyAnalyzer {
  readonly #query: ExecuteFunction;
  #readonlyCheck?: Promise<void>;
  #currentDatabase?: string;

  constructor(query: ExecuteFunction) {
    this.#query = query;
  }

  async analyze(
    sql: string,
    context: SqlPolicyContext,
  ): Promise<SqlPolicyViolation | null> {
    try {
      await (this.#readonlyCheck ??= this.#verifyReadonly());

      const ast = await this.#explain(`EXPLAIN AST ${sql}`);
      const astAnalysis = analyzeAst(ast);
      if (!astAnalysis.isSelect) {
        return { kind: 'read-only', message: READ_ONLY_MESSAGE };
      }
      if (await this.#hasUnsafeFunction(astAnalysis.functions)) {
        return { kind: 'read-only', message: READ_ONLY_MESSAGE };
      }

      const syntacticTree = await this.#explain(
        `EXPLAIN QUERY TREE run_passes = 0 ${sql}`,
      );
      const analyzedTree = await this.#explain(`EXPLAIN QUERY TREE ${sql}`);
      const syntacticRelations = readQueryTreeRelations(
        syntacticTree,
        'syntactic',
      );
      const analyzedRelations = readQueryTreeRelations(
        analyzedTree,
        'analyzed',
      );
      if (!this.#currentDatabase) {
        throw new Error('ClickHouse current database was not established.');
      }
      const relations = [
        ...new Set(
          [...syntacticRelations, ...analyzedRelations].map((relation) =>
            qualifyRelation(relation, this.#currentDatabase!),
          ),
        ),
      ];
      const allowed = await context.resolveAllowedEntities();
      const rejected = relations.filter(
        (relation) => !isAllowedRelation(relation, allowed),
      );

      return rejected.length
        ? {
            kind: 'scope',
            payload: buildOutOfScopePayload(sql, rejected, [...allowed]),
          }
        : null;
    } catch (error) {
      return {
        kind: 'scope',
        payload: buildScopeParseErrorPayload(sql, 'clickhouse', error),
      };
    }
  }

  async #verifyReadonly(): Promise<void> {
    const rows = readRows(
      await this.#query(
        "SELECT getSetting('readonly') AS readonly, currentDatabase() AS database",
      ),
    );
    const row = rows[0];
    if (
      rows.length !== 1 ||
      !row ||
      Object.keys(row).length !== 2 ||
      typeof row.database !== 'string' ||
      row.database.length === 0
    ) {
      throw new Error(
        'ClickHouse readonly probe returned an unknown row shape.',
      );
    }
    const value = row.readonly;
    if (value !== 1 && value !== '1') {
      throw new Error(
        `ClickHouse connection must have effective readonly = 1; received ${String(value)}.`,
      );
    }
    this.#currentDatabase = row.database;
  }

  async #explain(sql: string): Promise<string[]> {
    const rows = readRows(await this.#query(sql));
    if (rows.length === 0) {
      throw new Error('ClickHouse EXPLAIN returned no rows.');
    }
    return rows.map((row) => {
      if (Object.keys(row).length !== 1 || typeof row.explain !== 'string') {
        throw new Error(
          'ClickHouse EXPLAIN must return rows with exactly one string `explain` column.',
        );
      }
      return row.explain;
    });
  }

  async #hasUnsafeFunction(functions: readonly string[]): Promise<boolean> {
    if (functions.some(isScopeBypassingFunction)) return true;
    if (functions.length === 0) return false;
    const names = [...new Set(functions)]
      .map((name) => `'${name.replaceAll("'", "''")}'`)
      .join(', ');
    const rows = readRows(
      await this.#query(`
        SELECT name, toString(origin) AS origin
        FROM system.functions
        WHERE name IN (${names})
          AND origin != 'System'
      `),
    );
    for (const row of rows) {
      if (typeof row.name !== 'string' || typeof row.origin !== 'string') {
        throw new Error(
          'ClickHouse system.functions returned an unknown row shape.',
        );
      }
      if (
        row.origin !== 'SQLUserDefined' &&
        row.origin !== 'ExecutableUserDefined' &&
        row.origin !== 'WasmUserDefined'
      ) {
        throw new Error(`Unknown ClickHouse function origin: ${row.origin}`);
      }
    }
    return rows.length > 0;
  }
}

function isScopeBypassingFunction(name: string): boolean {
  const normalized = name.toLocaleLowerCase('en-US');
  return normalized.startsWith('dict') || normalized.startsWith('joinget');
}

function readRows(result: unknown): Record<string, unknown>[] {
  const rows = Array.isArray(result)
    ? result
    : result && typeof result === 'object' && 'data' in result
      ? (result as { data: unknown }).data
      : result && typeof result === 'object' && 'rows' in result
        ? (result as { rows: unknown }).rows
        : undefined;
  if (!Array.isArray(rows) || rows.some((row) => !isRecord(row))) {
    throw new Error(
      'ClickHouse query callback must return row objects as an array, { data }, or { rows }.',
    );
  }
  return rows;
}

function analyzeAst(lines: string[]): {
  isSelect: boolean;
  functions: string[];
} {
  const rootLines = lines.filter(
    (line) => line.length - line.trimStart().length === 0,
  );
  if (
    rootLines.length !== 1 ||
    !rootLines[0]?.startsWith('SelectWithUnionQuery')
  ) {
    return { isSelect: false, functions: [] };
  }
  const roots = parseIndentedTree(lines, validateAstLine);
  const root = roots[0];
  const isSelect =
    roots.length === 1 &&
    !!root &&
    !root.children.some((child) => child.text.startsWith('Literal ')) &&
    !containsTableFunction(root);
  return {
    isSelect,
    functions: isSelect && root ? collectAstFunctions(root) : [],
  };
}

function validateAstLine(text: string): void {
  const type = /^([A-Za-z][A-Za-z0-9]*)/.exec(text)?.[1];
  const allowed = new Set([
    'ArrayJoin',
    'Asterisk',
    'ExpressionList',
    'Function',
    'Identifier',
    'Literal',
    'OrderByElement',
    'SelectQuery',
    'SelectWithUnionQuery',
    'Subquery',
    'TableExpression',
    'TableIdentifier',
    'TableJoin',
    'TablesInSelectQuery',
    'TablesInSelectQueryElement',
    'WithElement',
    'WindowDefinition',
  ]);
  if (!type || !allowed.has(type)) {
    throw new Error(`Unknown ClickHouse AST node: ${text}`);
  }
}

function containsTableFunction(node: ExplainNode): boolean {
  if (
    node.text.startsWith('TableExpression') &&
    node.children.some((child) => child.text.startsWith('Function '))
  ) {
    return true;
  }
  return node.children.some(containsTableFunction);
}

function collectAstFunctions(node: ExplainNode): string[] {
  const functions: string[] = [];
  if (node.text.startsWith('Function ')) {
    const name = /^Function (\S+)/.exec(node.text)?.[1];
    if (!name) throw new Error(`Unknown ClickHouse AST function: ${node.text}`);
    functions.push(name);
  }
  for (const child of node.children)
    functions.push(...collectAstFunctions(child));
  return functions;
}

function readQueryTreeRelations(
  lines: string[],
  phase: 'syntactic' | 'analyzed',
): string[] {
  const roots = parseIndentedTree(lines, (text, parent) =>
    validateQueryTreeLine(text, parent),
  );
  if (
    roots.length !== 1 ||
    (!roots[0]?.text.startsWith('QUERY ') &&
      !roots[0]?.text.startsWith('UNION '))
  ) {
    throw new Error(`Unknown ClickHouse ${phase} query-tree root.`);
  }

  const relations: string[] = [];
  const cteNames = new Set<string>();
  collectCteNames(roots[0], cteNames);
  visitQueryTree(roots[0], false, phase, cteNames, relations);
  return relations;
}

function validateQueryTreeLine(text: string, parent?: ExplainNode): void {
  const nodePatterns = [
    /^QUERY id:/,
    /^UNION id:/,
    /^QUERIES$/,
    /^PROJECTION(?: COLUMNS)?$/,
    /^WITH$/,
    /^LIST id:/,
    /^MATCHER id:/,
    /^COLUMN id:/,
    /^JOIN TREE$/,
    /^ARRAY_JOIN id:/,
    /^IDENTIFIER id:/,
    /^TABLE id:/,
    /^JOIN id:/,
    /^(?:(?:LEFT|RIGHT) )?TABLE EXPRESSION$/,
    /^JOIN EXPRESSIONS?$/,
    /^FUNCTION id:/,
    /^ARGUMENTS$/,
    /^CONSTANT id:/,
    /^PREWHERE$/,
    /^WHERE$/,
    /^WINDOW$/,
    /^WINDOW id:/,
    /^PARTITION BY$/,
    /^QUALIFY$/,
    /^GROUP BY$/,
    /^HAVING$/,
    /^ORDER BY$/,
    /^SORT id:/,
    /^EXPRESSION(?: .*)?$/,
    /^LIMIT BY LIMIT$/,
    /^LIMIT BY$/,
    /^LIMIT$/,
    /^OFFSET$/,
  ];
  if (nodePatterns.some((pattern) => pattern.test(text))) return;
  if (parent?.text === 'PROJECTION COLUMNS' && /^\S+\s+\S+/.test(text)) {
    return;
  }
  throw new Error(`Unknown ClickHouse query-tree node: ${text}`);
}

function visitQueryTree(
  node: ExplainNode,
  relationPosition: boolean,
  phase: 'syntactic' | 'analyzed',
  cteNames: ReadonlySet<string>,
  relations: string[],
): void {
  if (relationPosition && node.text.startsWith('IDENTIFIER ')) {
    const identifier = /(?:^|, )identifier: (.+)$/.exec(node.text)?.[1];
    if (!identifier) {
      throw new Error(`Unknown ClickHouse ${phase} relation: ${node.text}`);
    }
    if (!cteNames.has(identifier)) {
      relations.push(identifier);
    }
  } else if (relationPosition && node.text.startsWith('TABLE ')) {
    const table = /(?:^|, )table_name: ([^,]+)(?:,|$)/.exec(node.text)?.[1];
    if (!table) {
      throw new Error(`Unknown ClickHouse ${phase} relation: ${node.text}`);
    }
    relations.push(table);
  }

  for (const child of node.children) {
    const childrenAreRelations =
      node.text === 'JOIN TREE' ||
      node.text === 'LEFT TABLE EXPRESSION' ||
      node.text === 'RIGHT TABLE EXPRESSION' ||
      node.text === 'TABLE EXPRESSION';
    visitQueryTree(child, childrenAreRelations, phase, cteNames, relations);
  }
}

function collectCteNames(node: ExplainNode, cteNames: Set<string>): void {
  const name = /(?:^|, )cte_name: ([^,]+)(?:,|$)/.exec(node.text)?.[1];
  if (name) cteNames.add(name);
  for (const child of node.children) collectCteNames(child, cteNames);
}

function parseIndentedTree(
  lines: string[],
  validate: (text: string, parent?: ExplainNode) => void,
): ExplainNode[] {
  const roots: ExplainNode[] = [];
  const stack: Array<{ indent: number; node: ExplainNode }> = [];

  for (const line of lines) {
    if (!line.trim())
      throw new Error('ClickHouse EXPLAIN returned an empty line.');
    const indent = line.length - line.trimStart().length;
    const text = line.trimStart();
    while (stack.length && stack.at(-1)!.indent >= indent) stack.pop();
    const parent = stack.at(-1)?.node;
    validate(text, parent);
    const node = { text, children: [] };
    if (parent) parent.children.push(node);
    else roots.push(node);
    stack.push({ indent, node });
  }

  return roots;
}

function isAllowedRelation(
  relation: string,
  allowedEntities: readonly string[],
): boolean {
  return allowedEntities.includes(relation);
}

function qualifyRelation(relation: string, database: string): string {
  return relation.includes('.') ? relation : `${database}.${relation}`;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
