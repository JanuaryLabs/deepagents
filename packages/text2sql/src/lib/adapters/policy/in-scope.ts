import { buildOutOfScopePayload } from '../../sql-scope-error.ts';
import type { SqlPolicyViolation } from '../sql-policy.ts';
import type { Relations } from './facts.ts';
import type { PolicyCheck, Rule } from './source-policy.ts';

/** Decides which relations, as the SQL writes them, the allowed entities cover. */
export interface NameMatcher {
  allowing(allowed: readonly string[]): Promise<(relation: string) => boolean>;
}

/**
 * The SQL reads only relations of its grounded scope. SQL that reads no
 * relation never resolves the scope.
 */
export class InScope implements Rule<Relations> {
  readonly #names: NameMatcher;

  constructor(names: NameMatcher) {
    this.#names = names;
  }

  readonly check = async (
    facts: Relations,
    check: PolicyCheck,
  ): Promise<SqlPolicyViolation | null> => {
    const relations = await facts.relations();
    if (relations.length === 0) return null;

    const allowed = await check.resolveAllowedEntities();
    const isAllowed = await this.#names.allowing(allowed);
    const outOfScope = relations.filter((relation) => !isAllowed(relation));
    return outOfScope.length === 0
      ? null
      : {
          kind: 'scope',
          payload: buildOutOfScopePayload(check.sql, {
            referenced: outOfScope,
            allowed: [...allowed],
          }),
        };
  };
}

/**
 * Matches names without case. A one-part name matches an allowed entity by
 * its full name or by its last part; a longer name matches by its full name,
 * and a name of three or more parts also by its last two parts.
 */
export class GroundedNames implements NameMatcher {
  async allowing(allowed: readonly string[]) {
    const qualified = new Set(allowed.map((entity) => entity.toLowerCase()));
    const unqualified = new Set(
      allowed.map((entity) =>
        entity.slice(entity.lastIndexOf('.') + 1).toLowerCase(),
      ),
    );

    return (relation: string) => {
      const name = relation.toLowerCase();
      if (qualified.has(name)) return true;
      if (!name.includes('.')) return unqualified.has(name);
      const parts = name.split('.');
      return parts.length >= 3 && qualified.has(parts.slice(-2).join('.'));
    };
  }
}
