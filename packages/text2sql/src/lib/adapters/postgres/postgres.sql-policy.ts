import { DeniedCalls } from '../policy/denied-calls.ts';
import { GroundedNames, InScope } from '../policy/in-scope.ts';
import { OneSelect } from '../policy/one-select.ts';
import { SourcePolicy } from '../policy/source-policy.ts';
import { SqlText } from '../policy/sql-text.ts';
import { recoverPostgresTypedLiteralParserGap } from './postgres-parser-workaround.ts';

/** The default policy of the Postgres adapter. */
export function policy() {
  return new SourcePolicy(
    new SqlText({
      dialects: ['postgresql'],
      recover: recoverPostgresTypedLiteralParserGap,
    }),
    [
      new OneSelect(),
      new DeniedCalls({
        names: [
          'NEXTVAL',
          'PG_CANCEL_BACKEND',
          'PG_READ_BINARY_FILE',
          'PG_READ_FILE',
          'PG_RELOAD_CONF',
          'PG_NOTIFY',
          'PG_ROTATE_LOGFILE',
          'PG_SLEEP',
          'PG_STAT_FILE',
          'PG_TERMINATE_BACKEND',
          'SET_CONFIG',
          'SETVAL',
        ],
        prefixes: [
          'DBLINK_',
          'LO_',
          'PG_ADVISORY_',
          'PG_LS_',
          'PG_TRY_ADVISORY_',
        ],
      }),
      new InScope(new GroundedNames()),
    ],
  );
}
