import { DeniedCalls } from '../policy/denied-calls.ts';
import { Forbid } from '../policy/forbid.ts';
import { GroundedNames, InScope } from '../policy/in-scope.ts';
import { OneSelect } from '../policy/one-select.ts';
import { SourcePolicy } from '../policy/source-policy.ts';
import { SqlText } from '../policy/sql-text.ts';

/** The default policy of the Mysql adapter. */
export function policy() {
  return new SourcePolicy(new SqlText({ dialects: ['mysql'] }), [
    new OneSelect(),
    new DeniedCalls({
      names: [
        'BENCHMARK',
        'GET_LOCK',
        'IS_FREE_LOCK',
        'IS_USED_LOCK',
        'LAST_INSERT_ID',
        'LOAD_FILE',
        'MASTER_POS_WAIT',
        'RELEASE_LOCK',
        'SLEEP',
        'SOURCE_POS_WAIT',
        'WAIT_FOR_EXECUTED_GTID_SET',
      ],
    }),
    new Forbid(['locking-read', 'assignment']),
    new InScope(new GroundedNames()),
  ]);
}
