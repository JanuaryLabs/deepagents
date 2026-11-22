import { buildScopeParseErrorPayload } from '../../sql-scope-error.ts';
import type {
  SqlPolicyAnalyzer,
  SqlPolicyContext,
  SqlPolicyViolation,
} from '../sql-policy.ts';

/** What a rule reads besides the facts: the SQL and its grounded scope. */
export interface PolicyCheck extends SqlPolicyContext {
  readonly sql: string;
}

/**
 * Reads SQL into facts. A fact is computed when a rule first asks for it and
 * is kept for that read, so a rule that is never reached costs nothing.
 */
export interface FactSource<F> {
  /** The dialect that a parse error names. */
  readonly dialect: string;
  read(sql: string): F;
}

/**
 * One check over the facts of a source. `check` is a property, not a method,
 * so TypeScript compares its parameter strictly: a rule over facts that the
 * source does not give does not compile.
 */
export interface Rule<in F> {
  readonly check: (
    facts: F,
    check: PolicyCheck,
  ) => Promise<SqlPolicyViolation | null>;
}

/**
 * A source could not read the SQL. A policy turns this error, and only this
 * error, into an SQL_SCOPE_PARSE_ERROR; every other error rejects the check.
 */
export class UnreadableSql extends Error {
  override readonly name = 'UnreadableSql';
}

/**
 * One fact source and its rules, in order. The first violation wins, so the
 * rules after it never ask for their facts.
 */
export class SourcePolicy<F> implements SqlPolicyAnalyzer {
  readonly #source: FactSource<F>;
  readonly #rules: readonly Rule<F>[];

  constructor(
    source: FactSource<F>,
    rules: readonly [Rule<NoInfer<F>>, ...Rule<NoInfer<F>>[]],
  ) {
    this.#source = source;
    this.#rules = rules;
  }

  async analyze(
    sql: string,
    context: SqlPolicyContext,
  ): Promise<SqlPolicyViolation | null> {
    const check: PolicyCheck = {
      sql,
      resolveAllowedEntities: () => context.resolveAllowedEntities(),
    };
    try {
      const facts = this.#source.read(sql);
      for (const rule of this.#rules) {
        const violation = await rule.check(facts, check);
        if (violation) return violation;
      }
      return null;
    } catch (error) {
      if (!(error instanceof UnreadableSql)) throw error;
      return {
        kind: 'scope',
        payload: buildScopeParseErrorPayload(sql, this.#source.dialect, error),
      };
    }
  }
}

/** Policies in order. The first violation wins. */
export class FirstViolation implements SqlPolicyAnalyzer {
  readonly #policies: readonly SqlPolicyAnalyzer[];

  constructor(
    ...policies: [SqlPolicyAnalyzer, SqlPolicyAnalyzer, ...SqlPolicyAnalyzer[]]
  ) {
    this.#policies = policies;
  }

  async analyze(
    sql: string,
    context: SqlPolicyContext,
  ): Promise<SqlPolicyViolation | null> {
    for (const policy of this.#policies) {
      const violation = await policy.analyze(sql, context);
      if (violation) return violation;
    }
    return null;
  }
}
