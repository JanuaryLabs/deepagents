import { DeniedCalls } from '../policy/denied-calls.ts';
import { Forbid } from '../policy/forbid.ts';
import { GroundedNames, InScope } from '../policy/in-scope.ts';
import { OneSelect } from '../policy/one-select.ts';
import { SourcePolicy } from '../policy/source-policy.ts';
import { SqlText } from '../policy/sql-text.ts';

/**
 * The default policy of the SqlServer adapter. It reads the SQL text only,
 * so it needs nothing in the database.
 */
export function textPolicy() {
  return new SourcePolicy(new SqlText({ dialects: ['transactsql'] }), [
    new OneSelect(),
    new DeniedCalls({
      names: ['FN_GET_AUDIT_FILE', 'OPENDATASOURCE', 'OPENQUERY', 'OPENROWSET'],
    }),
    new Forbid(['table-hint', 'server-relation']),
    new InScope(new GroundedNames()),
  ]);
}
