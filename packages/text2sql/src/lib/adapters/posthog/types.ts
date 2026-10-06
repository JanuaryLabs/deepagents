export type PostHogPropertyDefinitionType =
  'event' | 'person' | 'session' | 'group';

export type PostHogQueryValues = Record<string, unknown>;

export type PostHogQueryNode =
  | {
      kind: 'HogQLQuery';
      query: string;
      values?: PostHogQueryValues;
    }
  | { kind: 'HogQLMetadata'; language: 'hogQL'; query: string }
  | { kind: 'DatabaseSchemaQuery' };

export interface PostHogQueryRequest {
  query: PostHogQueryNode;
  name?: string;
}

/**
 * PostHog serializes HogQLNotice with Pydantic, whose unset optional fields
 * may arrive as null.
 */
export interface PostHogNotice {
  start?: number | null;
  end?: number | null;
  message: string;
  fix?: string | null;
}

export interface PostHogMetadataResponse {
  isValid?: boolean;
  errors: PostHogNotice[];
  warnings: PostHogNotice[];
  notices: PostHogNotice[];
  table_names: string[];
}

export interface PostHogQueryResponse {
  results: unknown[][];
  columns?: unknown[];
  types?: unknown[];
}

export type PostHogDatabaseFieldType =
  | 'integer'
  | 'float'
  | 'decimal'
  | 'string'
  | 'datetime'
  | 'date'
  | 'boolean'
  | 'array'
  | 'json'
  | 'lazy_table'
  | 'virtual_table'
  | 'field_traverser'
  | 'expression'
  | 'view'
  | 'materialized_view'
  | 'unknown';

export interface PostHogDatabaseField {
  name: string;
  hogql_value: string;
  type: PostHogDatabaseFieldType;
  schema_valid: boolean;
  table?: string;
  fields?: string[];
  chain?: Array<string | number>;
  id?: string;
}

export type PostHogDatabaseTableType =
  | 'posthog'
  | 'system'
  | 'data_warehouse'
  | 'view'
  | 'batch_export'
  | 'materialized_view'
  | 'managed_view'
  | 'endpoint';

export interface PostHogDatabaseTable {
  type: PostHogDatabaseTableType;
  id: string;
  name: string;
  fields: Record<string, PostHogDatabaseField>;
  row_count?: number | null;
  query?: { query: string };
}

export interface PostHogSchemaJoin {
  source_table_name?: string | null;
  source_table_key?: string | null;
  joining_table_name?: string | null;
  joining_table_key?: string | null;
  field_name?: string | null;
}

export interface PostHogSchemaResponse {
  tables: Record<string, PostHogDatabaseTable>;
  joins: PostHogSchemaJoin[];
}

export interface PostHogEventDefinition {
  name: string;
  description?: string | null;
  tags?: string[] | null;
  verified?: boolean | null;
}

export interface PostHogPropertyDefinition {
  name: string;
  description?: string | null;
  property_type?: string | null;
  is_numerical?: boolean | null;
  verified?: boolean | null;
}

/**
 * Moves PostHog API payloads. It returns them as received; the adapter and its
 * groundings validate each payload against the shape they need.
 */
export interface PostHogTransport {
  query(request: PostHogQueryRequest): Promise<unknown>;
  /** Event definitions, each a {@link PostHogEventDefinition}. */
  listEventDefinitions(): Promise<unknown[]>;
  /** Property definitions, each a {@link PostHogPropertyDefinition}. */
  listPropertyDefinitions(options: {
    type: PostHogPropertyDefinitionType;
    groupTypeIndex?: number;
  }): Promise<unknown[]>;
}

export interface CreatePostHogTransportOptions {
  host: string;
  projectId: string | number;
  getAccessToken: () => string | Promise<string>;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}
