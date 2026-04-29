import { generateId } from 'ai';
import assert from 'node:assert';
import { describe, it } from 'node:test';

import {
  ContextEngine,
  InMemoryContextStore,
  createBashTool,
  getFragmentData,
} from '@deepagents/context';
import { Text2Sql } from '@deepagents/text2sql';
import * as sqlite from '@deepagents/text2sql/sqlite';

import { init_db } from '../src/tests/sqlite.ts';

const sandbox = await createBashTool();

function makeText2Sql(
  version: string,
  adapters: Record<string, Awaited<ReturnType<typeof init_db>>['adapter']>,
) {
  const store = new InMemoryContextStore();
  return new Text2Sql({
    version,
    sandbox,
    adapters,
    model: {} as never,
    context: (...fragments) => {
      const engine = new ContextEngine({
        store,
        chatId: `cache-test-${generateId()}`,
        userId: 'test',
      });
      engine.set(...fragments);
      return engine;
    },
  });
}

describe('Text2Sql.index() — cache isolation', () => {
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

    const first = makeText2Sql(version, { main: mainAdapter });
    await first.index();
    assert.strictEqual(mainIntrospectCalls, 1, 'warmed main cache');

    const { adapter: analyticsAdapter } = await init_db(
      `CREATE TABLE events (id INTEGER);`,
      { grounding: [sqlite.tables()] },
    );

    const second = makeText2Sql(version, {
      main: mainAdapter,
      analytics: analyticsAdapter,
    });
    const fragments = await second.index();

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

    const t2s = makeText2Sql(`wrap-${generateId()}`, {
      my_db: adapter,
    });
    const fragments = await t2s.index();

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

describe('Text2Sql.index() — error annotation', () => {
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

    const t2s = makeText2Sql(`err-${generateId()}`, {
      main: goodAdapter,
      broken: badAdapter,
    });

    await assert.rejects(
      () => t2s.index(),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.match(message, /broken/);
        assert.match(message, /connection refused/);
        return true;
      },
    );
  });
});
