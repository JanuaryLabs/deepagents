import { describe, it } from '@zukhruf/parameterized-test';
import assert from 'node:assert';

import * as text2sql from '@deepagents/text2sql';
import type { SqlPolicyAnalyzer } from '@deepagents/text2sql';
import * as bigquery from '@deepagents/text2sql/bigquery';
import * as mysql from '@deepagents/text2sql/mysql';
import * as sqlPolicy from '@deepagents/text2sql/policy';
import * as postgres from '@deepagents/text2sql/postgres';
import * as sqlite from '@deepagents/text2sql/sqlite';
import * as sqlserver from '@deepagents/text2sql/sqlserver';

const cases: Array<{
  name: string;
  analyzer: SqlPolicyAnalyzer;
  sql: string;
  referencedEntity: string;
}> = [
  {
    name: 'BigQuery',
    analyzer: bigquery.policy(),
    sql: 'SELECT * EXCEPT (secret) FROM `users`',
    referencedEntity: 'users',
  },
  {
    name: 'MySQL',
    analyzer: mysql.policy(),
    sql: 'SELECT SQL_CALC_FOUND_ROWS * FROM `users` LIMIT 1, 2',
    referencedEntity: 'users',
  },
  {
    name: 'PostgreSQL',
    analyzer: postgres.policy(),
    sql: 'SELECT DISTINCT ON (id) * FROM "users"',
    referencedEntity: 'users',
  },
  {
    name: 'SQLite',
    analyzer: sqlite.policy(),
    // SQLite rejects this valid identifier, so the analyzer must reach its
    // established MySQL parser fallback.
    sql: 'SELECT * FROM persist',
    referencedEntity: 'persist',
  },
  {
    name: 'SQL Server',
    analyzer: sqlserver.textPolicy(),
    sql: 'SELECT TOP 1 * FROM [users]',
    referencedEntity: 'users',
  },
];

