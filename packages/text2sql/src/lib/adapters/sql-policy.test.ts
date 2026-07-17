import assert from 'node:assert';
import { describe, it } from 'node:test';

import * as text2sql from '@deepagents/text2sql';
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

    it(`${name} rejects an out-of-scope relation in an unused CTE`, async () => {
      const violation = await analyzer.analyze(
        'WITH hidden AS (SELECT * FROM secrets) SELECT 1',
        {
          async resolveAllowedEntities() {
            return [];
          },
        },
      );

      assert.strictEqual(violation?.kind, 'scope');
      if (violation?.kind !== 'scope') return;
      assert.strictEqual(violation.payload.error_type, 'OUT_OF_SCOPE');
      assert.deepStrictEqual(violation.payload.referenced_entities, [
        'secrets',
      ]);
    });
  }

  it('MySQL rejects SELECT operations that can mutate state, lock, read files, or exhaust the connection', async () => {
    const analyzer = new MysqlSqlPolicyAnalyzer();
    const unsafeQueries = [
      'SELECT 1 INTO OUTFILE "/tmp/x"',
      'SELECT 1 INTO DUMPFILE "/tmp/x"',
      'SELECT * FROM users FOR UPDATE',
      'SELECT GET_LOCK("x", 1)',
      'SELECT LOAD_FILE("/etc/passwd")',
      'SELECT SLEEP(60)',
      'SELECT @x := 1',
      // Same structural operations represented by the AST.
      'SELECT * FROM users LOCK IN SHARE MODE',
      'SELECT RELEASE_LOCK("x")',
      'SELECT BENCHMARK(1000, 1 + 1)',
      'SELECT LAST_INSERT_ID(7)',
      'SELECT MASTER_POS_WAIT("log", 1)',
    ];

    for (const sql of unsafeQueries) {
      assert.deepStrictEqual(
        await analyzer.analyze(sql, {
          async resolveAllowedEntities() {
            return ['users'];
          },
        }),
        {
          kind: 'read-only',
          message: 'only SELECT or WITH queries allowed',
        },
        sql,
      );
    }
  });

  it('PostgreSQL rejects SELECT operations that create relations, mutate state, lock, or access server files', async () => {
    const analyzer = new PostgresSqlPolicyAnalyzer();
    const unsafeQueries = [
      'SELECT * INTO copied_users FROM users',
      'SELECT pg_advisory_lock(1)',
      'SELECT setval("s", 2)',
      'SELECT lo_export(1, "/tmp/x")',
      'SELECT pg_read_file("/etc/passwd")',
      'SELECT set_config("search_path", "public", false)',
      // Same structural function operations represented by the AST.
      'SELECT pg_try_advisory_lock(1)',
      'SELECT pg_read_binary_file("/etc/passwd")',
      'SELECT lo_import("/tmp/x")',
      'SELECT nextval("s")',
      'SELECT pg_sleep(60)',
      'SELECT pg_notify("x", "y")',
      'SELECT lo_unlink(1)',
      'SELECT dblink_exec("conn", "DELETE FROM x")',
    ];

    for (const sql of unsafeQueries) {
      assert.deepStrictEqual(
        await analyzer.analyze(sql, {
          async resolveAllowedEntities() {
            return ['users'];
          },
        }),
        {
          kind: 'read-only',
          message: 'only SELECT or WITH queries allowed',
        },
        sql,
      );
    }
  });

  it('SQL Server rejects SELECT operations that create relations, acquire write locks, or query external data sources', async () => {
    const analyzer = new SqlServerSqlPolicyAnalyzer();
    const unsafeQueries = [
      'SELECT * INTO copied_users FROM users',
      'SELECT * FROM users WITH (UPDLOCK)',
      'SELECT * FROM OPENQUERY(linked_server, "SELECT * FROM secrets")',
      // Same structural hint and table-valued function operations in the AST.
      'SELECT * FROM users WITH (XLOCK)',
      'SELECT * FROM OPENROWSET("SQLNCLI", "Server=x", "SELECT * FROM secrets")',
    ];

    for (const sql of unsafeQueries) {
      assert.deepStrictEqual(
        await analyzer.analyze(sql, {
          async resolveAllowedEntities() {
            return ['users'];
          },
        }),
        {
          kind: 'read-only',
          message: 'only SELECT or WITH queries allowed',
        },
        sql,
      );
    }
  });

  it('SQLite rejects SELECT functions that load executable extensions or access host files', async () => {
    const analyzer = new SqliteSqlPolicyAnalyzer();
    const unsafeQueries = [
      'SELECT load_extension("/tmp/x")',
      'SELECT readfile("/etc/passwd")',
      // Same structural host-file function operation represented by the AST.
      'SELECT writefile("/tmp/x", "secret")',
    ];

    for (const sql of unsafeQueries) {
      assert.deepStrictEqual(
        await analyzer.analyze(sql, {
          async resolveAllowedEntities() {
            return [];
          },
        }),
        {
          kind: 'read-only',
          message: 'only SELECT or WITH queries allowed',
        },
        sql,
      );
    }
  });

  it('BigQuery rejects SELECT operations that escape through external queries or persistent routines', async () => {
    const analyzer = new BigQuerySqlPolicyAnalyzer();
    const unsafeQueries = [
      'SELECT * FROM EXTERNAL_QUERY("conn", "SELECT * FROM secrets")',
      'SELECT project.dataset.remote_function(secret) FROM users',
      // Persistent routines have the same qualified function structure.
      'SELECT dataset.user_defined_function(secret) FROM users',
    ];

    for (const sql of unsafeQueries) {
      assert.deepStrictEqual(
        await analyzer.analyze(sql, {
          async resolveAllowedEntities() {
            return ['users'];
          },
        }),
        {
          kind: 'read-only',
          message: 'only SELECT or WITH queries allowed',
        },
        sql,
      );
    }
  });

  it('accepts ordinary read-only SELECT and WITH queries in every dialect', async () => {
    const analyzers: SqlPolicyAnalyzer[] = [
      new BigQuerySqlPolicyAnalyzer(),
      new MysqlSqlPolicyAnalyzer(),
      new PostgresSqlPolicyAnalyzer(),
      new SqliteSqlPolicyAnalyzer(),
      new SqlServerSqlPolicyAnalyzer(),
    ];
    const readOnlyQueries = [
      'SELECT id FROM users WHERE id > 0',
      'WITH chosen AS (SELECT id FROM users) SELECT id FROM chosen',
    ];

    for (const analyzer of analyzers) {
      for (const sql of readOnlyQueries) {
        assert.strictEqual(
          await analyzer.analyze(sql, {
            async resolveAllowedEntities() {
              return ['users'];
            },
          }),
          null,
          sql,
        );
      }
    }
  });

  it('keeps parser-rejected SELECT syntax fail closed in every dialect', async () => {
    const analyzers: SqlPolicyAnalyzer[] = [
      new BigQuerySqlPolicyAnalyzer(),
      new MysqlSqlPolicyAnalyzer(),
      new PostgresSqlPolicyAnalyzer(),
      new SqliteSqlPolicyAnalyzer(),
      new SqlServerSqlPolicyAnalyzer(),
    ];

    for (const analyzer of analyzers) {
      const violation = await analyzer.analyze('SELECT * FROM', {
        async resolveAllowedEntities() {
          return ['users'];
        },
      });

      assert.strictEqual(violation?.kind, 'scope');
      if (violation?.kind !== 'scope') continue;
      assert.strictEqual(violation.payload.error_type, 'SQL_SCOPE_PARSE_ERROR');
      assert.strictEqual(violation.payload.sql_attempted, 'SELECT * FROM');
    }
  });

  it('keeps SQL Server sequence advancement fail closed when parser coverage is unavailable', async () => {
    const sql = 'SELECT NEXT VALUE FOR seq';
    const violation = await new SqlServerSqlPolicyAnalyzer().analyze(sql, {
      async resolveAllowedEntities() {
        return [];
      },
    });

    assert.strictEqual(violation?.kind, 'scope');
    if (violation?.kind !== 'scope') return;
    assert.strictEqual(violation.payload.error_type, 'SQL_SCOPE_PARSE_ERROR');
    assert.strictEqual(violation.payload.sql_attempted, sql);
  });
});

describe('SQL policy public surface', () => {
  it('keeps implementation and concrete analyzers off the root export', () => {
    const internalOrDialectExports = [
      'BigQuerySqlPolicyAnalyzer',
      'MysqlSqlPolicyAnalyzer',
      'NodeSqlPolicyAnalyzer',
      'ParserSqlPolicyAnalyzer',
      'PostgresSqlPolicyAnalyzer',
      'SqliteSqlPolicyAnalyzer',
      'SqlServerSqlPolicyAnalyzer',
      'nodeSqlPolicyForFormatter',
    ];

    for (const exportName of internalOrDialectExports) {
      assert.strictEqual(
        Object.hasOwn(text2sql, exportName),
        false,
        `${exportName} must not be exported from @deepagents/text2sql`,
      );
    }
  });
});
