import type { SQLScopeErrorPayload } from '../../agents/exceptions.ts';
import { buildScopeParseErrorPayload } from '../../sql-scope-error.ts';
import type {
  SqlPolicyAnalyzer,
  SqlPolicyContext,
  SqlPolicyViolation,
} from '../sql-policy.ts';
import type {
  PostHogMetadataResponse,
  PostHogNotice,
  PostHogTransport,
} from './types.ts';

export class PostHogSqlPolicyAnalyzer implements SqlPolicyAnalyzer {
  readonly #transport: PostHogTransport;

  constructor(transport: PostHogTransport) {
    this.#transport = transport;
  }

  async analyze(
    sql: string,
    context: SqlPolicyContext,
  ): Promise<SqlPolicyViolation | null> {
    const response = await this.#transport.query<PostHogMetadataResponse>({
      query: { kind: 'HogQLMetadata', language: 'hogQL', query: sql },
      name: 'deepagents_text2sql_validate',
    });
    let metadata: PostHogMetadataResponse;
    try {
      metadata = validateMetadataResponse(response);
    } catch (error) {
      return {
        kind: 'scope',
        payload: buildScopeParseErrorPayload(sql, 'hogql', error),
      };
    }

    const allowedEntities = await context.resolveAllowedEntities();
    const allowed = new Set(allowedEntities.map(caseFold));
    const rejected = metadata.table_names.filter(
      (entity) => !allowed.has(caseFold(entity)),
    );

    return rejected.length > 0
      ? {
          kind: 'scope',
          payload: buildOutOfScopePayload(sql, rejected, [...allowedEntities]),
        }
      : null;
  }
}

function validateMetadataResponse(value: unknown): PostHogMetadataResponse {
  if (!isRecord(value)) {
    throw new Error('PostHog HogQLMetadata response must be a JSON object.');
  }
  if (typeof value.isValid !== 'boolean') {
    throw new Error('PostHog HogQLMetadata response has no isValid boolean.');
  }

  const errors = validateNotices(value.errors, 'errors');
  validateNotices(value.warnings, 'warnings');
  validateNotices(value.notices, 'notices');
  const tableNames = validateTableNames(value.table_names);

  if (!value.isValid || errors.length > 0) {
    const reason = errors.map((notice) => notice.message).join('; ');
    throw new Error(
      reason
        ? `PostHog rejected the HogQL query: ${reason}`
        : 'PostHog rejected the HogQL query as invalid.',
    );
  }

  return {
    isValid: true,
    errors,
    warnings: value.warnings as PostHogNotice[],
    notices: value.notices as PostHogNotice[],
    table_names: tableNames,
  };
}

function validateNotices(value: unknown, name: string): PostHogNotice[] {
  if (!Array.isArray(value)) {
    throw new Error(`PostHog HogQLMetadata response has no ${name} array.`);
  }
  for (const notice of value) {
    if (!isRecord(notice) || typeof notice.message !== 'string') {
      throw new Error(
        `PostHog HogQLMetadata response has an invalid ${name} notice.`,
      );
    }
  }
  return value as PostHogNotice[];
}

function validateTableNames(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.some((name) => typeof name !== 'string' || name.length === 0)
  ) {
    throw new Error('PostHog HogQLMetadata response has invalid table_names.');
  }
  return [...new Set(value)];
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

function caseFold(value: string): string {
  return value.toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