describe('dialect SQL policies', () => {
  void describe.each(cases, ({ name, analyzer, sql, referencedEntity }) =>
    describe(name, () => {
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
    }),
  );

  void it.each(
    [
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
      'SELECT SOURCE_POS_WAIT("binlog.000001", 1, 60)',
      'SELECT WAIT_FOR_EXECUTED_GTID_SET("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee:1", 60)',
    ],
    (sql) =>
      it(`MySQL rejects SELECT operations that can mutate state, lock, read files, or exhaust the connection: ${sql}`, async () => {
        const analyzer = mysql.policy();

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
      }),
  );

  void it.each(
    [
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
      "SELECT dblink_connect('remote', 'dbname=remote')",
      "SELECT dblink_disconnect('remote')",
      'SELECT lo_get(1)',
      'SELECT pg_advisory_xact_lock(1)',
      'SELECT pg_cancel_backend(123)',
      'SELECT * FROM pg_ls_logdir()',
      'SELECT pg_reload_conf()',
      'SELECT pg_rotate_logfile()',
      'SELECT pg_terminate_backend(123)',
    ],
    (sql) =>
      it(`PostgreSQL rejects SELECT operations that create relations, mutate state, lock, or access server files: ${sql}`, async () => {
        const analyzer = postgres.policy();

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
      }),
  );

  void it.each(
    [
      'SELECT * INTO copied_users FROM users',
      'SELECT * FROM users WITH (UPDLOCK)',
      'SELECT * FROM OPENQUERY(linked_server, "SELECT * FROM secrets")',
      // Same structural hint and table-valued function operations in the AST.
      'SELECT * FROM users WITH (XLOCK)',
      'SELECT * FROM OPENROWSET("SQLNCLI", "Server=x", "SELECT * FROM secrets")',
      'SELECT * FROM sys.fn_get_audit_file("C:\\\\audit\\\\*.sqlaudit", DEFAULT, DEFAULT)',
    ],
    (sql) =>
      it(`SQL Server rejects SELECT operations that create relations, acquire write locks, or query external data sources: ${sql}`, async () => {
        const analyzer = sqlserver.textPolicy();

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
      }),
  );

  it('SQL Server rejects linked-server relations that share an allowed local suffix', async () => {
    const sql = 'SELECT * FROM linked_server.database.dbo.users';
    const violation = await sqlserver.textPolicy().analyze(sql, {
      async resolveAllowedEntities() {
        return ['database.users'];
      },
    });

    assert.deepStrictEqual(violation, {
      kind: 'read-only',
      message: 'only SELECT or WITH queries allowed',
    });
  });

  void it.each(
    [
      'SELECT load_extension("/tmp/x")',
      'SELECT readfile("/etc/passwd")',
      // Same structural host-file function operation represented by the AST.
      'SELECT writefile("/tmp/x", "secret")',
    ],
    (sql) =>
      it(`SQLite rejects SELECT functions that load executable extensions or access host files: ${sql}`, async () => {
        const analyzer = sqlite.policy();

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
      }),
  );

  void it.each(
    [
      'SELECT * FROM EXTERNAL_QUERY("conn", "SELECT * FROM secrets")',
      'SELECT project.dataset.remote_function(secret) FROM users',
      // Persistent routines have the same qualified function structure.
      'SELECT dataset.user_defined_function(secret) FROM users',
      'SELECT `project.dataset.remote_function`(secret) FROM users',
    ],
    (sql) =>
      it(`BigQuery rejects SELECT operations that escape through external queries or persistent routines: ${sql}`, async () => {
        const analyzer = bigquery.policy();

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
      }),
  );

  it('accepts ordinary read-only SELECT and WITH queries in every dialect', async () => {
    const analyzers: SqlPolicyAnalyzer[] = [
      bigquery.policy(),
      mysql.policy(),
      postgres.policy(),
      sqlite.policy(),
      sqlserver.textPolicy(),
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
      bigquery.policy(),
      mysql.policy(),
      postgres.policy(),
      sqlite.policy(),
      sqlserver.textPolicy(),
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
    const violation = await sqlserver.textPolicy().analyze(sql, {
      async resolveAllowedEntities() {
        return [];
      },
    });

    assert.strictEqual(violation?.kind, 'scope');
    if (violation?.kind !== 'scope') return;
    assert.strictEqual(violation.payload.error_type, 'SQL_SCOPE_PARSE_ERROR');
    assert.strictEqual(violation.payload.sql_attempted, sql);
  });

  it('rejects SELECT INTO in every dialect', async () => {
    const sql = 'SELECT * INTO copied_users FROM users';
    const context = {
      async resolveAllowedEntities() {
        return ['users', 'copied_users'];
      },
    };

    for (const policy of [
      mysql.policy(),
      postgres.policy(),
      sqlite.policy(),
      sqlserver.textPolicy(),
    ]) {
      assert.deepStrictEqual(await policy.analyze(sql, context), {
        kind: 'read-only',
        message: 'only SELECT or WITH queries allowed',
      });
    }
    // BigQuery's grammar has no SELECT INTO, so the SQL is unreadable.
    const violation = await bigquery.policy().analyze(sql, context);
    assert.strictEqual(violation?.kind, 'scope');
    if (violation?.kind !== 'scope') return;
    assert.strictEqual(violation.payload.error_type, 'SQL_SCOPE_PARSE_ERROR');
  });

  it('never resolves the grounded scope for refused SQL or SQL that reads no relation', async () => {
    let resolved = 0;
    const context = {
      async resolveAllowedEntities() {
        resolved++;
        return ['users'];
      },
    };
    const policy = sqlite.policy();

    assert.deepStrictEqual(await policy.analyze('DELETE FROM users', context), {
      kind: 'read-only',
      message: 'only SELECT or WITH queries allowed',
    });
    assert.deepStrictEqual(
      await policy.analyze('SELECT load_extension("x") FROM users', context),
      { kind: 'read-only', message: 'only SELECT or WITH queries allowed' },
    );
    assert.strictEqual(await policy.analyze('SELECT 1', context), null);
    assert.strictEqual(resolved, 0);

    assert.strictEqual(
      await policy.analyze('SELECT * FROM users', context),
      null,
    );
    assert.strictEqual(resolved, 1);
  });
});

describe('SQL policy building blocks', () => {
  const context = {
    async resolveAllowedEntities() {
      return ['users'];
    },
  };

  it('refuses SQL that no grammar parses when the only rule reads statements', async () => {
    const policy = new sqlPolicy.SourcePolicy(
      new sqlPolicy.SqlText({ dialects: ['sqlite'] }),
      [new sqlPolicy.OneSelect()],
    );

    const unreadable = await policy.analyze('SELECT * FROM', context);
    assert.strictEqual(unreadable?.kind, 'scope');
    if (unreadable?.kind !== 'scope') return;
    assert.strictEqual(unreadable.payload.error_type, 'SQL_SCOPE_PARSE_ERROR');
    assert.strictEqual(unreadable.payload.parser_dialect, 'sqlite');

    // A cascade reports its last grammar, whose error the payload carries.
    const cascade = await sqlite.policy().analyze('SELECT * FROM', context);
    assert.strictEqual(cascade?.kind, 'scope');
    if (cascade?.kind !== 'scope') return;
    assert.strictEqual(cascade.payload.parser_dialect, 'mysql');
  });

  void it.each(
    [
      'WITH t AS (SELECT 1) DELETE FROM users WHERE',
      'SELECT 1; DROP TABLE users WHERE',
    ],
    (sql) =>
      it(`refuses ${JSON.stringify(sql)}, which no grammar parses, as a scope violation when the only rule reads statements`, async () => {
        const policy = new sqlPolicy.SourcePolicy(
          new sqlPolicy.SqlText({ dialects: ['sqlite'] }),
          [new sqlPolicy.OneSelect()],
        );

        const violation = await policy.analyze(sql, context);
        assert.strictEqual(violation?.kind, 'scope', sql);
      }),
  );

  // An unterminated comment parses in no grammar and holds no statement.
  void it.each(['DROP TABLE users (', '/* no statement'], (sql) =>
    it(`refuses ${JSON.stringify(sql)}, which holds no statement, as read-only when the only rule reads statements`, async () => {
      const policy = new sqlPolicy.SourcePolicy(
        new sqlPolicy.SqlText({ dialects: ['sqlite'] }),
        [new sqlPolicy.OneSelect()],
      );

      assert.deepStrictEqual(
        await policy.analyze(sql, context),
        { kind: 'read-only', message: 'only SELECT or WITH queries allowed' },
        sql,
      );
    }),
  );

  it('reports UnreadableSql of a source as a parse error naming its dialect and rejects with any other error', async () => {
    const outage = new Error('the database is unreachable');
    const source = (failure: Error) => ({
      dialect: 'example',
      read: () => ({
        relations: async (): Promise<readonly string[]> => {
          throw failure;
        },
      }),
    });
    const inScope = new sqlPolicy.InScope(new sqlPolicy.GroundedNames());

    const unreadable = await new sqlPolicy.SourcePolicy(
      source(new sqlPolicy.UnreadableSql('unexpected token')),
      [inScope],
    ).analyze('SELECT', context);
    assert.deepStrictEqual(unreadable, {
      kind: 'scope',
      payload: {
        error:
          'SQL scope analysis failed before validation/execution: unexpected token',
        error_type: 'SQL_SCOPE_PARSE_ERROR',
        suggestion:
          'Rewrite the query into simpler SQL that can be analyzed safely, or extend parser coverage for this dialect feature.',
        sql_attempted: 'SELECT',
        parser_dialect: 'example',
        parser_error: 'unexpected token',
      },
    });

    await assert.rejects(
      () =>
        new sqlPolicy.SourcePolicy(source(outage), [inScope]).analyze(
          'SELECT',
          context,
        ),
      (error: unknown) => error === outage,
    );
  });
});

describe('PostgreSQL typed literals', () => {
  const analyzer = postgres.policy();
  const analyze = (sql: string, allowedEntities: string[] = []) =>
    analyzer.analyze(sql, {
      async resolveAllowedEntities() {
        return allowedEntities;
      },
    });

  it('accepts a TIMESTAMPTZ literal without entity references', async () => {
    assert.strictEqual(await analyze("SELECT TIMESTAMPTZ 'epoch'"), null);
  });

  it('keeps TIMESTAMPTZ queries grounded to allowed relations', async () => {
    assert.strictEqual(
      await analyze("SELECT TIMESTAMPTZ 'epoch' FROM allowed_table", [
        'allowed_table',
      ]),
      null,
    );
  });

  it('rejects out-of-scope relations after recovering a TIMESTAMPTZ literal', async () => {
    const sql = "SELECT TIMESTAMPTZ 'epoch' FROM forbidden_table";
    const violation = await analyze(sql, ['allowed_table']);

    assert.strictEqual(violation?.kind, 'scope');
    if (violation?.kind !== 'scope') return;
    assert.strictEqual(violation.payload.error_type, 'OUT_OF_SCOPE');
    assert.deepStrictEqual(violation.payload.referenced_entities, [
      'forbidden_table',
    ]);
    assert.strictEqual(violation.payload.sql_attempted, sql);
  });

  void it.each(
    ["SELECT TIMESTAMPTZ 'epoch' FROM", "SELECT custom_type 'value'"],
    (sql) =>
      it(`keeps the invalid or unsupported-type SQL ${JSON.stringify(sql)} fail closed`, async () => {
        const violation = await analyze(sql, ['allowed_table']);
        assert.strictEqual(violation?.kind, 'scope', sql);
        if (violation?.kind !== 'scope') return;
        assert.strictEqual(
          violation.payload.error_type,
          'SQL_SCOPE_PARSE_ERROR',
        );
        assert.strictEqual(violation.payload.sql_attempted, sql);
      }),
  );

  it('does not rewrite typed-literal text inside lexical boundaries', async () => {
    const sql = String.raw`SELECT
      'TIMESTAMPTZ ''epoch''' AS string_text,
      E'TIMESTAMPTZ \'epoch\'',
      $tag$TIMESTAMPTZ 'epoch'$tag$ AS dollar_text,
      "TIMESTAMPTZ 'epoch'" AS quoted_identifier,
      TiMeStAmPtZ 'epoch'
      -- TIMESTAMPTZ 'epoch'
      /* TIMESTAMPTZ 'epoch' */
      FROM allowed_table`;
    assert.strictEqual(await analyze(sql, ['allowed_table']), null);
  });

  void it.each(
    [
      "SELECT TIMETZ '04:05:06+01'",
      "SELECT UUID 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'",
      `SELECT JSONB '{"ok":true}'`,
      "SELECT pg_catalog.timestamptz 'epoch'",
      'SELECT UUID $$a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11$$',
      "SELECT TIMESTAMPTZ 'epoch', UUID 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'",
      "SELECT TIME(3) WITH TIME ZONE '04:05:06.123+01'",
      "SELECT BIT VARYING '1001'",
      "SELECT DOUBLE PRECISION '1.23'",
    ],
    (sql) =>
      it(`accepts PostgreSQL general typed constants that the parser rejects: ${sql}`, async () => {
        assert.strictEqual(await analyze(sql), null, sql);
      }),
  );
});

describe('SQL policy public surface', () => {
  it('keeps the building blocks and dialect policies off the root export', () => {
    const buildingBlocks = [
      'DeniedCalls',
      'FirstViolation',
      'Forbid',
      'GroundedNames',
      'InScope',
      'OneSelect',
      'SourcePolicy',
      'SqlText',
      'UnreadableSql',
    ];

    for (const exportName of [...buildingBlocks, 'policy', 'textPolicy']) {
      assert.strictEqual(
        Object.hasOwn(text2sql, exportName),
        false,
        `${exportName} must not be exported from @deepagents/text2sql`,
      );
    }
    for (const exportName of buildingBlocks) {
      assert.strictEqual(
        typeof Reflect.get(sqlPolicy, exportName),
        'function',
        `${exportName} must be exported from @deepagents/text2sql/policy`,
      );
    }
  });
});
