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
  PostHogDatabaseFieldType,
  PostHogDatabaseTable,
  PostHogDatabaseTableType,
  PostHogSchemaJoin,
  PostHogSchemaResponse,
} from './types.ts';

const SCALAR_FIELD_TYPES = new Set<PostHogDatabaseFieldType>([
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

const FIELD_TYPES = new Set<PostHogDatabaseFieldType>([
  ...SCALAR_FIELD_TYPES,
  'lazy_table',
  'virtual_table',
  'field_traverser',
  'expression',
  'view',
  'materialized_view',
  'unknown',
]);

const TABLE_TYPES = new Set<PostHogDatabaseTableType>([
  'posthog',
  'system',
  'data_warehouse',
  'view',
  'batch_export',
  'materialized_view',
  'managed_view',
  'endpoint',
]);

const VIEW_TYPES = new Set<PostHogDatabaseTableType>([
  'view',
  'materialized_view',
  'managed_view',
  'endpoint',
]);

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
      await this.#adapter.query<PostHogSchemaResponse>({
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
  if (
    !isRecord(value) ||
    !isRecord(value.tables) ||
    !Array.isArray(value.joins)
  ) {
    throw new Error(
      'PostHog DatabaseSchemaQuery response must contain tables and joins.',
    );
  }

  for (const [name, valueTable] of Object.entries(value.tables)) {
    if (!isRecord(valueTable)) {
      throw new Error(`PostHog schema table ${name} must be an object.`);
    }
    if (!TABLE_TYPES.has(valueTable.type as PostHogDatabaseTableType)) {
      throw new Error(`PostHog schema table ${name} has an unknown type.`);
    }
    if (
      typeof valueTable.id !== 'string' ||
      typeof valueTable.name !== 'string' ||
      !isRecord(valueTable.fields)
    ) {
      throw new Error(`PostHog schema table ${name} is malformed.`);
    }
    if (
      valueTable.row_count !== undefined &&
      valueTable.row_count !== null &&
      (typeof valueTable.row_count !== 'number' ||
        !Number.isFinite(valueTable.row_count) ||
        valueTable.row_count < 0)
    ) {
      throw new Error(`PostHog schema table ${name} has an invalid row_count.`);
    }
    if (
      VIEW_TYPES.has(valueTable.type as PostHogDatabaseTableType) &&
      (!isRecord(valueTable.query) ||
        typeof valueTable.query.query !== 'string')
    ) {
      throw new Error(`PostHog schema view ${name} has an invalid query.`);
    }
    validateFields(name, valueTable.fields);
  }
  for (const join of value.joins) {
    if (!isRecord(join)) {
      throw new Error('PostHog schema contains a malformed join.');
    }
  }

  return value as unknown as PostHogSchemaResponse;
}

function validateFields(
  tableName: string,
  fields: Record<string, unknown>,
): void {
  for (const [name, value] of Object.entries(fields)) {
    if (
      !isRecord(value) ||
      typeof value.name !== 'string' ||
      typeof value.hogql_value !== 'string' ||
      typeof value.schema_valid !== 'boolean' ||
      !FIELD_TYPES.has(value.type as PostHogDatabaseFieldType)
    ) {
      throw new Error(
        `PostHog schema field ${tableName}.${name} is malformed or has an unknown type.`,
      );
    }
  }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
