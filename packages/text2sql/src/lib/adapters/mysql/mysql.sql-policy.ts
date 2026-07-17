import { ParserSqlPolicyAnalyzer } from '../parser-sql-policy.ts';

export class MysqlSqlPolicyAnalyzer extends ParserSqlPolicyAnalyzer {
  protected readonly dialects = ['mysql'] as const;
  protected override readonly readOnlyPolicy = {
    blockAssignments: true,
    blockLockingReads: true,
    blockSelectInto: true,
    blockedFunctions: [
      'BENCHMARK',
      'GET_LOCK',
      'IS_FREE_LOCK',
      'IS_USED_LOCK',
      'LAST_INSERT_ID',
      'LOAD_FILE',
      'MASTER_POS_WAIT',
      'RELEASE_LOCK',
      'SLEEP',
    ],
  } as const;
}
