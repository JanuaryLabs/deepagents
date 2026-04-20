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
