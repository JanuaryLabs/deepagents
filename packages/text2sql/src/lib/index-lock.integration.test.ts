import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { after, describe, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import {
  AdapterIndexer,
  FileIndexCache,
  FileIndexLock,
  type IndexLock,
  type Text2SqlIndexProgressEvent,
} from '@deepagents/text2sql';

import { init_db } from '../tests/sqlite.ts';

/**
 * A real per-key mutex standing in for a host-supplied distributed lock
 * (Redis / Postgres advisory lock). Serializes `run` calls that share a key
 * and records every key it was asked to guard.
 */
class KeyMutexLock implements IndexLock {
  readonly calls: string[] = [];
  readonly #chains = new Map<string, Promise<unknown>>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    this.calls.push(key);
    const previous = this.#chains.get(key) ?? Promise.resolve();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#chains.set(
      key,
      previous.then(() => held),
    );
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

function countIntrospections(adapter: { introspect: Function }): {
  count: () => number;
} {
  let count = 0;
  const original = adapter.introspect.bind(adapter);
  adapter.introspect = async (ctx?: unknown) => {
    count += 1;
    await sleep(50);
    return original(ctx);
  };
  return { count: () => count };
}

function eventTypes(events: Text2SqlIndexProgressEvent[]): string[] {
  return events.map((event) => event.type);
}

async function tempCacheDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'text2sql-cache-'));
  after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

describe('AdapterIndexer with an injected cache and lock', () => {
  it('runs a single introspection for concurrent index calls on the same adapter', async () => {
    const { adapter, db } = await init_db(
      'CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);',
    );
    after(() => db.close());

    const introspections = countIntrospections(adapter);
    const cache = new FileIndexCache({ dir: await tempCacheDir() });
    const lock = new KeyMutexLock();
    const indexer = new AdapterIndexer({
      adapters: { main: adapter },
      cache,
      lock,
    });

    const firstEvents: Text2SqlIndexProgressEvent[] = [];
    const secondEvents: Text2SqlIndexProgressEvent[] = [];
    const [first, second] = await Promise.all([
      indexer.index({ onProgress: (event) => firstEvents.push(event) }),
      indexer.index({ onProgress: (event) => secondEvents.push(event) }),
    ]);

    assert.strictEqual(
      introspections.count(),
      1,
      'introspection should run exactly once across concurrent callers',
    );
    assert.deepStrictEqual(
      lock.calls,
      ['main', 'main'],
      'both callers acquire the lock under the per-adapter key',
    );

    const allTypes = [...eventTypes(firstEvents), ...eventTypes(secondEvents)];
    assert.strictEqual(
      allTypes.filter((t) => t === 'adapter:cache-miss').length,
      1,
    );
    assert.strictEqual(
      allTypes.filter((t) => t === 'adapter:cache-hit').length,
      1,
    );
    assert.deepStrictEqual(second, JSON.parse(JSON.stringify(first)));
  });

  it('fails closed when the lock store is unavailable', async () => {
    const { adapter, db } = await init_db(
      'CREATE TABLE users (id INTEGER PRIMARY KEY);',
    );
    after(() => db.close());

    const introspections = countIntrospections(adapter);
    const failingLock: IndexLock = {
      run: async () => {
        throw new Error('lock store down');
      },
    };
    const indexer = new AdapterIndexer({
      adapters: { main: adapter },
      lock: failingLock,
    });

    await assert.rejects(
      () => indexer.index(),
      /introspecting adapter "main": lock store down/,
    );
    assert.strictEqual(
      introspections.count(),
      0,
      'introspection must not run when the lock cannot be acquired',
    );
  });
});

