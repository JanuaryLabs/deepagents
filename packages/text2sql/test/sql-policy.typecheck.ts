import {
  DeniedCalls,
  type FactSource,
  FirstViolation,
  Forbid,
  GroundedNames,
  InScope,
  OneSelect,
  type Relations,
  SourcePolicy,
  SqlText,
} from '@deepagents/text2sql/policy';
import * as sqlite from '@deepagents/text2sql/sqlite';
import {
  GrantedScope,
  NoRemoteOperators,
  SqlServer,
  SqlServerPlan,
  type SqlServerPrincipal,
} from '@deepagents/text2sql/sqlserver';
import * as sqlserver from '@deepagents/text2sql/sqlserver';

function verifySqlPolicyContract(
  relationsOnly: FactSource<Relations>,
  principal: SqlServerPrincipal,
) {
  const text = new SqlText({ dialects: ['transactsql'] });
  new SourcePolicy(text, [
    new OneSelect(),
    new DeniedCalls({ names: ['OPENQUERY'], prefixes: ['XP_'] }),
    new Forbid(['table-hint']),
    new InScope(new GroundedNames()),
  ]);

  new SourcePolicy(relationsOnly, [new InScope(new GroundedNames())]);
  new SourcePolicy(
    relationsOnly,
    // @ts-expect-error A source of relations gives no statements.
    [new OneSelect()],
  );
  new SourcePolicy(
    relationsOnly,
    // @ts-expect-error A source of relations gives no constructs.
    [new InScope(new GroundedNames()), new Forbid(['table-hint'])],
  );

  // @ts-expect-error A policy has at least one rule.
  new SourcePolicy(text, []);
  // @ts-expect-error SqlText tries at least one grammar.
  new SqlText({ dialects: [] });
  // @ts-expect-error Forbid forbids at least one construct.
  new Forbid([]);
  // @ts-expect-error A NOLOCK hint is a table hint, not a construct of its own.
  new Forbid(['nolock']);
  // @ts-expect-error FirstViolation composes two policies or more.
  new FirstViolation(sqlserver.textPolicy());

  new SqlServer({
    execute: () => [],
    grounding: [],
    policy: new FirstViolation(sqlserver.textPolicy(), sqlite.policy()),
  });

  const plan = new SqlServerPlan(principal);
  new SourcePolicy(plan, [
    new GrantedScope(),
    new OneSelect(),
    new NoRemoteOperators(),
  ]);
  new SqlServer({
    execute: () => [],
    grounding: [],
    policy: new FirstViolation(
      new SourcePolicy(text, [new Forbid(['table-hint'])]),
      sqlserver.planPolicy(principal),
    ),
  });
  new SourcePolicy(
    plan,
    // @ts-expect-error A plan names base tables only, so it gives no relations.
    [new InScope(new GroundedNames())],
  );
  new SourcePolicy(
    plan,
    // @ts-expect-error A lock hint leaves the plan the same, so a plan gives no constructs.
    [new Forbid(['table-hint'])],
  );
  new SourcePolicy(
    text,
    // @ts-expect-error Grants are known only from a compile as a principal.
    [new GrantedScope()],
  );
  new SourcePolicy(
    text,
    // @ts-expect-error Plan operators are known only from a compile.
    [new NoRemoteOperators()],
  );
  // @ts-expect-error A plan compiles as a principal, so it needs the principal's name.
  new SqlServerPlan({ session: principal.session });
  // @ts-expect-error A plan policy needs a principal.
  sqlserver.planPolicy();
}

void verifySqlPolicyContract;
