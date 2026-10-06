import { z } from 'zod';

import type { Filter, Relationship, Table } from '../adapter.ts';
import {
  AbstractGrounding,
  type ColumnsFilter,
  applyColumnFilter,
} from '../groundings/abstract.grounding.ts';
import type { GroundingContext } from '../groundings/context.ts';
import type { View } from '../groundings/view.grounding.ts';
import type { PostHog } from './posthog.ts';
import type {
  PostHogDatabaseField,
  PostHogDatabaseFieldType,
  PostHogDatabaseTable,
  PostHogDatabaseTableType,
  PostHogSchemaJoin,
  PostHogSchemaResponse,
} from './types.ts';

// The DatabaseSchemaQuery response, modeled on PostHog's DatabaseSchemaQueryResponse.
// Only the members this grounding reads are checked; the rest is dropped.

const scalarFieldType = z.enum([
  'integer',
  'float',
  'decimal',
  'string',
  'datetime',
  'date',
  'boolean',
  'array',
  'json',
]);

const SCALAR_FIELD_TYPES = new Set<PostHogDatabaseFieldType>(
  scalarFieldType.options,
);

const viewTableType = z.enum([
  'view',
  'materialized_view',
  'managed_view',
  'endpoint',
]);

const VIEW_TYPES = new Set<PostHogDatabaseTableType>(viewTableType.options);

const postHogDatabaseField = z.object({
  name: z.string(),
  hogql_value: z.string(),
  type: z.enum([
    ...scalarFieldType.options,
    'lazy_table',
    'virtual_table',
    'field_traverser',
    'expression',
    'view',
    'materialized_view',
    'unknown',
  ]),
  schema_valid: z.boolean(),
});

const tableMembers = {
  id: z.string(),
  name: z.string(),
  fields: z.record(z.string(), postHogDatabaseField),
  row_count: z.number().nonnegative().nullish(),
};

const postHogDatabaseTable = z.discriminatedUnion('type', [
  z.object({
    ...tableMembers,
    type: z.enum(['posthog', 'system', 'data_warehouse', 'batch_export']),
  }),
  z.object({
    ...tableMembers,
    type: viewTableType,
    query: z.object({ query: z.string() }),
  }),
]);

const postHogSchemaJoin = z.object({
  source_table_name: z.string().nullish(),
  source_table_key: z.string().nullish(),
  joining_table_name: z.string().nullish(),
  joining_table_key: z.string().nullish(),
  field_name: z.string().nullish(),
});

const postHogSchemaResponse = z.object({
  tables: z.record(z.string(), postHogDatabaseTable),
  joins: z.array(postHogSchemaJoin),
});

export interface PostHogSchemaGroundingConfig {
  filter?: Filter;
  columns?: ColumnsFilter;
  includeSystem?: boolean;
}

export class PostHogSchemaGrounding extends AbstractGrounding {
  readonly #adapter: PostHog;
  readonly #config: PostHogSchemaGroundingConfig;

  constructor(adapter: PostHog, config: PostHogSchemaGroundingConfig = {}) {
    super('schema', 'tables');
    this.#adapter = adapter;
    this.#config = config;
  }

  override async execute(ctx: GroundingContext): Promise<void> {
    const response = validateSchemaResponse(
      await this.#adapter.query({
        query: { kind: 'DatabaseSchemaQuery' },
        name: 'deepagents_text2sql_schema',
      }),
    );
    const entities = Object.entries(response.tables).filter(
      ([name, table]) =>
        (this.#config.includeSystem || table.type !== 'system') &&
        matchesFilter(name, this.#config.filter),
    );

    const tables: Table[] = [];
    const views: View[] = [];
    for (const [index, [name, table]] of entities.entries()) {
      ctx.onProgress({
        type: 'phase:progress',
        phase: 'tables',
        table: name,
        message: `Loading PostHog schema entity ${name}...`,
        current: index + 1,
        total: entities.length,
      });
      const columns = readColumns(name, table);
      if (VIEW_TYPES.has(table.type)) {
        views.push(
          applyColumnFilter(
            {
              name,
              columns,
              ...(table.query?.query ? { definition: table.query.query } : {}),
            },
            this.#config.columns,
          ),
        );
      } else {
        tables.push(
          applyColumnFilter(
            {
              name,
              columns,
              ...(typeof table.row_count === 'number'
                ? { rowCount: table.row_count }
                : {}),
            },
            this.#config.columns,
          ),
        );
      }
    }

    ctx.tables.push(...tables);
    ctx.views.push(...views);
    ctx.relationships.push(...readRelationships(response.joins, tables, views));
  }

  override async contributeEntities(ctx: GroundingContext): Promise<void> {
    await this.execute(ctx);
  }
}

function validateSchemaResponse(value: unknown): PostHogSchemaResponse {
  const response = postHogSchemaResponse.safeParse(value);
  if (!response.success) {
    throw new Error(
      `PostHog DatabaseSchemaQuery response is malformed:\n${z.prettifyError(response.error)}`,
    );
  }
  return response.data;
}

function readColumns(
  tableName: string,
  table: PostHogDatabaseTable,
): Array<{ name: string; type: string }> {
  const columns: Array<{ name: string; type: string }> = [];
  const names = new Set<string>();
  for (const field of Object.values(table.fields)) {
    if (!field.schema_valid || !SCALAR_FIELD_TYPES.has(field.type)) continue;
    const name = field.hogql_value.trim();
    if (!name) {
      throw new Error(`PostHog schema table ${tableName} has an empty field.`);
    }
    if (names.has(name)) {
      throw new Error(
        `PostHog schema table ${tableName} has duplicate HogQL field ${name}.`,
      );
    }
    names.add(name);
    columns.push({ name, type: field.type });
  }
  return columns;
}

function readRelationships(
  joins: PostHogSchemaJoin[],
  tables: Table[],
  views: View[],
): Relationship[] {
  const entityColumns = new Map(
    [...tables, ...views].map((entity) => [
      entity.name,
      new Set(entity.columns.map((column) => column.name)),
    ]),
  );
  return joins.flatMap((join) => {
    const sourceTable = readNonEmptyString(join.source_table_name);
    const sourceKey = readNonEmptyString(join.source_table_key);
    const joiningTable = readNonEmptyString(join.joining_table_name);
    const joiningKey = readNonEmptyString(join.joining_table_key);
    if (
      !sourceTable ||
      !sourceKey ||
      !joiningTable ||
      !joiningKey ||
      !entityColumns.get(sourceTable)?.has(sourceKey) ||
      !entityColumns.get(joiningTable)?.has(joiningKey)
    ) {
      return [];
    }
    return [
      {
        table: sourceTable,
        from: [sourceKey],
        referenced_table: joiningTable,
        to: [joiningKey],
      },
    ];
  });
}

function matchesFilter(name: string, filter?: Filter): boolean {
  if (!filter) return true;
  if (Array.isArray(filter)) return filter.includes(name);
  if (filter instanceof RegExp) {
    filter.lastIndex = 0;
    return filter.test(name);
  }
  return filter(name);
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
