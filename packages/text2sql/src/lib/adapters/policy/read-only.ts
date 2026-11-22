import type { SqlPolicyViolation } from '../sql-policy.ts';

/** The violation of SQL that could write, lock or leave the database. */
export const readOnly: SqlPolicyViolation = Object.freeze({
  kind: 'read-only',
  message: 'only SELECT or WITH queries allowed',
});
