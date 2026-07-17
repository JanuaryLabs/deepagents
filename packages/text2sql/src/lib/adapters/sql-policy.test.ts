import assert from 'node:assert';
import { describe, it } from 'node:test';

import type { SqlPolicyAnalyzer } from '@deepagents/text2sql';
import { BigQuerySqlPolicyAnalyzer } from '@deepagents/text2sql/bigquery';
import { MysqlSqlPolicyAnalyzer } from '@deepagents/text2sql/mysql';
import { PostgresSqlPolicyAnalyzer } from '@deepagents/text2sql/postgres';
import { SqliteSqlPolicyAnalyzer } from '@deepagents/text2sql/sqlite';
import { SqlServerSqlPolicyAnalyzer } from '@deepagents/text2sql/sqlserver';

const cases: Array<{
  name: string;
  analyzer: SqlPolicyAnalyzer;
  sql: string;
  referencedEntity: string;
}> = [
  {
    name: 'BigQuery',
    analyzer: new BigQuerySqlPolicyAnalyzer(),
    sql: 'SELECT * EXCEPT (secret) FROM `users`',
    referencedEntity: 'users',
  },
  {
    name: 'MySQL',
    analyzer: new MysqlSqlPolicyAnalyzer(),
    sql: 'SELECT SQL_CALC_FOUND_ROWS * FROM `users` LIMIT 1, 2',
    referencedEntity: 'users',
  },
  {
    name: 'PostgreSQL',
    analyzer: new PostgresSqlPolicyAnalyzer(),
    sql: 'SELECT DISTINCT ON (id) * FROM "users"',
    referencedEntity: 'users',
  },
  {
    name: 'SQLite',
    analyzer: new SqliteSqlPolicyAnalyzer(),
    // SQLite rejects this valid identifier, so the analyzer must reach its
    // established MySQL parser fallback.
    sql: 'SELECT * FROM persist',
    referencedEntity: 'persist',
  },
  {
    name: 'SQL Server',
    analyzer: new SqlServerSqlPolicyAnalyzer(),
    sql: 'SELECT TOP 1 * FROM [users]',
    referencedEntity: 'users',
  },
];

describe('dialect SQL policy analyzers', () => {
  for (const { name, analyzer, sql, referencedEntity } of cases) {
    it(`${name} accepts in-scope dialect SQL`, async () => {
      const violation = await analyzer.analyze(sql, {
        async resolveAllowedEntities() {
          return [referencedEntity];
        },
      });

      assert.strictEqual(violation, null);
    });

    it(`${name} rejects out-of-scope dialect SQL`, async () => {
      const violation = await analyzer.analyze(sql, {
        async resolveAllowedEntities() {
          return [];
        },
      });

      assert.strictEqual(violation?.kind, 'scope');
      if (violation?.kind !== 'scope') return;
      assert.strictEqual(violation.payload.error_type, 'OUT_OF_SCOPE');
      assert.deepStrictEqual(violation.payload.referenced_entities, [
        referencedEntity,
      ]);
    });
  }
});
