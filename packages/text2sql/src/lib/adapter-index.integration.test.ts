import { Sqlite as TestSqlite } from '@zukhruf/testing/sqlite';
import assert from 'node:assert';
import { mkdtempDisposable, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import {
  type Adapter,
  AdapterIndexer,
  FileIndexCache,
  type Text2SqlIndexProgressEvent,
} from '@deepagents/text2sql';
import { Sqlite } from '@deepagents/text2sql/sqlite';

const testSqlite = new TestSqlite();

function countIntrospections(adapter: Pick<Adapter, 'introspect'>): {
  count: () => number;
} {
  let count = 0;
  const original = adapter.introspect.bind(adapter);
  adapter.introspect = async (ctx) => {
    count += 1;
    await sleep(50);
    return original(ctx);
  };
  return { count: () => count };
}

function eventTypes(events: Text2SqlIndexProgressEvent[]): string[] {
  return events.map((event) => event.type);
}

describe('AdapterIndexer with a cache', () => {
  it('introspects on miss then serves a warm cache hit', async () => {
    await using database = await testSqlite.database();
    database.connection.exec(
      'CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);',
    );
    const adapter = new Sqlite({
      execute: (sql) => database.connection.prepare(sql).all(),
      grounding: [],
    });

    const introspections = countIntrospections(adapter);
    await using directory = await mkdtempDisposable(
      path.join(tmpdir(), 'text2sql-cache-'),
    );
    const cache = new FileIndexCache({ dir: directory.path });
    const indexer = new AdapterIndexer({
      adapters: { main: adapter },
      cache,
    });

    const firstEvents: Text2SqlIndexProgressEvent[] = [];
    const first = await indexer.index({
      onProgress: (event) => firstEvents.push(event),
    });

    const secondEvents: Text2SqlIndexProgressEvent[] = [];
    const second = await indexer.index({
      onProgress: (event) => secondEvents.push(event),
    });

    assert.strictEqual(
      introspections.count(),
      1,
      'second call reuses the cache',
    );
    assert.ok(eventTypes(firstEvents).includes('adapter:cache-miss'));
    assert.ok(!eventTypes(firstEvents).includes('adapter:cache-hit'));
    assert.ok(eventTypes(secondEvents).includes('adapter:cache-hit'));
    assert.ok(!eventTypes(secondEvents).includes('adapter:cache-miss'));
    assert.deepStrictEqual(second, JSON.parse(JSON.stringify(first)));
  });
});

describe('AdapterIndexer without a cache', () => {
  it('introspects every call and emits no cache events', async () => {
    await using database = await testSqlite.database();
    database.connection.exec('CREATE TABLE users (id INTEGER PRIMARY KEY);');
    const adapter = new Sqlite({
      execute: (sql) => database.connection.prepare(sql).all(),
      grounding: [],
    });

    const introspections = countIntrospections(adapter);
    const indexer = new AdapterIndexer({
      adapters: { main: adapter },
    });

    const events: Text2SqlIndexProgressEvent[] = [];
    await indexer.index({ onProgress: (event) => events.push(event) });
    await indexer.index({ onProgress: (event) => events.push(event) });

    assert.strictEqual(introspections.count(), 2, 'no cache means no reuse');
    assert.ok(!eventTypes(events).includes('adapter:cache-hit'));
    assert.ok(!eventTypes(events).includes('adapter:cache-miss'));
  });
});

describe('FileIndexCache shared across indexers', () => {
  it('deduplicates introspection across separate indexers sharing a cache dir', async () => {
    await using directory = await mkdtempDisposable(
      path.join(tmpdir(), 'text2sql-cache-'),
    );
    const dir = directory.path;

    await using hostADatabase = await testSqlite.database();
    hostADatabase.connection.exec(
      'CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);',
    );
    const hostA = new Sqlite({
      execute: (sql) => hostADatabase.connection.prepare(sql).all(),
      grounding: [],
    });
    await using hostBDatabase = await testSqlite.database();
    hostBDatabase.connection.exec(
      'CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);',
    );
    const hostB = new Sqlite({
      execute: (sql) => hostBDatabase.connection.prepare(sql).all(),
      grounding: [],
    });

    const introA = countIntrospections(hostA);
    const introB = countIntrospections(hostB);

    const indexerA = new AdapterIndexer({
      adapters: { main: hostA },
      cache: new FileIndexCache({ dir }),
    });
    const indexerB = new AdapterIndexer({
      adapters: { main: hostB },
      cache: new FileIndexCache({ dir }),
    });

    const eventsA: Text2SqlIndexProgressEvent[] = [];
    const eventsB: Text2SqlIndexProgressEvent[] = [];
    const a = await indexerA.index({
      onProgress: (event) => eventsA.push(event),
    });
    const b = await indexerB.index({
      onProgress: (event) => eventsB.push(event),
    });

    assert.strictEqual(
      introA.count() + introB.count(),
      1,
      'exactly one introspection across both indexers sharing the cache dir',
    );

    const allTypes = [...eventTypes(eventsA), ...eventTypes(eventsB)];
    assert.strictEqual(
      allTypes.filter((t) => t === 'adapter:cache-miss').length,
      1,
    );
    assert.strictEqual(
      allTypes.filter((t) => t === 'adapter:cache-hit').length,
      1,
    );
    assert.deepStrictEqual(
      JSON.parse(JSON.stringify(a)),
      JSON.parse(JSON.stringify(b)),
    );
  });
});

describe('FileIndexCache corrupt-file resilience', () => {
  it('re-introspects when the cache file is unparseable instead of throwing', async () => {
    await using database = await testSqlite.database();
    database.connection.exec('CREATE TABLE users (id INTEGER PRIMARY KEY);');
    const adapter = new Sqlite({
      execute: (sql) => database.connection.prepare(sql).all(),
      grounding: [],
    });

    await using directory = await mkdtempDisposable(
      path.join(tmpdir(), 'text2sql-cache-'),
    );
    const dir = directory.path;
    const introspections = countIntrospections(adapter);
    const indexer = new AdapterIndexer({
      adapters: { main: adapter },
      cache: new FileIndexCache({ dir }),
    });

    await indexer.index();
    assert.strictEqual(introspections.count(), 1);

    const [cacheFile] = await readdir(dir);
    assert.ok(cacheFile, 'a cache file was written');
    await writeFile(path.join(dir, cacheFile), '{ not valid json', 'utf-8');

    const events: Text2SqlIndexProgressEvent[] = [];
    const fragments = await indexer.index({
      onProgress: (event) => events.push(event),
    });

    assert.strictEqual(
      introspections.count(),
      2,
      'a corrupt cache file is treated as a miss and re-introspected',
    );
    assert.ok(eventTypes(events).includes('adapter:cache-miss'));
    assert.ok(Array.isArray(fragments));
  });
});

describe('AdapterIndexer.indexAdapter (single-adapter entry point)', () => {
  it('introspects once on a cache miss then serves a warm cache hit', async () => {
    await using database = await testSqlite.database();
    database.connection.exec(
      'CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);',
    );
    const adapter = new Sqlite({
      execute: (sql) => database.connection.prepare(sql).all(),
      grounding: [],
    });
    await using directory = await mkdtempDisposable(
      path.join(tmpdir(), 'text2sql-cache-'),
    );
    const dir = directory.path;
    const introspections = countIntrospections(adapter);
    const indexer = new AdapterIndexer({
      adapters: { main: adapter },
      cache: new FileIndexCache({ dir }),
    });

    const firstEvents: Text2SqlIndexProgressEvent[] = [];
    const first = await indexer.indexAdapter('main', {
      onProgress: (event) => firstEvents.push(event),
    });

    const secondEvents: Text2SqlIndexProgressEvent[] = [];
    const second = await indexer.indexAdapter('main', {
      onProgress: (event) => secondEvents.push(event),
    });

    assert.ok(
      Array.isArray(first),
      'a cache miss introspects and returns a fragment array',
    );
    assert.strictEqual(
      introspections.count(),
      1,
      'the warm second call reuses the cache instead of re-introspecting',
    );
    assert.ok(eventTypes(firstEvents).includes('adapter:cache-miss'));
    assert.ok(!eventTypes(firstEvents).includes('adapter:cache-hit'));
    assert.ok(eventTypes(secondEvents).includes('adapter:cache-hit'));
    assert.ok(!eventTypes(secondEvents).includes('adapter:cache-miss'));
    assert.deepStrictEqual(second, JSON.parse(JSON.stringify(first)));
  });

  it('returns raw adapter fragments without the <database> wrapper that index() adds', async () => {
    await using database = await testSqlite.database();
    database.connection.exec(
      'CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);',
    );
    const adapter = new Sqlite({
      execute: (sql) => database.connection.prepare(sql).all(),
      grounding: [],
    });
    await using directory = await mkdtempDisposable(
      path.join(tmpdir(), 'text2sql-cache-'),
    );
    const dir = directory.path;
    const indexer = new AdapterIndexer({
      adapters: { main: adapter },
      cache: new FileIndexCache({ dir }),
    });

    const raw = await indexer.indexAdapter('main');
    const wrapped = await indexer.index({ adapterNames: ['main'] });

    assert.strictEqual(
      wrapped.length,
      1,
      'index() emits one wrapper fragment per adapter',
    );
    assert.strictEqual(wrapped[0].name, 'main');
    assert.ok(
      raw.every((f) => f.name !== 'main' && f.name !== 'database'),
      'indexAdapter returns the raw schema with no adapter/database wrapper',
    );

    const children = wrapped[0].data;
    assert.ok(Array.isArray(children));
    assert.deepStrictEqual(
      children[0],
      { name: 'database', data: 'main' },
      'index() prepends a <database> name leaf that indexAdapter omits',
    );
    assert.deepStrictEqual(
      JSON.parse(JSON.stringify(children.slice(1))),
      JSON.parse(JSON.stringify(raw)),
      'the wrapper body minus the database leaf is exactly the raw fragments',
    );
  });

  it('rejects an unknown adapter name and lists the available adapters', async () => {
    await using database = await testSqlite.database();
    database.connection.exec('CREATE TABLE users (id INTEGER PRIMARY KEY);');
    const adapter = new Sqlite({
      execute: (sql) => database.connection.prepare(sql).all(),
      grounding: [],
    });

    const introspections = countIntrospections(adapter);
    const indexer = new AdapterIndexer({
      adapters: { main: adapter },
    });

    await assert.rejects(
      () => indexer.indexAdapter('orders'),
      /unknown adapter "orders"\. Available: main/,
    );
    assert.strictEqual(
      introspections.count(),
      0,
      'an unknown adapter name never triggers introspection',
    );
  });
});
