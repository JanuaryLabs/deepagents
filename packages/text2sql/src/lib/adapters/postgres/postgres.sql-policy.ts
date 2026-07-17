import { ParserSqlPolicyAnalyzer } from '../parser-sql-policy.ts';

export class PostgresSqlPolicyAnalyzer extends ParserSqlPolicyAnalyzer {
  protected readonly dialects = ['postgresql'] as const;
  protected override readonly readOnlyPolicy = {
    blockSelectInto: true,
    blockedFunctions: [
      'LO_EXPORT',
      'LO_IMPORT',
      'LO_UNLINK',
      'NEXTVAL',
      'DBLINK_EXEC',
      'PG_ADVISORY_LOCK',
      'PG_ADVISORY_LOCK_SHARED',
      'PG_ADVISORY_UNLOCK',
      'PG_ADVISORY_UNLOCK_ALL',
      'PG_ADVISORY_UNLOCK_SHARED',
      'PG_LS_DIR',
      'PG_READ_BINARY_FILE',
      'PG_READ_FILE',
      'PG_NOTIFY',
      'PG_SLEEP',
      'PG_STAT_FILE',
      'PG_TRY_ADVISORY_LOCK',
      'PG_TRY_ADVISORY_LOCK_SHARED',
      'SET_CONFIG',
      'SETVAL',
    ],
  } as const;
}
