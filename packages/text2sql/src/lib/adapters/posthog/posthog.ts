import { Adapter, type GroundingFn } from '../adapter.ts';
import { PostHogSqlPolicyAnalyzer } from './posthog.sql-policy.ts';
import type {
  PostHogQueryRequest,
  PostHogQueryResponse,
  PostHogTransport,
} from './types.ts';

export interface PostHogAdapterOptions {
  transport: PostHogTransport;
  grounding?: GroundingFn[];
}

export class PostHog extends Adapter {
  readonly transport: PostHogTransport;
  override readonly grounding: GroundingFn[];
  override readonly defaultSchema = undefined;
  override readonly systemSchemas = ['system'];
  override readonly formatterLanguage = 'clickhouse';

  constructor(options: PostHogAdapterOptions) {
    if (!options?.transport || typeof options.transport.query !== 'function') {
      throw new Error('PostHog adapter requires a transport.');
    }
    if (
      typeof options.transport.listEventDefinitions !== 'function' ||
      typeof options.transport.listPropertyDefinitions !== 'function'
    ) {
      throw new Error(
        'PostHog transport must provide event and property definition methods.',
      );
    }

    super(new PostHogSqlPolicyAnalyzer(options.transport));
    this.transport = options.transport;
    this.grounding = options.grounding ?? [];
  }

  override async executeImpl(sql: string): Promise<Record<string, unknown>[]> {
    return this.#execute(sql, 'deepagents_text2sql_execute');
  }

  override validateImpl(): undefined {
    return undefined;
  }

  override async runQuery<Row>(sql: string): Promise<Row[]> {
    return (await this.#execute(sql, 'deepagents_text2sql_grounding')) as Row[];
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

  async query<T>(request: PostHogQueryRequest): Promise<T> {
    return this.transport.query<T>(request);
  }

  async #execute(
    sql: string,
    name: string,
  ): Promise<Record<string, unknown>[]> {
    const response = await this.transport.query<PostHogQueryResponse>({
      query: { kind: 'HogQLQuery', query: sql },
      name,
    });
    return rowsFromResponse(response);
  }
}

function rowsFromResponse(value: unknown): Record<string, unknown>[] {
  if (!isRecord(value) || !Array.isArray(value.results)) {
    throw new Error('PostHog HogQLQuery response has no results array.');
  }
  if (
    value.columns !== undefined &&
    (!Array.isArray(value.columns) ||
      value.columns.some(
        (column) => typeof column !== 'string' || column.length === 0,
      ))
  ) {
    throw new Error('PostHog HogQLQuery response has invalid columns.');
  }
  if (
    Array.isArray(value.columns) &&
    new Set(value.columns).size !== value.columns.length
  ) {
    throw new Error(
      'PostHog HogQLQuery response contains duplicate column names; alias every selected expression uniquely.',
    );
  }
  if (value.results.length === 0) return [];
  if (!Array.isArray(value.columns)) {
    throw new Error(
      'PostHog HogQLQuery response requires columns for non-empty results.',
    );
  }

  const columns = value.columns as string[];
  return value.results.map((row, index) => {
    if (!Array.isArray(row) || row.length !== columns.length) {
      throw new Error(
        `PostHog HogQLQuery result row ${index} does not match the column count.`,
      );
    }
    return Object.fromEntries(
      columns.map((column, columnIndex) => [column, row[columnIndex]]),
    );
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
