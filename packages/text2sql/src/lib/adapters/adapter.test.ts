import { TemporaryFiles } from '@zukhruf/fs';
import { Sqlite as TestSqlite } from '@zukhruf/testing/sqlite';
import assert from 'node:assert';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  Adapter,
  type SqlPolicyAnalyzer,
  type SqlPolicyViolation,
  Text2Sql,
  Text2SqlValidationError,
} from '@deepagents/text2sql';
import { BigQuery } from '@deepagents/text2sql/bigquery';
import { ClickHouse } from '@deepagents/text2sql/clickhouse';
import { DuckDB } from '@deepagents/text2sql/duckdb';
import { createGroundingContext } from '@deepagents/text2sql/grounding';
import { Mysql } from '@deepagents/text2sql/mysql';
import { FirstViolation } from '@deepagents/text2sql/policy';
import { Postgres } from '@deepagents/text2sql/postgres';
import { PostHog } from '@deepagents/text2sql/posthog';
import { Spreadsheet } from '@deepagents/text2sql/spreadsheet';
import { Sqlite, tables } from '@deepagents/text2sql/sqlite';
import { SqlServer } from '@deepagents/text2sql/sqlserver';

const testSqlite = new TestSqlite();
const temporaryFiles = new TemporaryFiles();

const READ_ONLY_MESSAGE = 'only SELECT or WITH queries allowed';

function isReadOnlyError(error: unknown): error is Error {
  return (
    Error.isError(error) &&
    error.name === 'SQLReadOnlyError' &&
    error.message === READ_ONLY_MESSAGE
  );
}

class PolicyWiringAdapter extends Adapter {
  override readonly formatterLanguage = 'sqlite';
  override readonly defaultSchema = undefined;
  override readonly systemSchemas: string[] = [];
  override grounding = [];
  executeCalls = 0;
  resolveScopeCalls = 0;
  validateCalls = 0;

  constructor(policyAnalyzer: SqlPolicyAnalyzer) {
    super(policyAnalyzer);
  }

  override executeImpl(sql: string): any[] {
    this.executeCalls++;
    return [{ sql }];
  }

  override async resolveAllowedEntities(): Promise<string[]> {
    this.resolveScopeCalls++;
    return [];
  }

  override validateImpl(): void {
    this.validateCalls++;
  }

  protected override queryRows(): unknown[] {
    return [];
  }

  override quoteIdentifier(name: string): string {
    return `"${name.replaceAll('"', '""')}"`;
  }

  override escape(value: string): string {
    return value.replaceAll('"', '""');
  }

  override buildSampleRowsQuery(
    tableName: string,
    _columns: string[] | undefined,
    limit: number,
  ): string {
    return `SELECT * FROM ${this.quoteIdentifier(tableName)} LIMIT ${limit}`;
  }
}

describe('Adapter policy strategy wiring', () => {
  it('accepts grounding contexts created before custom fragments existed', async () => {
    const adapter = new PolicyWiringAdapter({
      async analyze() {
        return null;
      },
    });
    const legacyContext = createGroundingContext();
    delete legacyContext.fragments;

    assert.deepStrictEqual(await adapter.introspect(legacyContext), []);
  });

  it('delegates validate and execute policy to the injected analyzer', async () => {
    const calls: Array<{ sql: string; allowedEntities: readonly string[] }> =
      [];
    const analyzer: SqlPolicyAnalyzer = {
      async analyze(sql, context) {
        const allowedEntities = await context.resolveAllowedEntities();
        calls.push({ sql, allowedEntities });
        return null;
      },
    };
    const adapter = new PolicyWiringAdapter(analyzer);

    assert.strictEqual(await adapter.validate('SELECT 1'), undefined);
    assert.deepStrictEqual(await adapter.execute('SELECT 2'), [
      { sql: 'SELECT 2' },
    ]);
    assert.deepStrictEqual(calls, [
      { sql: 'SELECT 1', allowedEntities: [] },
      { sql: 'SELECT 2', allowedEntities: [] },
    ]);
    assert.strictEqual(adapter.resolveScopeCalls, 1);
  });

  it('does not call adapter validation after the analyzer denies SQL', async () => {
    const adapter = new PolicyWiringAdapter({
      async analyze() {
        return { kind: 'read-only', message: READ_ONLY_MESSAGE };
      },
    });

    assert.strictEqual(
      await adapter.validate('DROP TABLE users'),
      READ_ONLY_MESSAGE,
    );
    await assert.rejects(
      () => adapter.execute('DROP TABLE users'),
      isReadOnlyError,
    );
    assert.strictEqual(adapter.resolveScopeCalls, 0);
  });

  it('fails closed when the asynchronous analyzer throws', async () => {
    const policyError = new Error('policy analysis unavailable');
    const adapter = new PolicyWiringAdapter({
      async analyze() {
        await Promise.resolve();
        throw policyError;
      },
    });

    await assert.rejects(
      () => adapter.validate('SELECT 1'),
      (error: unknown) => error === policyError,
    );
    await assert.rejects(
      () => adapter.execute('SELECT 1'),
      (error: unknown) => error === policyError,
    );
    assert.strictEqual(adapter.validateCalls, 0);
    assert.strictEqual(adapter.executeCalls, 0);
    assert.strictEqual(adapter.resolveScopeCalls, 0);
  });
});

