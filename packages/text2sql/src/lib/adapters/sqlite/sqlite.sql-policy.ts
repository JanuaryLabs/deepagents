import { ParserSqlPolicyAnalyzer } from '../parser-sql-policy.ts';

export class SqliteSqlPolicyAnalyzer extends ParserSqlPolicyAnalyzer {
  // MySQL covers SQLite syntax that node-sql-parser's SQLite grammar rejects.
  protected readonly dialects = ['sqlite', 'mysql'] as const;
  protected override readonly readOnlyPolicy = {
    blockedFunctions: ['EDIT', 'LOAD_EXTENSION', 'READFILE', 'WRITEFILE'],
  } as const;
}
