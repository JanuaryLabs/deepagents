import { ParserSqlPolicyAnalyzer } from '../parser-sql-policy.ts';

export class BigQuerySqlPolicyAnalyzer extends ParserSqlPolicyAnalyzer {
  protected readonly dialects = ['bigquery'] as const;
  protected override readonly readOnlyPolicy = {
    blockQualifiedFunctions: true,
    blockedFunctions: ['EXTERNAL_QUERY'],
  } as const;
}