describe('Adapter policy option', () => {
  it('checks SQL with the policy option in place of the default of every adapter', async () => {
    await using directory = await temporaryFiles.directory('text2sql-policy-');
    const csvPath = path.join(directory.path, 'numbers.csv');
    await writeFile(csvPath, 'value\n1\n');
    const denial: SqlPolicyViolation = {
      kind: 'read-only',
      message: 'denied by the host policy',
    };
    const policy: SqlPolicyAnalyzer = {
      async analyze() {
        return denial;
      },
    };
    const execute = () => {
      throw new Error('The host policy denies SQL before it runs.');
    };
    const spreadsheet = new Spreadsheet({
      file: csvPath,
      grounding: [],
      policy,
    });
    const adapters: Adapter[] = [
      new BigQuery({
        execute,
        validate: execute,
        grounding: [],
        datasets: ['analytics'],
        policy,
      }),
      new ClickHouse({ execute, validate: execute, policy }),
      new DuckDB({ execute, policy }),
      new Mysql({ execute, grounding: [], policy }),
      new Postgres({ execute, grounding: [], policy }),
      new PostHog({
        transport: {
          query: async () => execute(),
          listEventDefinitions: async () => [],
          listPropertyDefinitions: async () => [],
        },
        policy,
      }),
      spreadsheet,
      new Sqlite({ execute, grounding: [], policy }),
      new SqlServer({ execute, grounding: [], policy }),
    ];

    try {
      for (const adapter of adapters) {
        assert.strictEqual(
          await adapter.validate('SELECT 1'),
          denial.message,
          adapter.constructor.name,
        );
      }
    } finally {
      spreadsheet.close();
    }
  });

  it('runs the policies of a FirstViolation in order and stops at the first violation', async () => {
    const asked: string[] = [];
    const policy = (
      name: string,
      violation: SqlPolicyViolation | null,
    ): SqlPolicyAnalyzer => ({
      async analyze() {
        asked.push(name);
        return violation;
      },
    });
    await using database = await testSqlite.database();
    const execute = (sql: string) => database.connection.prepare(sql).all();

    const firstDenies = new Sqlite({
      execute,
      grounding: [],
      policy: new FirstViolation(
        policy('first', { kind: 'read-only', message: 'first denies' }),
        policy('second', { kind: 'read-only', message: 'second denies' }),
      ),
    });
    assert.strictEqual(await firstDenies.validate('SELECT 1'), 'first denies');
    assert.deepStrictEqual(asked, ['first']);

    asked.length = 0;
    const secondDenies = new Sqlite({
      execute,
      grounding: [],
      policy: new FirstViolation(
        policy('first', null),
        policy('second', { kind: 'read-only', message: 'second denies' }),
        policy('third', { kind: 'read-only', message: 'third denies' }),
      ),
    });
    assert.strictEqual(
      await secondDenies.validate('SELECT 1'),
      'second denies',
    );
    assert.deepStrictEqual(asked, ['first', 'second']);

    asked.length = 0;
    const allowed = new Sqlite({
      execute,
      grounding: [],
      policy: new FirstViolation(policy('first', null), policy('second', null)),
    });
    assert.strictEqual(await allowed.validate('SELECT 1'), undefined);
    assert.deepStrictEqual(asked, ['first', 'second']);
  });

  it('checks SQL with the policy once per Text2Sql run', async () => {
    await using database = await testSqlite.database();
    const checked: string[] = [];
    const text2sql = new Text2Sql({
      adapters: {
        main: new Sqlite({
          execute: (sql) => database.connection.prepare(sql).all(),
          grounding: [],
          policy: {
            async analyze(sql) {
              checked.push(sql);
              return null;
            },
          },
        }),
      },
    });

    const { rows } = await text2sql.run('main', 'SELECT 1 AS one');

    assert.deepStrictEqual(structuredClone(rows), [{ one: 1 }]);
    assert.strictEqual(checked.length, 1);
  });

  it('refuses a Text2Sql run that the policy denies before the database sees it', async () => {
    const executed: string[] = [];
    const text2sql = new Text2Sql({
      adapters: {
        main: new Sqlite({
          execute: (sql) => {
            executed.push(sql);
            return [];
          },
          grounding: [],
          policy: {
            async analyze() {
              return {
                kind: 'read-only',
                message: 'denied by the host policy',
              };
            },
          },
        }),
      },
    });

    await assert.rejects(
      () => text2sql.run('main', 'SELECT 1'),
      (error: unknown) =>
        Text2SqlValidationError.isInstance(error) &&
        error.message === 'denied by the host policy',
    );
    assert.deepStrictEqual(executed, []);
  });
});

