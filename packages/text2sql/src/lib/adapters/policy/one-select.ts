import type { Statements } from './facts.ts';
import { readOnly } from './read-only.ts';
import type { Rule } from './source-policy.ts';

/** The SQL is exactly one SELECT, which writes nowhere. */
export class OneSelect implements Rule<Statements> {
  readonly check = async (facts: Statements) => {
    const statements = await facts.statements();
    return statements.length === 1 && statements[0]?.kind === 'select'
      ? null
      : readOnly;
  };
}
