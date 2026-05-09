import { generateId } from 'ai';
import assert from 'node:assert';
import { describe, it } from 'node:test';

import { getFragmentData } from '@deepagents/context';
import { AdapterIndexer } from '@deepagents/text2sql';
import * as sqlite from '@deepagents/text2sql/sqlite';

import { init_db } from '../src/tests/sqlite.ts';

function indexTestAdapters(
  version: string,
  adapters: Record<string, Awaited<ReturnType<typeof init_db>>['adapter']>,
) {
  return new AdapterIndexer({
    version,
    adapters,
  }).index();
}

describe('AdapterIndexer — cache isolation', () => {
  it('does not re-introspect an adapter when a second adapter is added under the same version', async () => {
    const version = `cache-iso-${generateId()}`;

    const { adapter: mainAdapter } = await init_db(
      `CREATE TABLE users (id INTEGER);`,
      { grounding: [sqlite.tables()] },
    );

    let mainIntrospectCalls = 0;
    const originalIntrospect = mainAdapter.introspect.bind(mainAdapter);
    mainAdapter.introspect = async (...args) => {
      mainIntrospectCalls++;
      return originalIntrospect(...args);
    };

    await indexTestAdapters(version, { main: mainAdapter });
    assert.strictEqual(mainIntrospectCalls, 1, 'warmed main cache');

    const { adapter: analyticsAdapter } = await init_db(
      `CREATE TABLE events (id INTEGER);`,
      { grounding: [sqlite.tables()] },
    );

    const fragments = await indexTestAdapters(version, {
      main: mainAdapter,
      analytics: analyticsAdapter,
    });

    assert.strictEqual(
      mainIntrospectCalls,
      1,
      'adding analytics must not force re-introspecting main',
    );

    const names = fragments.map((f) => f.name);
    assert.deepStrictEqual(names, ['main', 'analytics']);
  });

  it('wraps each adapter fragment tree under a parent fragment named after the adapter key', async () => {
    const { adapter } = await init_db(`CREATE TABLE users (id INTEGER);`, {
      grounding: [sqlite.tables()],
    });

    const fragments = await indexTestAdapters(`wrap-${generateId()}`, {
      my_db: adapter,
    });

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
    const { adapter: goodAdapter } = await init_db(
      `CREATE TABLE t (n INTEGER);`,
      { grounding: [sqlite.tables()] },
    );
    const { adapter: badAdapter } = await init_db(
      `CREATE TABLE t (n INTEGER);`,
    );
    badAdapter.introspect = async () => {
      throw new Error('connection refused');
    };

    await assert.rejects(
      () =>
        indexTestAdapters(`err-${generateId()}`, {
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
