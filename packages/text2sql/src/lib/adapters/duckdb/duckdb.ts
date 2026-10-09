import pMemoize from 'p-memoize';
import { z } from 'zod';

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

const namespaceRow = z.object({ catalog: z.string(), schema: z.string() });

export interface DuckDBAdapterOptions {
  execute: ExecuteFunction;
  validate?: ValidateFunction;
  grounding?: GroundingFn[];
  catalogs?: string[];
  schemas?: string[];
}

export class DuckDB extends Adapter {
  readonly #options: DuckDBAdapterOptions;
  /** Kept once it loads; a failed lookup is tried again on the next call. */
  readonly #namespace: () => Promise<{ catalog: string; schema: string }>;

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
    this.#namespace = pMemoize(() => this.#loadNamespace());
    this.grounding = options.grounding ?? [];
  }

  get catalogs(): readonly string[] | undefined {
    return this.#options.catalogs;
  }

  get schemas(): readonly string[] | undefined {
    return this.#options.schemas;
  }

  override async executeImpl(sql: string): Promise<unknown[]> {
    return this.rowsFrom(await this.#options.execute(sql), ['data', 'rows']);
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

  protected override async queryRows(sql: string): Promise<unknown[]> {
    return this.rowsFrom(await this.#options.execute(sql), ['data', 'rows']);
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
    return this.#namespace();
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
    const rows = await this.runQuery(
      `
      SELECT current_database() AS catalog, current_schema() AS schema
    `,
      namespaceRow,
    );
    const row = rows.at(0);
    if (rows.length !== 1 || !row) {
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
