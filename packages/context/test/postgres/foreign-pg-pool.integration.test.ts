import { Postgres } from '@zukhruf/testing/postgres';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { sep } from 'node:path';
import { test } from 'node:test';
import pg from 'pg';

import {
  PostgresContextStore,
  PostgresNotifyChangeSource,
  PostgresStreamStore,
} from '@deepagents/context';

const testPostgres = new Postgres({ environment: process.env });

/**
 * A pg.Pool from a second copy of pg, as a host's own node_modules or a linked
 * workspace loads it. The first copy is restored to the require cache, so the
 * stores keep resolving the copy they were built against.
 */
function poolFromAnotherPgCopy(connectionString: string): pg.Pool {
  const require = createRequire(import.meta.url);
  const pgDirectory = `${sep}node_modules${sep}pg${sep}`;
  const firstCopy = Object.entries(require.cache).filter(([path]) =>
    path.includes(pgDirectory),
  );
  for (const [path] of firstCopy) delete require.cache[path];
  const secondCopy: typeof pg = require('pg');
  for (const [path, module] of firstCopy) require.cache[path] = module;
  assert.notEqual(secondCopy.Pool, pg.Pool, 'a distinct pg copy');
  return new secondCopy.Pool({ connectionString });
}

test('the Postgres stores run on a host pool from another pg copy and leave it open', async () => {
  await using database = await testPostgres.database();
  const pool = poolFromAnotherPgCopy(database.connectionString);
  let acquiredFromHostPool = 0;
  pool.on('acquire', () => acquiredFromHostPool++);
  try {
    const store = await PostgresContextStore.create({ pool });
    await store.createChat({ id: 'chat-1', userId: 'user-1' });
    const chat = await store.getChat('chat-1');
    const streams = await PostgresStreamStore.create({ pool });
    const missing = await streams.getStreamStatus('no-such-stream');
    const changes = await PostgresNotifyChangeSource.create({ pool });
    await changes.close();
    const acquiredByStores = acquiredFromHostPool;

    assert.deepStrictEqual(
      {
        chatUser: chat?.userId,
        missing,
        storesBorrowedTheHostPool: acquiredByStores > 0,
        poolStillOpen: (await pool.query('SELECT 1 AS one')).rows,
      },
      {
        chatUser: 'user-1',
        missing: undefined,
        storesBorrowedTheHostPool: true,
        poolStillOpen: [{ one: 1 }],
      },
    );
  } finally {
    await pool.end();
  }
});