describe('Adapter read-only enforcement', () => {
  it('validate allows line comments before SELECT', async () => {
    let validatedSql: string | undefined;
    await using database = await testSqlite.database();
    const adapter = new Sqlite({
      execute: (sql) => database.connection.prepare(sql).all(),
      grounding: [],
      validate: (sql) => {
        validatedSql = sql;
      },
    });
    const sql = '-- note\nSELECT 1';
    const error = await adapter.validate(sql);
    assert.strictEqual(error, undefined);
    assert.strictEqual(validatedSql, sql);
  });

  it('validate allows block comments before SELECT', async () => {
    let validatedSql: string | undefined;
    await using database = await testSqlite.database();
    const adapter = new Sqlite({
      execute: (sql) => database.connection.prepare(sql).all(),
      grounding: [],
      validate: (sql) => {
        validatedSql = sql;
      },
    });
    const sql = '/* note */\nSELECT 1';
    const error = await adapter.validate(sql);
    assert.strictEqual(error, undefined);
    assert.strictEqual(validatedSql, sql);
  });

  it('validate allows multiple leading comments before WITH', async () => {
    let validatedSql: string | undefined;
    await using database = await testSqlite.database();
    const adapter = new Sqlite({
      execute: (sql) => database.connection.prepare(sql).all(),
      grounding: [],
      validate: (sql) => {
        validatedSql = sql;
      },
    });
    const sql =
      '  -- line note\n\t/* block note */\nWITH t AS (SELECT 1 AS v) SELECT * FROM t';
    const error = await adapter.validate(sql);
    assert.strictEqual(error, undefined);
    assert.strictEqual(validatedSql, sql);
  });

  it('validate allows shell-escaped newlines after a line comment', async () => {
    let validatedSql: string | undefined;
    await using database = await testSqlite.database();
    const adapter = new Sqlite({
      execute: (sql) => database.connection.prepare(sql).all(),
      grounding: [],
      validate: (sql) => {
        validatedSql = sql;
      },
    });
    const error = await adapter.validate('-- note\\nSELECT 1');
    assert.strictEqual(error, undefined);
    assert.strictEqual(validatedSql, '-- note\nSELECT 1');
  });

  it('validate rejects line-comment-prefixed DELETE', async () => {
    await using database = await testSqlite.database();
    const adapter = new Sqlite({
      execute: (sql) => database.connection.prepare(sql).all(),
      grounding: [],
    });
    const error = await adapter.validate('-- note\nDELETE FROM users');
    assert.strictEqual(error, READ_ONLY_MESSAGE);
  });

  it('validate rejects block-comment-prefixed INSERT', async () => {
    await using database = await testSqlite.database();
    const adapter = new Sqlite({
      execute: (sql) => database.connection.prepare(sql).all(),
      grounding: [],
    });
    const error = await adapter.validate(
      '/* note */\nINSERT INTO users VALUES (1)',
    );
    assert.strictEqual(error, READ_ONLY_MESSAGE);
  });

  it('validate rejects comment-only queries', async () => {
    await using database = await testSqlite.database();
    const adapter = new Sqlite({
      execute: (sql) => database.connection.prepare(sql).all(),
      grounding: [],
    });
    const error = await adapter.validate('-- note\n/* still no statement */');
    assert.strictEqual(error, READ_ONLY_MESSAGE);
  });

  it('validate rejects multi-statement batches containing writes', async () => {
    await using database = await testSqlite.database();
    const adapter = new Sqlite({
      execute: (sql) => database.connection.prepare(sql).all(),
      grounding: [],
    });
    const error = await adapter.validate('SELECT 1; DELETE FROM users');
    assert.strictEqual(error, READ_ONLY_MESSAGE);
  });

  it('validate rejects multi-statement batches even when each statement is SELECT', async () => {
    await using database = await testSqlite.database();
    const adapter = new Sqlite({
      execute: (sql) => database.connection.prepare(sql).all(),
      grounding: [],
    });
    const error = await adapter.validate('SELECT 1; SELECT 2');
    assert.strictEqual(error, READ_ONLY_MESSAGE);
  });

  it('validate returns consumer errors for comment-prefixed SELECT', async () => {
    await using database = await testSqlite.database();
    const adapter = new Sqlite({
      execute: (sql) => database.connection.prepare(sql).all(),
      grounding: [],
      validate: (sql) => {
        if (sql.includes('--')) return 'SQL comments are not allowed';
        return undefined;
      },
    });
    const error = await adapter.validate('-- note\nSELECT 1');
    assert.strictEqual(error, 'SQL comments are not allowed');
  });

  it('validate returns error for DROP', async () => {
    await using database = await testSqlite.database();
    const adapter = new Sqlite({
      execute: (sql) => database.connection.prepare(sql).all(),
      grounding: [],
    });
    const error = await adapter.validate('DROP TABLE x');
    assert.strictEqual(error, READ_ONLY_MESSAGE);
  });

  it('execute throws SQLReadOnlyError for DROP', async () => {
    await using database = await testSqlite.database();
    const adapter = new Sqlite({
      execute: (sql) => database.connection.prepare(sql).all(),
      grounding: [],
    });
    await assert.rejects(
      () => adapter.execute('DROP TABLE x'),
      isReadOnlyError,
    );
  });

  it('validate allows SELECT', async () => {
    await using database = await testSqlite.database();
    const adapter = new Sqlite({
      execute: (sql) => database.connection.prepare(sql).all(),
      grounding: [],
    });
    const error = await adapter.validate('SELECT 1');
    assert.strictEqual(error, undefined);
  });

  it('validate allows WITH (CTE)', async () => {
    await using database = await testSqlite.database();
    const adapter = new Sqlite({
      execute: (sql) => database.connection.prepare(sql).all(),
      grounding: [],
    });
    const error = await adapter.validate(
      'WITH t AS (SELECT 1 as v) SELECT * FROM t',
    );
    assert.strictEqual(error, undefined);
  });

  it('validate allows lowercase select', async () => {
    await using database = await testSqlite.database();
    const adapter = new Sqlite({
      execute: (sql) => database.connection.prepare(sql).all(),
      grounding: [],
    });
    const error = await adapter.validate('select 1');
    assert.strictEqual(error, undefined);
  });

  it('validate allows SELECT with leading whitespace', async () => {
    await using database = await testSqlite.database();
    const adapter = new Sqlite({
      execute: (sql) => database.connection.prepare(sql).all(),
      grounding: [],
    });
    const error = await adapter.validate('   SELECT 1');
    assert.strictEqual(error, undefined);
  });

  it('validate rejects INSERT', async () => {
    await using database = await testSqlite.database();
    const adapter = new Sqlite({
      execute: (sql) => database.connection.prepare(sql).all(),
      grounding: [],
    });
    const error = await adapter.validate('INSERT INTO t VALUES (1)');
    assert.strictEqual(error, READ_ONLY_MESSAGE);
  });

  it('validate rejects UPDATE', async () => {
    await using database = await testSqlite.database();
    const adapter = new Sqlite({
      execute: (sql) => database.connection.prepare(sql).all(),
      grounding: [],
    });
    const error = await adapter.validate('UPDATE t SET x = 1');
    assert.strictEqual(error, READ_ONLY_MESSAGE);
  });

  it('validate rejects DELETE', async () => {
    await using database = await testSqlite.database();
    const adapter = new Sqlite({
      execute: (sql) => database.connection.prepare(sql).all(),
      grounding: [],
    });
    const error = await adapter.validate('DELETE FROM t');
    assert.strictEqual(error, READ_ONLY_MESSAGE);
  });

  it('execute throws on INSERT', async () => {
    await using database = await testSqlite.database();
    const adapter = new Sqlite({
      execute: (sql) => database.connection.prepare(sql).all(),
      grounding: [],
    });
    await assert.rejects(
      () => adapter.execute('INSERT INTO t VALUES (1)'),
      isReadOnlyError,
    );
  });
});

