import {
  DeniedCalls,
  type FactSource,
  FirstViolation,
  Forbid,
  GroundedNames,
  InScope,
  OneSelect,
  type Relations,
  type Rule,
  SourcePolicy,
  SqlText,
  type TextFacts,
} from '@deepagents/text2sql/policy';
import * as sqlite from '@deepagents/text2sql/sqlite';
import { SqlServer } from '@deepagents/text2sql/sqlserver';
import * as sqlserver from '@deepagents/text2sql/sqlserver';

interface Grants {
  denials(): Promise<readonly string[]>;
}

class TextAndGrants implements Rule<TextFacts & Grants> {
  readonly check = async (facts: TextFacts & Grants) => {
    await facts.denials();
    return null;
  };
}

function verifySqlPolicyContract(relationsOnly: FactSource<Relations>) {
  const text = new SqlText({ dialects: ['transactsql'] });
  new SourcePolicy(text, [
    new OneSelect(),
    new DeniedCalls({ names: ['OPENQUERY'], prefixes: ['XP_'] }),
    new Forbid(['table-hint']),
    new InScope(new GroundedNames()),
  ]);
  new SourcePolicy(
    text,
    // @ts-expect-error SQL text gives no grants, so a rule that reads them does not fit it.
    [new TextAndGrants()],
  );

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
}

void verifySqlPolicyContract;
