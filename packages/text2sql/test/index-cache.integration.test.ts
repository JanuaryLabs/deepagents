import { generateId } from 'ai';
import assert from 'node:assert';
import { describe, it } from 'node:test';

import { getFragmentData } from '@deepagents/context';
import { Sqlite as TestSqlite } from '@deepagents/test';
import {
  AdapterIndexer,
  FileIndexCache,
  FileIndexLock,
  type IndexCache,
} from '@deepagents/text2sql';
import * as sqlite from '@deepagents/text2sql/sqlite';

const testSqlite = new TestSqlite();

function indexTestAdapters(
  adapters: Record<string, sqlite.Sqlite>,
  cache?: IndexCache,
) {
  return new AdapterIndexer({
    adapters,
    cache,
    lock: new FileIndexLock({ namespace: generateId() }),
  }).index();
}

describe('AdapterIndexer — cache isolation', () => {
  it('does not re-introspect an adapter when a second adapter is added under the same version', async () => {
    const cache = new FileIndexCache({
      namespace: `cache-iso-${generateId()}`,
    });

    await using mainDatabase = await testSqlite.database();
    mainDatabase.connection.exec(`CREATE TABLE users (id INTEGER);`);
    const mainAdapter = new sqlite.Sqlite({
      execute: (sql) => mainDatabase.connection.prepare(sql).all(),
      grounding: [sqlite.tables()],
    });

    let mainIntrospectCalls = 0;
    const originalIntrospect = mainAdapter.introspect.bind(mainAdapter);
    mainAdapter.introspect = async (...args) => {
      mainIntrospectCalls++;
      return originalIntrospect(...args);
    };

    await indexTestAdapters({ main: mainAdapter }, cache);
    assert.strictEqual(mainIntrospectCalls, 1, 'warmed main cache');

    await using analyticsDatabase = await testSqlite.database();
    analyticsDatabase.connection.exec(`CREATE TABLE events (id INTEGER);`);
    const analyticsAdapter = new sqlite.Sqlite({
      execute: (sql) => analyticsDatabase.connection.prepare(sql).all(),
      grounding: [sqlite.tables()],
    });

    const fragments = await indexTestAdapters(
      {
        main: mainAdapter,
        analytics: analyticsAdapter,
      },
      cache,
    );

    assert.strictEqual(
      mainIntrospectCalls,
      1,
      'adding analytics must not force re-introspecting main',
    );

    const names = fragments.map((f) => f.name);
    assert.deepStrictEqual(names, ['main', 'analytics']);
  });

  it('wraps each adapter fragment tree under a parent fragment named after the adapter key', async () => {
    await using database = await testSqlite.database();
    database.connection.exec(`CREATE TABLE users (id INTEGER);`);
    const adapter = new sqlite.Sqlite({
      execute: (sql) => database.connection.prepare(sql).all(),
      grounding: [sqlite.tables()],
    });

    const fragments = await indexTestAdapters({ my_db: adapter });

    assert.strictEqual(fragments.length, 1);
    assert.strictEqual(fragments[0].name, 'my_db');
    const inner = getFragmentData(fragments[0]);
    assert.ok(
      Array.isArray(inner),
      'parent fragment holds an array of children',
    );
    assert.ok(
      (inner as unknown[]).length > 0,
      'parent wraps adapter fragments',
    );
  });
});

describe('AdapterIndexer — error annotation', () => {
  it('annotates introspection errors with the failing adapter name', async () => {
    await using goodDatabase = await testSqlite.database();
    goodDatabase.connection.exec(`CREATE TABLE t (n INTEGER);`);
    const goodAdapter = new sqlite.Sqlite({
      execute: (sql) => goodDatabase.connection.prepare(sql).all(),
      grounding: [sqlite.tables()],
    });
    await using badDatabase = await testSqlite.database();
    badDatabase.connection.exec(`CREATE TABLE t (n INTEGER);`);
    const badAdapter = new sqlite.Sqlite({
      execute: (sql) => badDatabase.connection.prepare(sql).all(),
      grounding: [],
    });
    badAdapter.introspect = async () => {
      throw new Error('connection refused');
    };

    await assert.rejects(
      () =>
        indexTestAdapters({
          main: goodAdapter,
          broken: badAdapter,
        }),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.match(message, /broken/);
        assert.match(message, /connection refused/);
        return true;
      },
    );
  });
});
