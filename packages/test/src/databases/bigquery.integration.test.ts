import { BigQuery as BigQueryClient, Dataset } from '@google-cloud/bigquery';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BigQuery } from '@deepagents/test';

test('BigQuery datasets isolate queries and dispose independently', async (t) => {
  const projectId = process.env['TEXT2SQL_BIGQUERY_PROJECT_ID'];
  const location = process.env['TEXT2SQL_BIGQUERY_LOCATION'];
  if (!projectId || !location) {
    t.skip('Set TEXT2SQL_BIGQUERY_PROJECT_ID and TEXT2SQL_BIGQUERY_LOCATION');
    return;
  }
  const bigquery = new BigQuery({ projectId, location });
  const resources = new AsyncDisposableStack();
  try {
    const first = resources.use(await bigquery.dataset());
    const second = resources.use(await bigquery.dataset());
    assert.ok(first.dataset instanceof Dataset);
    assert.notEqual(first.dataset.id, second.dataset.id);
    assert.equal(first.dataset.projectId, projectId);
    assert.equal(first.dataset.location, location);

    for (const [database, value] of [
      [first, 1],
      [second, 2],
    ] as const) {
      await database.dataset.query(
        `CREATE TABLE records AS SELECT ${value} AS value`,
      );
      const [rows] = await database.dataset.query('SELECT value FROM records');
      assert.deepEqual(rows, [{ value }]);
      await database.dataset.createQueryJob({
        query: 'SELECT value FROM records',
        dryRun: true,
      });
    }

    const { cleanup } = first;
    await cleanup();
    await cleanup();
    assert.equal((await first.dataset.exists())[0], false);
    const [rows] = await second.dataset.query('SELECT value FROM records');
    assert.deepEqual(rows, [{ value: 2 }]);
    await second.cleanup();
    assert.equal((await second.dataset.exists())[0], false);
  } finally {
    await resources.disposeAsync();
  }
});

test('BigQuery scope failure removes its dataset, tables and views', async (t) => {
  const projectId = process.env['TEXT2SQL_BIGQUERY_PROJECT_ID'];
  const location = process.env['TEXT2SQL_BIGQUERY_LOCATION'];
  if (!projectId || !location) {
    t.skip('Set TEXT2SQL_BIGQUERY_PROJECT_ID and TEXT2SQL_BIGQUERY_LOCATION');
    return;
  }
  const database = await new BigQuery({ projectId, location }).dataset();
  const failure = new Error('intentional test failure');
  try {
    await assert.rejects(
      async () => {
        await using scoped = database;
        await scoped.dataset.query(`
        CREATE TABLE records AS SELECT 1 AS value;
        CREATE VIEW visible_records AS SELECT * FROM records;
      `);
        throw failure;
      },
      (error) => error === failure,
    );
    assert.equal((await database.dataset.exists())[0], false);
  } finally {
    await database.cleanup();
  }
});

test('BigQuery acquisition failures reject without deleting an unowned dataset', async (t) => {
  const failure = new Error('dataset creation denied');
  const request = t.mock.method(
    BigQueryClient.prototype,
    'request',
    (...[options, callback]: Parameters<BigQueryClient['request']>) => {
      assert.equal(options.method, 'POST');
      callback(failure);
    },
  );

  await assert.rejects(
    new BigQuery({ projectId: 'test-project', location: 'EU' }).dataset(),
    (error) => error === failure,
  );
  assert.equal(request.mock.callCount(), 1);
});

test('BigQuery cleanup forwards recursive deletion and reports its failure', async (t) => {
  const failure = new Error('dataset deletion denied');
  const request = t.mock.method(
    BigQueryClient.prototype,
    'request',
    (...[options, callback]: Parameters<BigQueryClient['request']>) => {
      if (options.method === 'POST') {
        callback(null, {});
        return;
      }
      assert.equal(options.method, 'DELETE');
      assert.deepEqual(options.qs, { deleteContents: true });
      callback(failure);
    },
  );
  const database = await new BigQuery({
    projectId: 'test-project',
    location: 'EU',
  }).dataset();
  try {
    await assert.rejects(database.cleanup(), (error) => error === failure);
    await database.cleanup();
    assert.equal(request.mock.callCount(), 2);
  } finally {
    await database.cleanup();
  }
});
