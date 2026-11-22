import { z } from 'zod';

import { buildOutOfScopePayload } from '../../sql-scope-error.ts';
import type { Statement, Statements } from '../policy/facts.ts';
import { OneSelect } from '../policy/one-select.ts';
import { readOnly } from '../policy/read-only.ts';
import {
  type FactSource,
  type PolicyCheck,
  type Rule,
  SourcePolicy,
  UnreadableSql,
} from '../policy/source-policy.ts';
import type { SqlPolicyViolation } from '../sql-policy.ts';

/** A connection of its own to the database, closed when it is disposed. */
export interface SqlServerSession extends AsyncDisposable {
  /**
   * Runs one batch and gives the rows of every result set it returns. It
   * rejects with the driver's error, whose `number` is SQL Server's error
   * number.
   */
  batch(sql: string): Promise<readonly Record<string, unknown>[]>;
}

/**
 * The database user that compiles the SQL. The host's execute runs the SQL as
 * this user too, so the check and the run resolve a name such as `users` in
 * the same default schema.
 */
export interface SqlServerPrincipal {
  readonly name: string;
  session(): Promise<SqlServerSession>;
}

/** The refusals of the database for the principal, in SQL Server's words. */
export interface Grants {
  denials(): Promise<readonly string[]>;
}

/** The physical operators of the plans, such as `Clustered Index Scan`. */
export interface PlanOperators {
  operators(): Promise<ReadonlySet<string>>;
}

export type PlanFacts = Statements & Grants & PlanOperators;

type Compile =
  | { readonly kind: 'plans'; readonly plans: readonly string[] }
  | { readonly kind: 'denied'; readonly denial: string };

const sqlServerError = z.object({ number: z.number(), message: z.string() });
const showplanRows = z.array(z.record(z.string(), z.string()));

/**
 * The permission error on an object, such as "The INSERT permission was
 * denied on the object 'orders' ...". Under SHOWPLAN_XML a write compiles to
 * this error, and DDL compiles to a plan without a permission check.
 */
const permissionDenied = 229;

// SQL Server escapes `<`, `>` and `"` in an attribute value such as
// StatementText, so the first `>` ends the tag.
const statementTag = /<(Stmt\w+)\b([^>]*)>/g;
const statementType = /\sStatementType="([^"]*)"/;
const physicalOp = /\sPhysicalOp="([^"]*)"/g;

/**
 * Reads SQL by SQL Server's own compile: the principal compiles the SQL under
 * `SET SHOWPLAN_XML ON`, which plans each statement and runs none. A plan
 * names the base tables after views, synonyms and functions are expanded, so
 * it gives no `Relations`, and a lock hint leaves the plan the same, so it
 * gives no `Constructs`.
 *
 * A compile that SQL Server refuses with a permission error on an object
 * (229) gives that error as a denial, and it has no statements and no
 * operators: those facts throw, so a policy without `GrantedScope` rejects
 * the check. A compile that fails with any other error is unreadable, such as
 * 102 for `LIMIT`, 208 for an unknown table and 262 for a principal without
 * SHOWPLAN. SQL Server checks SHOWPLAN only for a plan that reads an object
 * of the database, so no compile of the policy's own can test it first.
 */
export class SqlServerPlan implements FactSource<PlanFacts> {
  readonly dialect = 'transactsql';
  readonly #principal: SqlServerPrincipal;

  constructor(principal: SqlServerPrincipal) {
    this.#principal = principal;
  }

  read(sql: string): PlanFacts {
    let compiled: Promise<Compile> | undefined;
    const compile = () => (compiled ??= this.#compile(sql));
    const plans = async () => {
      const result = await compile();
      if (result.kind === 'denied') throw new Error(result.denial);
      return result.plans;
    };

    return {
      statements: async () => (await plans()).flatMap(statementsOf),
      denials: async () => {
        const result = await compile();
        return result.kind === 'denied' ? [result.denial] : [];
      },
      operators: async () =>
        new Set(
          (await plans()).flatMap((plan) =>
            Array.from(plan.matchAll(physicalOp), ([, op]) => op),
          ),
        ),
    };
  }

  /**
   * Each step is its own batch on a session of its own: SQL Server takes
   * `SET SHOWPLAN_XML ON` only alone in a batch (error 1067), and `WITH NO
   * REVERT` keeps the SQL from leaving the principal, so the session is
   * thrown away after the compile.
   */
  async #compile(sql: string): Promise<Compile> {
    await using session = await this.#principal.session();
    await session.batch(
      `EXECUTE AS USER = N'${this.#principal.name.replaceAll("'", "''")}' WITH NO REVERT`,
    );
    await session.batch('SET SHOWPLAN_XML ON');
    let rows: readonly Record<string, unknown>[];
    try {
      rows = await session.batch(sql);
    } catch (error) {
      const failure = sqlServerError.safeParse(error);
      if (!failure.success) throw error;
      if (failure.data.number === permissionDenied) {
        return { kind: 'denied', denial: failure.data.message };
      }
      throw new UnreadableSql(failure.data.message, { cause: error });
    }
    // Each row holds a plan as XML in its only column.
    return {
      kind: 'plans',
      plans: showplanRows.parse(rows).flatMap((row) => Object.values(row)),
    };
  }
}

function statementsOf(plan: string): Statement[] {
  return Array.from(
    plan.matchAll(statementTag),
    ([, tag, attributes]): Statement => {
      const type = statementType.exec(attributes)?.[1];
      if (type === 'SELECT' || type === 'SELECT WITHOUT QUERY') {
        return { kind: 'select' };
      }
      if (type === 'SELECT INTO') return { kind: 'select-into' };
      // The showplan schema makes StatementType optional; the tag names the
      // statement then.
      return { kind: 'other', name: type ?? tag };
    },
  );
}

/** The principal may compile the SQL: SQL Server refused no permission. */
export class GrantedScope implements Rule<Grants> {
  readonly check = async (
    facts: Grants,
    check: PolicyCheck,
  ): Promise<SqlPolicyViolation | null> => {
    const denials = await facts.denials();
    return denials.length === 0
      ? null
      : {
          kind: 'scope',
          payload: buildOutOfScopePayload(check.sql, {
            denial: denials.join('\n'),
          }),
        };
  };
}

/** The plans use no linked server: no operator is a `Remote` one. */
export class NoRemoteOperators implements Rule<PlanOperators> {
  readonly check = async (facts: PlanOperators) => {
    const operators = await facts.operators();
    return [...operators].some((op) => op.startsWith('Remote'))
      ? readOnly
      : null;
  };
}

/**
 * The policy that SQL Server's own compile decides: the principal's grants
 * decide the scope, the plan decides that the SQL is one SELECT, and no plan
 * reads a linked server.
 */
export function planPolicy(principal: SqlServerPrincipal) {
  return new SourcePolicy(new SqlServerPlan(principal), [
    new GrantedScope(),
    new OneSelect(),
    new NoRemoteOperators(),
  ]);
}
