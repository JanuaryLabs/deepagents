/** The plan policy of SQL Server on a real server, as a restricted principal. */
import { SqlServer as TestSqlServer } from '@zukhruf/testing/sqlserver';
import assert from 'node:assert';
import { describe, it } from 'node:test';

import type {
  SQLScopeErrorPayload,
  SqlPolicyAnalyzer,
} from '@deepagents/text2sql';
import {
  FirstViolation,
  Forbid,
  OneSelect,
  SourcePolicy,
  SqlText,
} from '@deepagents/text2sql/policy';
import {
  GrantedScope,
  SqlServer,
  SqlServerPlan,
  type SqlServerPrincipal,
  planPolicy,
  textPolicy,
} from '@deepagents/text2sql/sqlserver';

const testSqlServer = new TestSqlServer({ environment: process.env });

const readOnly = { error: 'only SELECT or WITH queries allowed' };

// `analyst` has the default schema marts, as datahub's scope users do. It may
// read marts.users, dbo.orders and the view dbo.active_users, which reads the
// ungranted dbo.users through the ownership chain of dbo.
const setup = [
  'CREATE SCHEMA audit',
  'CREATE SCHEMA marts',
  'CREATE TABLE dbo.users (id INT NOT NULL PRIMARY KEY, name NVARCHAR(50) NOT NULL)',
  'CREATE TABLE marts.users (id INT NOT NULL PRIMARY KEY, name NVARCHAR(50) NOT NULL)',
  'CREATE TABLE dbo.orders (id INT NOT NULL PRIMARY KEY, user_id INT NOT NULL, total DECIMAL(10, 2) NOT NULL)',
  'CREATE TABLE audit.secrets (id INT NOT NULL PRIMARY KEY, user_id INT NULL)',
  'CREATE VIEW dbo.active_users AS SELECT id, name FROM dbo.users',
  'CREATE VIEW dbo.secret_view AS SELECT id FROM audit.secrets',
  'CREATE FUNCTION dbo.secret_rows() RETURNS TABLE AS RETURN (SELECT id FROM audit.secrets)',
  'CREATE SEQUENCE dbo.ids AS INT START WITH 1',
  "INSERT INTO dbo.users VALUES (1, N'dbo Ada')",
  "INSERT INTO marts.users VALUES (1, N'Ada'), (2, N'Bob')",
  'INSERT INTO dbo.orders VALUES (1, 1, 10.00), (2, 2, 5.50)',
  'CREATE USER analyst WITHOUT LOGIN WITH DEFAULT_SCHEMA = marts',
  'GRANT SELECT ON marts.users TO analyst',
  'GRANT SELECT ON dbo.orders TO analyst',
  'GRANT SELECT ON dbo.active_users TO analyst',
  'GRANT SHOWPLAN TO analyst',
];

async function warehouse() {
  await using resources = new AsyncDisposableStack();
  const database = resources.use(await testSqlServer.database());
  const owner = await database.pool();
  for (const statement of setup) await owner.request().batch(statement);

  /** A user of the database, each session on a connection of its own. */
  const principal = (name: string): SqlServerPrincipal => ({
    name,
    session: async () => {
      const pool = await database.pool({ pool: { max: 1, min: 1 } });
      return {
        batch: async (sql) =>
          (
            await pool.request().batch<Record<string, unknown>>(sql)
          ).recordsets.flat(),
        [Symbol.asyncDispose]: () => pool.close(),
      };
    },
  });

  /** An adapter whose execute runs as `runAs`, as datahub's execute does. */
  const adapter = (runAs: SqlServerPrincipal, policy: SqlPolicyAnalyzer) =>
    new SqlServer({
      grounding: [],
      policy,
      execute: async (sql) => {
        await using session = await runAs.session();
        await session.batch(
          `EXECUTE AS USER = N'${runAs.name}' WITH NO REVERT`,
        );
        return [...(await session.batch(sql))];
      },
    });

  const owned = resources.move();
  return {
    database: database.database,
    password: database.password,
    owner,
    principal,
    analyst: principal('analyst'),
    adapter,
    [Symbol.asyncDispose]: () => owned.disposeAsync(),
  };
}

