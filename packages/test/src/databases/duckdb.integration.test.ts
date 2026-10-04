import { DuckDBConnection, DuckDBInstance } from '@duckdb/node-api';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DuckDB } from '@deepagents/test';

test('concurrent DuckDB acquisitions isolate data and dispose independently', async () => {
  const duckdb = new DuckDB();
  await using resources = new AsyncDisposableStack();
  const [first, second] = await Promise.all([
    duckdb.database().then((database) => resources.use(database)),
    duckdb.database().then((database) => resources.use(database)),
  ]);
  for (const [database, value] of [
    [first, 1],
    [second, 2],
  ] as const) {
    await database.connection.run('CREATE TABLE isolated (value INTEGER)');
    await database.connection.run('INSERT INTO isolated VALUES ($1)', [value]);
    const rows = await database.connection.runAndReadAll(
      'SELECT * FROM isolated',
    );
    assert.deepEqual(rows.getRowObjectsJson(), [{ value }]);
  }

  const { cleanup } = first;
  await cleanup();
  await cleanup();
  await assert.rejects(
    first.connection.run('SELECT 1'),
    /connection disconnected/,
  );
  const rows = await second.connection.runAndReadAll('SELECT * FROM isolated');
  assert.deepEqual(rows.getRowObjectsJson(), [{ value: 2 }]);

  await using next = await duckdb.database();
  await assert.rejects(
    next.connection.run('SELECT * FROM isolated'),
    /does not exist/,
  );
});

test('DuckDB scope failure closes the native connection before its instance', async (t) => {
  const closed: string[] = [];
  const closeConnection = DuckDBConnection.prototype.closeSync;
  const closeInstance = DuckDBInstance.prototype.closeSync;
  t.mock.method(
    DuckDBConnection.prototype,
    'closeSync',
    function (this: DuckDBConnection) {
      closed.push('connection');
      closeConnection.call(this);
    },
  );
  t.mock.method(
    DuckDBInstance.prototype,
    'closeSync',
    function (this: DuckDBInstance) {
      closed.push('instance');
      closeInstance.call(this);
    },
  );
  const database = await new DuckDB().database();
  const failure = new Error('intentional test failure');
  await assert.rejects(async () => {
    await using scoped = database;
    await scoped.connection.run('CREATE TABLE records (value INTEGER)');
    throw failure;
  }, failure);

  assert.deepEqual(closed, ['connection', 'instance']);
  await assert.rejects(
    database.connection.run('SELECT 1'),
    /connection disconnected/,
  );
  await database.cleanup();
  assert.deepEqual(closed, ['connection', 'instance']);
});

test('DuckDB connection failure releases the acquired native instance', async (t) => {
  const failure = new Error('connection failed');
  t.mock.method(DuckDBInstance.prototype, 'connect', async () => {
    throw failure;
  });
  const close = t.mock.method(DuckDBInstance.prototype, 'closeSync');

  await assert.rejects(new DuckDB().database(), failure);
  assert.equal(close.mock.callCount(), 1);
});
