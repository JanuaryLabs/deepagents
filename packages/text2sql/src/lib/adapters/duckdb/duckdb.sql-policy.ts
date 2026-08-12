import type { SQLScopeErrorPayload } from '../../agents/exceptions.ts';
import { buildScopeParseErrorPayload } from '../../sql-scope-error.ts';
import type { ExecuteFunction } from '../adapter.ts';
import type {
  SqlPolicyAnalyzer,
  SqlPolicyContext,
  SqlPolicyViolation,
} from '../sql-policy.ts';
import {
  formatDuckDBIdentifierPath,
  parseDuckDBRelationName,
} from './duckdb-identifiers.ts';

const READ_ONLY_MESSAGE = 'only SELECT queries allowed';
const SAFE_TABLE_FUNCTIONS = new Set(['generate_series', 'range', 'unnest']);

type Namespace = { catalog: string; schema: string };

export class DuckDBSqlPolicyAnalyzer implements SqlPolicyAnalyzer {
  readonly #query: ExecuteFunction;
  #namespace?: Promise<Namespace>;

  constructor(query: ExecuteFunction) {
    this.#query = query;
  }

  async analyze(
    sql: string,
    context: SqlPolicyContext,
  ): Promise<SqlPolicyViolation | null> {
    try {
      const namespace = await (this.#namespace ??= this.#loadNamespace());
      const ast = await this.#serialize(sql);
      const analysis = analyzeAst(ast, namespace);

      if (
        analysis.tableFunctions.some(
          (name) => !SAFE_TABLE_FUNCTIONS.has(caseFold(name)),
        ) ||
        (await this.#hasUnsafeFunction(analysis.functions))
      ) {
        return { kind: 'read-only', message: READ_ONLY_MESSAGE };
      }

      const allowedEntities = await context.resolveAllowedEntities();
      const allowed = new Set(
        allowedEntities.map((name) =>
          caseFold(qualifyAllowedRelation(name, namespace)),
        ),
      );
      const rejected = analysis.relations.filter(
        (relation) => !allowed.has(caseFold(relation)),
      );

      return rejected.length > 0
        ? {
            kind: 'scope',
            payload: buildOutOfScopePayload(sql, rejected, [
              ...allowedEntities,
            ]),
          }
        : null;
    } catch (error) {
      if (isReadOnlySerializationError(error)) {
        return { kind: 'read-only', message: READ_ONLY_MESSAGE };
      }
      return {
        kind: 'scope',
        payload: buildScopeParseErrorPayload(sql, 'duckdb', error),
      };
    }
  }

  async #loadNamespace(): Promise<Namespace> {
    const rows = readRows(
      await this.#query(`
        SELECT current_database() AS catalog, current_schema() AS schema
      `),
    );
    const row = rows[0];
    if (
      rows.length !== 1 ||
      typeof row?.catalog !== 'string' ||
      typeof row.schema !== 'string'
    ) {
      throw new Error(
        'DuckDB current namespace returned an unknown row shape.',
      );
    }
    return { catalog: row.catalog, schema: row.schema };
  }

  async #serialize(sql: string): Promise<unknown> {
    const literal = sql.replaceAll("'", "''");
    const rows = readRows(
      await this.#query(`
        SELECT json_serialize_sql(
          '${literal}',
          skip_empty := true,
          skip_null := true
        ) AS ast
      `),
    );
    if (rows.length !== 1 || typeof rows[0]?.ast !== 'string') {
      throw new Error(
        'DuckDB json_serialize_sql returned an unknown row shape.',
      );
    }

    const result: unknown = JSON.parse(rows[0].ast);
    if (!isRecord(result)) {
      throw new Error('DuckDB json_serialize_sql returned invalid JSON.');
    }
    if (result.error === true) {
      const message =
        typeof result.error_message === 'string'
          ? result.error_message
          : 'DuckDB could not serialize the SQL statement.';
      if (
        result.error_type === 'not implemented' &&
        message === 'Only SELECT statements can be serialized to json!'
      ) {
        throw new DuckDBSerializationError(message);
      }
      throw new Error(
        `DuckDB rejected the SQL during AST analysis: ${message}`,
      );
    }
    if (
      result.error !== false ||
      !Array.isArray(result.statements) ||
      result.statements.length !== 1
    ) {
      throw new Error('DuckDB policy requires exactly one SELECT statement.');
    }
    return result.statements[0];
  }

  async #hasUnsafeFunction(functionNames: readonly string[]): Promise<boolean> {
    const names = [...new Set(functionNames.map(caseFold))];
    if (names.length === 0) return false;

    const literals = names
      .map((name) => `'${name.replaceAll("'", "''")}'`)
      .join(', ');
    const rows = readRows(
      await this.#query(`
        SELECT function_name, has_side_effects, internal
        FROM duckdb_functions()
        WHERE lower(function_name) IN (${literals})
      `),
    );

    return rows.some(
      (row) => row.has_side_effects === true || row.internal === false,
    );
  }
}

function analyzeAst(
  ast: unknown,
  namespace: Namespace,
): { relations: string[]; functions: string[]; tableFunctions: string[] } {
  const cteNames = new Set<string>();
  const relations = new Set<string>();
  const functions = new Set<string>();
  const tableFunctions = new Set<string>();

  visit(ast, (node) => {
    if (Array.isArray(node.map)) {
      for (const entry of node.map) {
        if (isRecord(entry) && typeof entry.key === 'string') {
          cteNames.add(caseFold(entry.key));
        }
      }
    }
  });

  visit(ast, (node) => {
    if (node.type === 'BASE_TABLE' && typeof node.table_name === 'string') {
      const unqualifiedCte =
        node.catalog_name === undefined &&
        node.schema_name === undefined &&
        cteNames.has(caseFold(node.table_name));
      if (!unqualifiedCte) {
        relations.add(
          formatDuckDBIdentifierPath([
            typeof node.catalog_name === 'string'
              ? node.catalog_name
              : namespace.catalog,
            typeof node.schema_name === 'string'
              ? node.schema_name
              : namespace.schema,
            node.table_name,
          ]),
        );
      }
    }

    if (node.class === 'FUNCTION' && typeof node.function_name === 'string') {
      functions.add(node.function_name);
    }

    if (node.type === 'TABLE_FUNCTION') {
      const fn = node.function;
      if (!isRecord(fn) || typeof fn.function_name !== 'string') {
        throw new Error('DuckDB table function has an unknown AST shape.');
      }
      tableFunctions.add(fn.function_name);
    }
  });

  return {
    relations: [...relations],
    functions: [...functions],
    tableFunctions: [...tableFunctions],
  };
}

function visit(
  value: unknown,
  callback: (node: Record<string, unknown>) => void,
): void {
  if (Array.isArray(value)) {
    for (const item of value) visit(item, callback);
    return;
  }
  if (!isRecord(value)) return;
  callback(value);
  for (const child of Object.values(value)) visit(child, callback);
}

function qualifyAllowedRelation(name: string, namespace: Namespace): string {
  const relation = parseDuckDBRelationName(name);
  return formatDuckDBIdentifierPath([
    relation.catalog ?? namespace.catalog,
    relation.schema ?? namespace.schema,
    relation.table,
  ]);
}

function readRows(result: unknown): Record<string, unknown>[] {
  const rows = Array.isArray(result)
    ? result
    : isRecord(result) && Array.isArray(result.data)
      ? result.data
      : isRecord(result) && Array.isArray(result.rows)
        ? result.rows
        : undefined;
  if (!rows || rows.some((row) => !isRecord(row))) {
    throw new Error(
      'DuckDB execute() must return row objects as an array, { data }, or { rows }.',
    );
  }
  return rows;
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

class DuckDBSerializationError extends Error {}

function isReadOnlySerializationError(
  error: unknown,
): error is DuckDBSerializationError {
  return error instanceof DuckDBSerializationError;
}

function caseFold(value: string): string {
  return value.toLocaleLowerCase('en-US');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
