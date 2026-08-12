import {
  Adapter,
  type ExecuteFunction,
  type GroundingFn,
  type ValidateFunction,
} from '../adapter.ts';
import {
  formatDuckDBIdentifierPath,
  parseDuckDBRelationName,
} from './duckdb-identifiers.ts';
import { DuckDBSqlPolicyAnalyzer } from './duckdb.sql-policy.ts';

export interface DuckDBAdapterOptions {
  execute: ExecuteFunction;
  validate?: ValidateFunction;
  grounding?: GroundingFn[];
  catalogs?: string[];
  schemas?: string[];
}

type RowResult<Row> = Row[] | { data: Row[] } | { rows: Row[] };

export class DuckDB extends Adapter {
  readonly #options: DuckDBAdapterOptions;
  #namespace?: Promise<{ catalog: string; schema: string }>;

  override readonly grounding: GroundingFn[];
  override readonly defaultSchema = 'main';
  override readonly systemSchemas = ['information_schema', 'pg_catalog'];
  override readonly formatterLanguage = 'duckdb';

  constructor(options: DuckDBAdapterOptions) {
    if (!options || typeof options.execute !== 'function') {
      throw new Error('DuckDB adapter requires an execute(sql) function.');
    }
    validateScopeOption('catalogs', options.catalogs);
    validateScopeOption('schemas', options.schemas);
    super(new DuckDBSqlPolicyAnalyzer(options.execute));
    this.#options = options;
    this.grounding = options.grounding ?? [];
  }

  get catalogs(): readonly string[] | undefined {
    return this.#options.catalogs;
  }

  get schemas(): readonly string[] | undefined {
    return this.#options.schemas;
  }

  override async executeImpl(sql: string): Promise<unknown[]> {
    return rowsFromResult(await this.#options.execute(sql));
  }

  override async validateImpl(sql: string): Promise<string | void> {
    try {
      if (this.#options.validate) return await this.#options.validate(sql);
      await this.#options.execute(`EXPLAIN ${sql}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return JSON.stringify({
        error: message,
        error_type: 'DUCKDB_ERROR',
        suggestion:
          'Review the DuckDB syntax and verify referenced catalogs, schemas, tables, columns, and functions.',
        sql_attempted: sql,
      });
    }
  }

  override async runQuery<Row>(sql: string): Promise<Row[]> {
    return rowsFromResult<Row>(await this.#options.execute(sql));
  }

  override quoteIdentifier(name: string): string {
    return formatDuckDBIdentifierPath([name]);
  }

  override escape(value: string): string {
    return value.replaceAll('"', '""');
  }

  override buildSampleRowsQuery(
    tableName: string,
    columns: string[] | undefined,
    limit: number,
  ): string {
    const relation = parseDuckDBRelationName(tableName);
    const path = [relation.catalog, relation.schema, relation.table].filter(
      (part): part is string => part !== undefined,
    );
    const projection = columns?.length
      ? columns.map((column) => this.quoteIdentifier(column)).join(', ')
      : '*';
    return `SELECT ${projection} FROM ${formatDuckDBIdentifierPath(path)} LIMIT ${limit}`;
  }

  async currentNamespace(): Promise<{ catalog: string; schema: string }> {
    return (this.#namespace ??= this.#loadNamespace());
  }

  async resolveRelationName(
    name: string,
  ): Promise<{ catalog: string; schema: string; table: string }> {
    const relation = parseDuckDBRelationName(name);
    const current = await this.currentNamespace();
    return {
      catalog: relation.catalog ?? current.catalog,
      schema: relation.schema ?? current.schema,
      table: relation.table,
    };
  }

  formatRelationName(catalog: string, schema: string, table: string): string {
    return formatDuckDBIdentifierPath([catalog, schema, table]);
  }

  quoteRelationName(name: string): string {
    const relation = parseDuckDBRelationName(name);
    return formatDuckDBIdentifierPath(
      [relation.catalog, relation.schema, relation.table].filter(
        (part): part is string => part !== undefined,
      ),
    );
  }

  async scopedNamespaces(): Promise<{ catalogs: string[]; schemas: string[] }> {
    const current = await this.currentNamespace();
    return {
      catalogs: [...(this.catalogs ?? [current.catalog])],
      schemas: [...(this.schemas ?? [current.schema])],
    };
  }

  async #loadNamespace(): Promise<{ catalog: string; schema: string }> {
    const rows = await this.runQuery<{ catalog: unknown; schema: unknown }>(`
      SELECT current_database() AS catalog, current_schema() AS schema
    `);
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
}

function validateScopeOption(name: string, values: string[] | undefined): void {
  if (
    values !== undefined &&
    (values.length === 0 || values.some((value) => !value))
  ) {
    throw new Error(`DuckDB ${name} must contain at least one non-empty name.`);
  }
}

function rowsFromResult<Row>(result: unknown): Row[] {
  if (Array.isArray(result)) return result as Row[];
  if (result && typeof result === 'object') {
    const candidate = result as Partial<RowResult<Row>> & {
      data?: unknown;
      rows?: unknown;
    };
    if (Array.isArray(candidate.data)) return candidate.data as Row[];
    if (Array.isArray(candidate.rows)) return candidate.rows as Row[];
  }
  throw new Error(
    'DuckDB execute() must return an array of rows, { data: rows }, or { rows }.',
  );
}
