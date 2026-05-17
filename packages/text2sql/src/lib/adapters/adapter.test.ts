import assert from 'node:assert';
import { describe, it } from 'node:test';

import { tables } from '@deepagents/text2sql/sqlite';

import { init_db } from '../../tests/sqlite.ts';

const READ_ONLY_MESSAGE = 'only SELECT or WITH queries allowed';

function isReadOnlyError(error: unknown): error is Error {
  return (
    error instanceof Error &&
    error.name === 'SQLReadOnlyError' &&
    error.message === READ_ONLY_MESSAGE
  );
}

describe('Adapter read-only enforcement', () => {
  it('validate allows line comments before SELECT', async () => {
    let validatedSql: string | undefined;
    const { adapter } = await init_db('', {
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
    const { adapter } = await init_db('', {
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
    const { adapter } = await init_db('', {
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
    const { adapter } = await init_db('', {
      validate: (sql) => {
        validatedSql = sql;
      },
    });
    const error = await adapter.validate('-- note\\nSELECT 1');
    assert.strictEqual(error, undefined);
    assert.strictEqual(validatedSql, '-- note\nSELECT 1');
  });

  it('validate rejects line-comment-prefixed DELETE', async () => {
    const { adapter } = await init_db('');
    const error = await adapter.validate('-- note\nDELETE FROM users');
    assert.strictEqual(error, READ_ONLY_MESSAGE);
  });

  it('validate rejects block-comment-prefixed INSERT', async () => {
    const { adapter } = await init_db('');
    const error = await adapter.validate(
      '/* note */\nINSERT INTO users VALUES (1)',
    );
    assert.strictEqual(error, READ_ONLY_MESSAGE);
  });

  it('validate rejects comment-only queries', async () => {
    const { adapter } = await init_db('');
    const error = await adapter.validate('-- note\n/* still no statement */');
    assert.strictEqual(error, READ_ONLY_MESSAGE);
  });

  it('validate rejects multi-statement batches containing writes', async () => {
    const { adapter } = await init_db('');
    const error = await adapter.validate('SELECT 1; DELETE FROM users');
    assert.strictEqual(error, READ_ONLY_MESSAGE);
  });

  it('validate rejects multi-statement batches even when each statement is SELECT', async () => {
    const { adapter } = await init_db('');
    const error = await adapter.validate('SELECT 1; SELECT 2');
    assert.strictEqual(error, READ_ONLY_MESSAGE);
  });

  it('validate returns consumer errors for comment-prefixed SELECT', async () => {
    const { adapter } = await init_db('', {
      validate: (sql) => {
        if (sql.includes('--')) return 'SQL comments are not allowed';
        return undefined;
      },
    });
    const error = await adapter.validate('-- note\nSELECT 1');
    assert.strictEqual(error, 'SQL comments are not allowed');
  });

  it('validate returns error for DROP', async () => {
    const { adapter } = await init_db('');
    const error = await adapter.validate('DROP TABLE x');
    assert.strictEqual(error, READ_ONLY_MESSAGE);
  });

  it('execute throws SQLReadOnlyError for DROP', async () => {
    const { adapter } = await init_db('');
    await assert.rejects(
      () => adapter.execute('DROP TABLE x'),
      isReadOnlyError,
    );
  });

  it('validate allows SELECT', async () => {
    const { adapter } = await init_db('');
    const error = await adapter.validate('SELECT 1');
    assert.strictEqual(error, undefined);
  });

  it('validate allows WITH (CTE)', async () => {
    const { adapter } = await init_db('');
    const error = await adapter.validate(
      'WITH t AS (SELECT 1 as v) SELECT * FROM t',
    );
    assert.strictEqual(error, undefined);
  });

  it('validate allows lowercase select', async () => {
    const { adapter } = await init_db('');
    const error = await adapter.validate('select 1');
    assert.strictEqual(error, undefined);
  });

  it('validate allows SELECT with leading whitespace', async () => {
    const { adapter } = await init_db('');
    const error = await adapter.validate('   SELECT 1');
    assert.strictEqual(error, undefined);
  });

  it('validate rejects INSERT', async () => {
    const { adapter } = await init_db('');
    const error = await adapter.validate('INSERT INTO t VALUES (1)');
    assert.strictEqual(error, READ_ONLY_MESSAGE);
  });

  it('validate rejects UPDATE', async () => {
    const { adapter } = await init_db('');
    const error = await adapter.validate('UPDATE t SET x = 1');
    assert.strictEqual(error, READ_ONLY_MESSAGE);
  });

  it('validate rejects DELETE', async () => {
    const { adapter } = await init_db('');
    const error = await adapter.validate('DELETE FROM t');
    assert.strictEqual(error, READ_ONLY_MESSAGE);
  });

  it('execute throws on INSERT', async () => {
    const { adapter } = await init_db('');
    await assert.rejects(
      () => adapter.execute('INSERT INTO t VALUES (1)'),
      isReadOnlyError,
    );
  });
});

describe('Adapter shell-escape decoding', () => {
  it('decodes literal backslash-n in validate', async () => {
    const { adapter } = await init_db('');
    const error = await adapter.validate('SELECT\\n  1 as val');
    assert.strictEqual(error, undefined);
  });

  it('decodes literal backslash-t in validate', async () => {
    const { adapter } = await init_db('');
    const error = await adapter.validate('SELECT\\t1 as val');
    assert.strictEqual(error, undefined);
  });

  it('decodes shell-escaped parentheses', async () => {
    const ddl =
      'CREATE TABLE Emails (id INTEGER PRIMARY KEY, senderEmail TEXT)';
    const { adapter } = await init_db(ddl, { grounding: [tables()] });
    const error = await adapter.validate(
      'SELECT senderEmail, COUNT\\(*) as c FROM Emails GROUP BY senderEmail',
    );
    assert.strictEqual(error, undefined);
  });

  it('decodes shell-escaped asterisk', async () => {
    const ddl =
      'CREATE TABLE Emails (id INTEGER PRIMARY KEY, senderEmail TEXT)';
    const { adapter } = await init_db(ddl, { grounding: [tables()] });
    const error = await adapter.validate('SELECT \\* FROM Emails LIMIT 1');
    assert.strictEqual(error, undefined);
  });

  it('decodes shell-escaped dot in numeric literal', async () => {
    const { adapter } = await init_db('');
    const error = await adapter.validate('SELECT 1\\.5 as val');
    assert.strictEqual(error, undefined);
  });

  it('strips trailing backslash at end of input', async () => {
    const { adapter } = await init_db('');
    const error = await adapter.validate('SELECT 1 as val\\');
    assert.strictEqual(error, undefined);
  });

  it('preserves backslash before space inside SQL string literal', async () => {
    const ddl =
      "CREATE TABLE Files (id INTEGER PRIMARY KEY, path TEXT); INSERT INTO Files VALUES (1, 'C:\\Program Files\\test')";
    const { adapter } = await init_db(ddl, { grounding: [tables()] });
    const rows = await adapter.execute(
      "SELECT path FROM Files WHERE path LIKE 'C:\\Program%' LIMIT 1",
    );
    assert.strictEqual(rows.length, 1);
  });

  it('decoding is idempotent when called on already-formatted SQL', async () => {
    const { adapter } = await init_db('');
    const formatted = adapter.format('SELECT\\n 1 as val');
    const error = await adapter.validate(formatted);
    assert.strictEqual(error, undefined);
  });
});