describe('Adapter shell-escape decoding', () => {
  it('decodes literal backslash-n in validate', async () => {
    await using database = await testSqlite.database();
    const adapter = new Sqlite({
      execute: (sql) => database.connection.prepare(sql).all(),
      grounding: [],
    });
    const error = await adapter.validate('SELECT\\n  1 as val');
    assert.strictEqual(error, undefined);
  });

  it('decodes literal backslash-t in validate', async () => {
    await using database = await testSqlite.database();
    const adapter = new Sqlite({
      execute: (sql) => database.connection.prepare(sql).all(),
      grounding: [],
    });
    const error = await adapter.validate('SELECT\\t1 as val');
    assert.strictEqual(error, undefined);
  });

  it('decodes shell-escaped parentheses', async () => {
    const ddl =
      'CREATE TABLE Emails (id INTEGER PRIMARY KEY, senderEmail TEXT)';
    await using database = await testSqlite.database();
    database.connection.exec(ddl);
    const adapter = new Sqlite({
      execute: (sql) => database.connection.prepare(sql).all(),
      grounding: [tables()],
    });
    const error = await adapter.validate(
      'SELECT senderEmail, COUNT\\(*) as c FROM Emails GROUP BY senderEmail',
    );
    assert.strictEqual(error, undefined);
  });

  it('decodes shell-escaped asterisk', async () => {
    const ddl =
      'CREATE TABLE Emails (id INTEGER PRIMARY KEY, senderEmail TEXT)';
    await using database = await testSqlite.database();
    database.connection.exec(ddl);
    const adapter = new Sqlite({
      execute: (sql) => database.connection.prepare(sql).all(),
      grounding: [tables()],
    });
    const error = await adapter.validate('SELECT \\* FROM Emails LIMIT 1');
    assert.strictEqual(error, undefined);
  });

  it('decodes shell-escaped dot in numeric literal', async () => {
    await using database = await testSqlite.database();
    const adapter = new Sqlite({
      execute: (sql) => database.connection.prepare(sql).all(),
      grounding: [],
    });
    const error = await adapter.validate('SELECT 1\\.5 as val');
    assert.strictEqual(error, undefined);
  });

  it('strips trailing backslash at end of input', async () => {
    await using database = await testSqlite.database();
    const adapter = new Sqlite({
      execute: (sql) => database.connection.prepare(sql).all(),
      grounding: [],
    });
    const error = await adapter.validate('SELECT 1 as val\\');
    assert.strictEqual(error, undefined);
  });

  it('preserves backslash before space inside SQL string literal', async () => {
    const ddl =
      "CREATE TABLE Files (id INTEGER PRIMARY KEY, path TEXT); INSERT INTO Files VALUES (1, 'C:\\Program Files\\test')";
    await using database = await testSqlite.database();
    database.connection.exec(ddl);
    const adapter = new Sqlite({
      execute: (sql) => database.connection.prepare(sql).all(),
      grounding: [tables()],
    });
    const rows = await adapter.execute(
      "SELECT path FROM Files WHERE path LIKE 'C:\\Program%' LIMIT 1",
    );
    assert.strictEqual(rows.length, 1);
  });

  it('decoding is idempotent when called on already-formatted SQL', async () => {
    await using database = await testSqlite.database();
    const adapter = new Sqlite({
      execute: (sql) => database.connection.prepare(sql).all(),
      grounding: [],
    });
    const formatted = adapter.format('SELECT\\n 1 as val');
    const error = await adapter.validate(formatted);
    assert.strictEqual(error, undefined);
  });
});
