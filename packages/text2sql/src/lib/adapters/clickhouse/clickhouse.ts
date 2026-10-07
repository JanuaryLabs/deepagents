import {
  Adapter,
  type ExecuteFunction,
  type GroundingFn,
  type ValidateFunction,
} from '../adapter.ts';
import { ClickHouseSqlPolicyAnalyzer } from './clickhouse.sql-policy.ts';

export interface ClickHouseAdapterOptions {
  execute: ExecuteFunction;
  validate: ValidateFunction;
  grounding?: GroundingFn[];
  defaultDatabase?: string;
}

export class ClickHouse extends Adapter {
  readonly #options: ClickHouseAdapterOptions;

  override readonly grounding: GroundingFn[];
  override readonly defaultSchema: string | undefined;
  override readonly systemSchemas = [
    'system',
    'information_schema',
    'INFORMATION_SCHEMA',
  ];
  override readonly formatterLanguage = 'clickhouse';

  constructor(options: ClickHouseAdapterOptions) {
    if (!options || typeof options.execute !== 'function') {
      throw new Error('ClickHouse adapter requires an execute(sql) function.');
    }
    if (typeof options.validate !== 'function') {
      throw new Error('ClickHouse adapter requires a validate(sql) function.');
    }

    super(new ClickHouseSqlPolicyAnalyzer(options.execute));
    this.#options = options;
    this.grounding = options.grounding ?? [];
    this.defaultSchema = options.defaultDatabase;
  }

  override async executeImpl(sql: string): Promise<unknown[]> {
    return this.rowsFrom(await this.#options.execute(sql), ['data', 'rows']);
  }

  override async validateImpl(sql: string): Promise<string | void> {
    try {
      return await this.#options.validate(sql);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return JSON.stringify({
        error: message,
        error_type: 'CLICKHOUSE_ERROR',
        suggestion:
          'Review the ClickHouse syntax and verify referenced databases, tables, columns, and functions.',
        sql_attempted: sql,
      });
    }
  }

  protected override async queryRows(sql: string): Promise<unknown[]> {
    return this.rowsFrom(await this.#options.execute(sql), ['data', 'rows']);
  }

  override quoteIdentifier(name: string): string {
    return `\`${name.replace(/`/g, '``')}\``;
  }

  override escape(value: string): string {
    return value.replace(/`/g, '``');
  }

  override buildSampleRowsQuery(
    tableName: string,
    columns: string[] | undefined,
    limit: number,
  ): string {
    const { schema, table } = this.parseTableName(tableName);
    const relation = schema
      ? `${this.quoteIdentifier(schema)}.${this.quoteIdentifier(table)}`
      : this.quoteIdentifier(table);
    const projection = columns?.length
      ? columns.map((column) => this.quoteIdentifier(column)).join(', ')
      : '*';
    return `SELECT ${projection} FROM ${relation} LIMIT ${limit}`;
  }
}
