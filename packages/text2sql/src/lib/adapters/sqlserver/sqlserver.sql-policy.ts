import { ParserSqlPolicyAnalyzer } from '../parser-sql-policy.ts';

export class SqlServerSqlPolicyAnalyzer extends ParserSqlPolicyAnalyzer {
  protected readonly dialects = ['transactsql'] as const;
  protected override readonly readOnlyPolicy = {
    blockSelectInto: true,
    blockServerQualifiedRelations: true,
    blockTableHints: true,
    blockedFunctions: [
      'FN_GET_AUDIT_FILE',
      'OPENDATASOURCE',
      'OPENQUERY',
      'OPENROWSET',
    ],
  } as const;
}