function scopePayload(outcome: unknown): SQLScopeErrorPayload {
  assert.ok(
    typeof outcome === 'object' &&
      outcome !== null &&
      'error' in outcome &&
      typeof outcome.error === 'string',
    `expected an error, got ${JSON.stringify(outcome)}`,
  );
  return JSON.parse(outcome.error);
}

describe('SQL Server plan policy', () => {
  it('passes one SELECT that the principal may read, and the run gives its rows', async () => {
    await using w = await warehouse();
    const adapter = w.adapter(w.analyst, planPolicy(w.analyst));

    assert.deepStrictEqual(
      await adapter.run('SELECT id, total FROM dbo.orders ORDER BY id'),
      {
        result: [
          { id: 1, total: 10 },
          { id: 2, total: 5.5 },
        ],
      },
    );
    assert.deepStrictEqual(
      await adapter.run('SELECT id, name FROM dbo.active_users'),
      { result: [{ id: 1, name: 'dbo Ada' }] },
    );
    assert.deepStrictEqual(await adapter.run('SELECT 1 AS one'), {
      result: [{ one: 1 }],
    });
    // The plan writes StatementText, which holds the SQL, before
    // StatementType; the policy reads the type only because SQL Server escapes
    // the text's `>`, `<` and `"`.
    assert.deepStrictEqual(
      await adapter.run(
        `SELECT id FROM marts.users WHERE id > 1 AND name <> N'a"b' AND id < 9`,
      ),
      { result: [{ id: 2 }] },
    );
  });

  it('refuses a batch that is not exactly one SELECT as read-only, and runs none of it', async () => {
    await using w = await warehouse();
    // dbo may write, so a statement that ran would change the tables.
    const dbo = w.principal('dbo');
    const adapter = w.adapter(dbo, planPolicy(dbo));

    // SQL Server compiles DDL without a permission check, so DDL is a plan
    // of a statement that is not a SELECT.
    for (const sql of [
      'SELECT 1; DROP TABLE dbo.orders',
      'DROP TABLE dbo.orders',
      'CREATE TABLE dbo.copy (a INT)',
      'CREATE TABLE #t (a INT)',
      'CREATE TABLE #t (a INT); INSERT #t VALUES (1); SELECT a FROM #t',
      'SELECT id, name INTO dbo.copy FROM marts.users',
      'DECLARE @x INT = 1; SELECT @x AS x',
      'REVERT; SELECT 1',
      'SELECT 1 AS a; SELECT 2 AS b',
    ]) {
      assert.deepStrictEqual(await adapter.run(sql), readOnly, sql);
    }
    const tables = await w.owner
      .request()
      .query(
        "SELECT (SELECT COUNT(*) FROM dbo.orders) AS orders, OBJECT_ID(N'dbo.copy') AS copy",
      );
    assert.deepStrictEqual(tables.recordset, [{ orders: 2, copy: null }]);
  });

  it("refuses what the principal may not read or write as OUT_OF_SCOPE in SQL Server's words", async () => {
    await using w = await warehouse();
    const adapter = w.adapter(w.analyst, planPolicy(w.analyst));
    const denied = (permission: string, object: string, schema: string) =>
      `The ${permission} permission was denied on the object '${object}', database '${w.database}', schema '${schema}'.`;

    const cases = [
      ['SELECT id FROM audit.secrets', denied('SELECT', 'secrets', 'audit')],
      [
        'SELECT id FROM dbo.secret_view',
        denied('SELECT', 'secret_view', 'dbo'),
      ],
      [
        'SELECT id FROM dbo.secret_rows()',
        denied('SELECT', 'secret_rows', 'dbo'),
      ],
      ['SELECT NEXT VALUE FOR dbo.ids AS id', denied('UPDATE', 'ids', 'dbo')],
      [
        'INSERT INTO dbo.orders VALUES (3, 1, 1.00)',
        denied('INSERT', 'orders', 'dbo'),
      ],
      ['UPDATE dbo.orders SET total = 0', denied('UPDATE', 'orders', 'dbo')],
    ];
    for (const [sql, error] of cases) {
      assert.deepStrictEqual(
        scopePayload(await adapter.run(sql)),
        {
          error,
          error_type: 'OUT_OF_SCOPE',
          suggestion:
            'Read only the tables and views that the database grants, in one SELECT that writes nothing.',
          sql_attempted: sql,
        },
        sql,
      );
    }
  });

  it('reports SQL that SQL Server cannot compile as a parse error with its message', async () => {
    await using w = await warehouse();
    const adapter = w.adapter(w.analyst, planPolicy(w.analyst));

    const cases = [
      ['SELECT id FROM marts.users LIMIT 1', "Incorrect syntax near '1'."],
      ['SELECT id FROM marts.nothing', "Invalid object name 'marts.nothing'."],
      ['SELECT nope FROM marts.users', "Invalid column name 'nope'."],
    ];
    for (const [sql, message] of cases) {
      const payload = scopePayload(await adapter.run(sql));
      assert.strictEqual(payload.error_type, 'SQL_SCOPE_PARSE_ERROR', sql);
      assert.strictEqual(payload.parser_dialect, 'transactsql', sql);
      assert.strictEqual(payload.parser_error, message, sql);
    }
  });

  it('compiles each SQL in a session of its own, so a SET of one check never reaches the next', async () => {
    await using w = await warehouse();
    const sessions = { opened: 0, disposed: 0 };
    const counted: SqlServerPrincipal = {
      name: 'analyst',
      session: async () => {
        const session = await w.analyst.session();
        sessions.opened += 1;
        return {
          batch: (sql) => session.batch(sql),
          [Symbol.asyncDispose]: async () => {
            sessions.disposed += 1;
            await session[Symbol.asyncDispose]();
          },
        };
      },
    };
    const adapter = w.adapter(w.analyst, planPolicy(counted));

    for (const sql of ['SET PARSEONLY ON', 'SET SHOWPLAN_XML OFF']) {
      assert.deepStrictEqual(await adapter.run(sql), readOnly, sql);
      assert.deepStrictEqual(
        await adapter.run('SELECT id FROM dbo.orders WHERE id = 1'),
        { result: [{ id: 1 }] },
        `after ${sql}`,
      );
    }
    assert.deepStrictEqual(sessions, { opened: 4, disposed: 4 });
  });

  it('rejects the check when the session fails without an error number of SQL Server, and runs nothing', async () => {
    // A real server cannot be made to drop a connection at one batch, so the
    // principal's sessions fail here as a broken network would.
    const executed: string[] = [];
    const adapter = (principal: SqlServerPrincipal) =>
      new SqlServer({
        grounding: [],
        policy: planPolicy(principal),
        execute: (sql) => {
          executed.push(sql);
          return [];
        },
      });
    const unreachable: SqlServerPrincipal = {
      name: 'analyst',
      session: async () => {
        throw new Error('the server is unreachable');
      },
    };
    const reset: SqlServerPrincipal = {
      name: 'analyst',
      session: async () => ({
        batch: async (sql) => {
          if (sql.startsWith('EXECUTE AS') || sql.startsWith('SET SHOWPLAN')) {
            return [];
          }
          throw new Error('the connection was reset');
        },
        [Symbol.asyncDispose]: async () => undefined,
      }),
    };

    await assert.rejects(
      adapter(unreachable).run('SELECT 1'),
      new Error('the server is unreachable'),
    );
    await assert.rejects(
      adapter(reset).run('SELECT 1'),
      new Error('the connection was reset'),
    );
    assert.deepStrictEqual(executed, []);
  });

  it('reports a principal without SHOWPLAN as a parse error and checks again once it is granted', async () => {
    await using w = await warehouse();
    await w.owner
      .request()
      .batch(
        'CREATE USER noplan WITHOUT LOGIN WITH DEFAULT_SCHEMA = marts; GRANT SELECT ON marts.users TO noplan;',
      );
    const noplan = w.principal('noplan');
    const adapter = w.adapter(noplan, planPolicy(noplan));
    const sql = 'SELECT id FROM marts.users WHERE id = 2';

    const payload = scopePayload(await adapter.run(sql));
    assert.strictEqual(payload.error_type, 'SQL_SCOPE_PARSE_ERROR');
    assert.strictEqual(
      payload.parser_error,
      `SHOWPLAN permission denied in database '${w.database}'.`,
    );

    await w.owner.request().batch('GRANT SHOWPLAN TO noplan');
    assert.deepStrictEqual(await adapter.run(sql), { result: [{ id: 2 }] });
  });

  it("passes a lock hint under the plan alone and refuses it when composed with the parser's Forbid(['table-hint'])", async () => {
    await using w = await warehouse();
    const sql = 'SELECT id FROM marts.users WITH (UPDLOCK) WHERE id = 1';
    const plan = w.adapter(w.analyst, planPolicy(w.analyst));
    const composed = w.adapter(
      w.analyst,
      new FirstViolation(
        new SourcePolicy(new SqlText({ dialects: ['transactsql'] }), [
          new Forbid(['table-hint']),
        ]),
        planPolicy(w.analyst),
      ),
    );

    assert.deepStrictEqual(await plan.run(sql), { result: [{ id: 1 }] });
    assert.deepStrictEqual(await composed.run(sql), readOnly);

    // The composition also refuses T-SQL that node-sql-parser cannot read.
    const unparsed =
      "SELECT STRING_AGG(name, N', ') WITHIN GROUP (ORDER BY name) AS names FROM marts.users";
    assert.deepStrictEqual(await plan.run(unparsed), {
      result: [{ names: 'Ada, Bob' }],
    });
    assert.strictEqual(
      scopePayload(await composed.run(unparsed)).error_type,
      'SQL_SCOPE_PARSE_ERROR',
    );
  });

  it('passes the T-SQL that node-sql-parser refuses', async () => {
    await using w = await warehouse();
    const adapter = w.adapter(w.analyst, planPolicy(w.analyst));
    const text = textPolicy();
    const scope = {
      resolveAllowedEntities: async () => ['marts.users', 'dbo.orders'],
    };

    const cases: [string, unknown[]][] = [
      [
        "SELECT STRING_AGG(name, N', ') WITHIN GROUP (ORDER BY name DESC) AS names FROM marts.users",
        [{ names: 'Bob, Ada' }],
      ],
      ["SELECT TRY_CAST(N'x' AS INT) AS n", [{ n: null }]],
      ['SELECT COUNT_BIG(*) AS n FROM marts.users', [{ n: '2' }]],
      [
        `SELECT j.id FROM OPENJSON(N'[{"id":7}]') WITH (id INT '$.id') AS j`,
        [{ id: 7 }],
      ],
      ['SELECT id FROM marts.users ORDER BY id OFFSET 1 ROWS', [{ id: 2 }]],
      [
        'SELECT TOP (1) WITH TIES id FROM dbo.orders ORDER BY user_id',
        [{ id: 1 }],
      ],
      [
        'SELECT id FROM marts.users WHERE id = 1 OPTION (MAXDOP 1)',
        [{ id: 1 }],
      ],
      [
        "SELECT id FROM marts.users WHERE name LIKE N'B!%' ESCAPE N'!' OR name LIKE N'A%'",
        [{ id: 1 }],
      ],
    ];
    for (const [sql, rows] of cases) {
      assert.notStrictEqual(await text.analyze(sql, scope), null, sql);
      assert.deepStrictEqual(await adapter.run(sql), { result: rows }, sql);
    }
  });

  it('refuses a plan that reads a linked server as read-only', async () => {
    await using w = await warehouse();
    const server = `loopback_${w.database}`;
    // A loopback linked server is an object of the shared server, so the
    // test removes it. TRUSTWORTHY lets an impersonated user leave the
    // database, which it needs to reach a linked server.
    await w.owner
      .request()
      .batch(
        `ALTER DATABASE [${w.database}] SET TRUSTWORTHY ON; EXEC sp_addlinkedserver @server = N'${server}', @srvproduct = N'', @provider = N'MSOLEDBSQL', @datasrc = N'localhost', @provstr = N'Encrypt=no;TrustServerCertificate=yes'; EXEC sp_addlinkedsrvlogin @rmtsrvname = N'${server}', @useself = N'FALSE', @locallogin = NULL, @rmtuser = N'sa', @rmtpassword = N'${w.password}';`,
      );
    try {
      // A user without a login has no mapping to the remote login (7416), so
      // the database owner compiles the remote reads.
      const dbo = w.principal('dbo');
      const adapter = w.adapter(dbo, planPolicy(dbo));
      for (const sql of [
        `SELECT id FROM [${server}].[${w.database}].dbo.orders`,
        `SELECT a FROM OPENQUERY([${server}], 'SELECT 1 AS a')`,
      ]) {
        assert.deepStrictEqual(await adapter.run(sql), readOnly, sql);
      }

      const analyst = w.adapter(w.analyst, planPolicy(w.analyst));
      const payload = scopePayload(
        await analyst.run(
          `SELECT id FROM [${server}].[${w.database}].dbo.orders`,
        ),
      );
      assert.strictEqual(payload.error_type, 'SQL_SCOPE_PARSE_ERROR');
      assert.strictEqual(
        payload.parser_error,
        'Access to the remote server is denied because no login-mapping exists.',
      );
    } finally {
      await w.owner
        .request()
        .batch(
          `EXEC sp_dropserver @server = N'${server}', @droplogins = 'droplogins'`,
        );
    }
  });

  it("reads a bare name in the principal's default schema in the check and in the run", async () => {
    await using w = await warehouse();
    const adapter = w.adapter(w.analyst, planPolicy(w.analyst));

    // dbo.users exists too, and the principal may not read it.
    assert.strictEqual(
      scopePayload(await adapter.run('SELECT id, name FROM dbo.users'))
        .error_type,
      'OUT_OF_SCOPE',
    );
    assert.deepStrictEqual(
      await adapter.run('SELECT id, name FROM users ORDER BY id'),
      {
        result: [
          { id: 1, name: 'Ada' },
          { id: 2, name: 'Bob' },
        ],
      },
    );
  });

  it('serves a SourcePolicy of the policy entry, and without GrantedScope a denied compile rejects the check', async () => {
    await using w = await warehouse();
    const granted = w.adapter(
      w.analyst,
      new SourcePolicy(new SqlServerPlan(w.analyst), [
        new GrantedScope(),
        new OneSelect(),
      ]),
    );
    const ungranted = w.adapter(
      w.analyst,
      new SourcePolicy(new SqlServerPlan(w.analyst), [new OneSelect()]),
    );

    assert.strictEqual(
      scopePayload(await granted.run('SELECT id FROM marts.users LIMIT 1'))
        .error_type,
      'SQL_SCOPE_PARSE_ERROR',
    );
    await assert.rejects(
      ungranted.run('SELECT id FROM audit.secrets'),
      new Error(
        `The SELECT permission was denied on the object 'secrets', database '${w.database}', schema 'audit'.`,
      ),
    );
  });
});
