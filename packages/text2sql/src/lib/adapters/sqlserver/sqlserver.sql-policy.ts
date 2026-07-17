import { ParserSqlPolicyAnalyzer } from '../parser-sql-policy.ts';

export class SqlServerSqlPolicyAnalyzer extends ParserSqlPolicyAnalyzer {
  protected readonly dialects = ['transactsql'] as const;
  protected override readonly readOnlyPolicy = {
    blockSelectInto: true,
    blockTableHints: true,
    blockedFunctions: ['OPENDATASOURCE', 'OPENQUERY', 'OPENROWSET'],
  } as const;
}
