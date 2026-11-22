import type { Calls } from './facts.ts';
import { readOnly } from './read-only.ts';
import type { Rule } from './source-policy.ts';

export interface CallDenials {
  /** Function names, matched without case against a call's last name part. */
  readonly names?: readonly string[];
  /** Name prefixes, matched without case against a call's last name part. */
  readonly prefixes?: readonly string[];
  /** Deny every call whose name has more than one part, such as `dataset.fn`. */
  readonly qualified?: true;
}

/** The SQL calls none of the denied functions. */
export class DeniedCalls implements Rule<Calls> {
  readonly #names: ReadonlySet<string>;
  readonly #prefixes: readonly string[];
  readonly #qualified: boolean;

  constructor(denials: CallDenials) {
    this.#names = new Set(denials.names?.map((name) => name.toLowerCase()));
    this.#prefixes =
      denials.prefixes?.map((prefix) => prefix.toLowerCase()) ?? [];
    this.#qualified = denials.qualified === true;
  }

  readonly check = async (facts: Calls) => {
    const calls = await facts.calls();
    return calls.some((parts) => this.#denies(parts)) ? readOnly : null;
  };

  #denies(parts: readonly string[]): boolean {
    if (this.#qualified && parts.length > 1) return true;
    const name = parts.at(-1)?.toLowerCase();
    if (name === undefined) return false;
    return (
      this.#names.has(name) ||
      this.#prefixes.some((prefix) => name.startsWith(prefix))
    );
  }
}
