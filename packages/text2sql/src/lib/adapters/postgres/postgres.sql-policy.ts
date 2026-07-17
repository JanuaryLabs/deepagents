import { ParserSqlPolicyAnalyzer } from '../parser-sql-policy.ts';

export class PostgresSqlPolicyAnalyzer extends ParserSqlPolicyAnalyzer {
  protected readonly dialects = ['postgresql'] as const;
  protected override readonly readOnlyPolicy = {
    blockSelectInto: true,
    blockedFunctionPrefixes: [
      'DBLINK_',
      'LO_',
      'PG_ADVISORY_',
      'PG_LS_',
      'PG_TRY_ADVISORY_',
    ],
    blockedFunctions: [
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
  } as const;
}
