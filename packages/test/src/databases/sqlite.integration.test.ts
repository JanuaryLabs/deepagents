import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { Sqlite } from '@deepagents/test';

test('concurrent SQLite acquisitions isolate data and dispose independently', async () => {
  const sqlite = new Sqlite();
  await using resources = new AsyncDisposableStack();
  const [first, second] = await Promise.all([
    sqlite.database().then((database) => resources.use(database)),
    sqlite.database().then((database) => resources.use(database)),
  ]);
  assert.notEqual(first.path, second.path);
  for (const [database, value] of [
    [first, 1],
    [second, 2],
  ] as const) {
    database.connection.exec('CREATE TABLE isolated (value INTEGER)');
    database.connection.prepare('INSERT INTO isolated VALUES (?)').run(value);
  }

  // A second connection sees the same data: this is a real file-backed database.
  {
    using reopened = new DatabaseSync(first.path);
    assert.equal(
      reopened.prepare('SELECT value FROM isolated').get()?.value,
      1,
    );
  }
  const { cleanup } = first;
  await cleanup();
  await cleanup();
  assert.equal(first.connection.isOpen, false);
  await assert.rejects(access(dirname(first.path)), { code: 'ENOENT' });
  assert.equal(second.connection.isOpen, true);
  assert.equal(
    second.connection.prepare('SELECT value FROM isolated').get()?.value,
    2,
  );

  await using next = await sqlite.database();
  assert.notEqual(next.path, first.path);
  assert.notEqual(next.path, second.path);
  assert.equal(
    next.connection
      .prepare(
        "SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'table'",
      )
      .get()?.count,
    0,
  );
});

test('SQLite scope failure closes the connection and removes database and WAL files', async () => {
  const database = await new Sqlite().database();
  const failure = new Error('intentional test failure');
  await assert.rejects(async () => {
    await using scoped = database;
    scoped.connection.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE records (value INTEGER);
      INSERT INTO records VALUES (1);
    `);
    await access(scoped.path);
    await access(`${scoped.path}-wal`);
    throw failure;
  }, failure);

  assert.equal(database.connection.isOpen, false);
  await assert.rejects(access(dirname(database.path)), { code: 'ENOENT' });
  await database.cleanup();
});

test(
  'SQLite write locks release on exceptional scope exit',
  { timeout: 2_000 },
  async () => {
    const sqlite = new Sqlite();
    await using database = await sqlite.database();
    database.connection.exec('CREATE TABLE records (value INTEGER)');
    const failure = new Error('intentional lock scope failure');

    await assert.rejects(async () => {
      await using lock = await sqlite.writeLock(database.path, 10_000);
      assert.throws(
        () => database.connection.exec('INSERT INTO records VALUES (1)'),
        /database is locked/,
      );
      throw failure;
    }, failure);

    database.connection.exec('INSERT INTO records VALUES (2)');
    assert.equal(
      database.connection.prepare('SELECT value FROM records').get()?.value,
      2,
    );
  },
);

test('SQLite write locks expire while the caller waits in a synchronous write', async () => {
  const sqlite = new Sqlite();
  await using database = await sqlite.database();
  database.connection.exec('CREATE TABLE records (value INTEGER)');
  await using lock = await sqlite.writeLock(database.path, 200);
  assert.throws(
    () => database.connection.exec('INSERT INTO records VALUES (1)'),
    /database is locked/,
  );

  database.connection.exec('PRAGMA busy_timeout = 5000');
  database.connection.exec('INSERT INTO records VALUES (2)');

  assert.equal(
    database.connection.prepare('SELECT value FROM records').get()?.value,
    2,
  );
});

test('SQLite write locks surface startup failure without waiting for readiness', async () => {
  const sqlite = new Sqlite();
  await using database = await sqlite.database();
  const missing = join(dirname(database.path), 'missing', 'database.sqlite');

  await assert.rejects(
    sqlite.writeLock(missing, 10_000),
    (error: unknown) =>
      error instanceof Error &&
      'stderr' in error &&
      /unable to open database file/.test(String(error.stderr)),
  );

  database.connection.exec('CREATE TABLE records (value INTEGER)');
  await using lock = await sqlite.writeLock(database.path, 10_000);
  assert.throws(
    () => database.connection.exec('INSERT INTO records VALUES (1)'),
    /database is locked/,
  );
});
