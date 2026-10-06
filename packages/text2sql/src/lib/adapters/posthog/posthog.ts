import { z } from 'zod';

import { Adapter, type GroundingFn } from '../adapter.ts';
import { PostHogSqlPolicyAnalyzer } from './posthog.sql-policy.ts';
import type {
  PostHogQueryRequest,
  PostHogQueryResponse,
  PostHogQueryValues,
  PostHogTransport,
} from './types.ts';

export interface PostHogAdapterOptions {
  transport: PostHogTransport;
  grounding?: GroundingFn[];
}

/** A HogQLQuery response: one array per row, cells in column order. */
const hogQLQueryResponse = z.object({
  results: z.array(z.array(z.unknown())),
  columns: z.array(z.string().min(1)).optional(),
});

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

  override async execute(
    sql: string,
    values?: PostHogQueryValues,
  ): Promise<Record<string, unknown>[]> {
    return this.#execute(
      await this.enforceExecutionPolicy(sql),
      'deepagents_text2sql_execute',
      values,
    );
  }

  override async executeImpl(sql: string): Promise<Record<string, unknown>[]> {
    return this.#execute(sql, 'deepagents_text2sql_execute');
  }

  override validateImpl(): undefined {
    return undefined;
  }

  protected override queryRows(sql: string): Promise<unknown[]> {
    return this.#execute(sql, 'deepagents_text2sql_grounding');
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

  async query(request: PostHogQueryRequest): Promise<unknown> {
    return this.transport.query(request);
  }

  async #execute(
    sql: string,
    name: string,
    values?: PostHogQueryValues,
  ): Promise<Record<string, unknown>[]> {
    const response = await this.transport.query({
      query: {
        kind: 'HogQLQuery',
        query: sql,
        ...(values === undefined ? {} : { values }),
      },
      name,
    });
    return rowsFromResponse(response);
  }
}

function rowsFromResponse(value: unknown): Record<string, unknown>[] {
  const response = hogQLQueryResponse.safeParse(value);
  if (!response.success) {
    throw new Error(
      `PostHog HogQLQuery response is malformed:\n${z.prettifyError(response.error)}`,
    );
  }
  const { columns, results } = response.data;
  if (columns && new Set(columns).size !== columns.length) {
    throw new Error(
      'PostHog HogQLQuery response contains duplicate column names; alias every selected expression uniquely.',
    );
  }
  if (results.length === 0) return [];
  if (!columns) {
    throw new Error(
      'PostHog HogQLQuery response requires columns for non-empty results.',
    );
  }

  return results.map((row, index) => {
    if (row.length !== columns.length) {
      throw new Error(
        `PostHog HogQLQuery result row ${index} does not match the column count.`,
      );
    }
    return Object.fromEntries(
      columns.map((column, columnIndex) => [column, row[columnIndex]]),
    );
  });
}
