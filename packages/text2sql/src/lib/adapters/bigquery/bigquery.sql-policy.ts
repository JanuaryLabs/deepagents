import { DeniedCalls } from '../policy/denied-calls.ts';
import { GroundedNames, InScope } from '../policy/in-scope.ts';
import { OneSelect } from '../policy/one-select.ts';
import { SourcePolicy } from '../policy/source-policy.ts';
import { SqlText } from '../policy/sql-text.ts';

/** The default policy of the BigQuery adapter. */
export function policy() {
  return new SourcePolicy(new SqlText({ dialects: ['bigquery'] }), [
    new OneSelect(),
    // A qualified call names a persistent routine, which can run anything.
    new DeniedCalls({ names: ['EXTERNAL_QUERY'], qualified: true }),
    new InScope(new GroundedNames()),
  ]);
}
