import type { SQLScopeErrorPayload } from '../agents/exceptions.ts';

export type SqlPolicyViolation =
  | { kind: 'read-only'; message: string }
  | { kind: 'scope'; payload: SQLScopeErrorPayload };

export interface SqlPolicyContext {
  resolveAllowedEntities(): Promise<readonly string[]>;
}

/**
 * Strategy used by an adapter to decide whether SQL may reach its validator or
 * executor. Implementations may analyze locally or ask the database server.
 */
export interface SqlPolicyAnalyzer {
  analyze(
    sql: string,
    context: SqlPolicyContext,
  ): Promise<SqlPolicyViolation | null>;
}