describe('AdapterIndexer with a cache', () => {
  it('introspects on miss then serves a warm cache hit', async () => {
    const { adapter, db } = await init_db(
      'CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);',
    );
    after(() => db.close());

    const introspections = countIntrospections(adapter);
    const cache = new FileIndexCache({ dir: await tempCacheDir() });
    const indexer = new AdapterIndexer({
      adapters: { main: adapter },
      cache,
      lock: new KeyMutexLock(),
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

describe('AdapterIndexer with a lock but no cache', () => {
  it('introspects every call and emits no cache events', async () => {
    const { adapter, db } = await init_db(
      'CREATE TABLE users (id INTEGER PRIMARY KEY);',
    );
    after(() => db.close());

    const introspections = countIntrospections(adapter);
    const indexer = new AdapterIndexer({
      adapters: { main: adapter },
      lock: new KeyMutexLock(),
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
  it('deduplicates introspection across separate indexers sharing a dir + lock', async () => {
    const dir = await tempCacheDir();
    const lock = new KeyMutexLock();

    const hostA = await init_db(
      'CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);',
    );
    const hostB = await init_db(
      'CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);',
    );
    after(() => {
      hostA.db.close();
      hostB.db.close();
    });

    const introA = countIntrospections(hostA.adapter);
    const introB = countIntrospections(hostB.adapter);

    const indexerA = new AdapterIndexer({
      adapters: { main: hostA.adapter },
      cache: new FileIndexCache({ dir }),
      lock,
    });
    const indexerB = new AdapterIndexer({
      adapters: { main: hostB.adapter },
      cache: new FileIndexCache({ dir }),
      lock,
    });

    const eventsA: Text2SqlIndexProgressEvent[] = [];
    const eventsB: Text2SqlIndexProgressEvent[] = [];
    const [a, b] = await Promise.all([
      indexerA.index({ onProgress: (event) => eventsA.push(event) }),
      indexerB.index({ onProgress: (event) => eventsB.push(event) }),
    ]);

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
    const { adapter, db } = await init_db(
      'CREATE TABLE users (id INTEGER PRIMARY KEY);',
    );
    after(() => db.close());

    const dir = await tempCacheDir();
    const introspections = countIntrospections(adapter);
    const indexer = new AdapterIndexer({
      adapters: { main: adapter },
      cache: new FileIndexCache({ dir }),
      lock: new KeyMutexLock(),
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

describe('FileIndexLock serializes concurrent introspection', () => {
  it('runs a single introspection for concurrent indexers sharing a dir + FileIndexLock', async () => {
    const dir = await tempCacheDir();

    const hostA = await init_db(
      'CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);',
    );
    const hostB = await init_db(
      'CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);',
    );
    after(() => {
      hostA.db.close();
      hostB.db.close();
    });

    const introA = countIntrospections(hostA.adapter);
    const introB = countIntrospections(hostB.adapter);

    const indexerA = new AdapterIndexer({
      adapters: { main: hostA.adapter },
      cache: new FileIndexCache({ dir }),
      lock: new FileIndexLock({ dir }),
    });
    const indexerB = new AdapterIndexer({
      adapters: { main: hostB.adapter },
      cache: new FileIndexCache({ dir }),
      lock: new FileIndexLock({ dir }),
    });

    const [a, b] = await Promise.all([indexerA.index(), indexerB.index()]);

    assert.strictEqual(
      introA.count() + introB.count(),
      1,
      'two FileIndexLock instances over one dir + shared cache collapse to a single introspection',
    );
    assert.deepStrictEqual(
      JSON.parse(JSON.stringify(a)),
      JSON.parse(JSON.stringify(b)),
    );
  });
});

describe('FileIndexLock run() contract', () => {
  it('creates a missing lock dir and returns the critical section result', async () => {
    const dir = path.join(await tempCacheDir(), 'nested', 'locks');
    const lock = new FileIndexLock({ dir });

    const result = await lock.run('adapter', async () => 'value');

    assert.strictEqual(result, 'value');
  });

  it('releases the lock even when the critical section throws', async () => {
    const lock = new FileIndexLock({ dir: await tempCacheDir() });

    await assert.rejects(
      () => lock.run('adapter', () => Promise.reject(new Error('boom'))),
      /boom/,
    );

    const after = await lock.run('adapter', async () => 'ok');
    assert.strictEqual(after, 'ok');
  });
});
