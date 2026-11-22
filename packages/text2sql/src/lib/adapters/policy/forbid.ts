import { readOnly } from './read-only.ts';
import type { Rule } from './source-policy.ts';
import type { Construct, Constructs } from './sql-text.ts';

/** The SQL holds none of the forbidden constructs. */
export class Forbid implements Rule<Constructs> {
  readonly #forbidden: readonly Construct[];

  constructor(forbidden: readonly [Construct, ...Construct[]]) {
    this.#forbidden = forbidden;
  }

  readonly check = async (facts: Constructs) => {
    const found = await facts.constructs();
    return this.#forbidden.some((construct) => found.has(construct))
      ? readOnly
      : null;
  };
}
