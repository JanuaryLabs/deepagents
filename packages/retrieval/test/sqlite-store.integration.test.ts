import { Sqlite } from '@zukhruf/testing/sqlite';
import assert from 'node:assert/strict';
import { mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import * as sqliteVec from 'sqlite-vec';

import { type Chunk, SQLiteStore } from '@deepagents/retrieval';

const sqlite = new Sqlite();

describe('SQLiteStore under a cross-process write lock', () => {
  it("rejects with SQLite's busy error when another process takes the write lock while the corpus is chunked", async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'retrieval-lock-'),
    );
    const path = join(directory.path, 'store.sqlite');
    using database = new DatabaseSync(path, { allowExtension: true });
    database.loadExtension(sqliteVec.getLoadablePath());
    const store = new SQLiteStore(database, 3);
    // The caller owns this connection; a short timeout keeps the wait brief.
    database.exec('PRAGMA busy_timeout = 50');
    const locks = new AsyncDisposableStack();
    try {
      await assert.rejects(
        store.index('docs', {
          id: 'readme',
          cid: 'v1',
          // Another process starts writing while this corpus is being read.
          chunker: async function* (): AsyncGenerator<Chunk> {
            locks.use(await sqlite.writeLock(path, 2_000));
            yield { content: 'hello', embedding: [1, 0, 0] };
          },
        }),
        { errcode: 5, message: /database is locked/ },
      );
    } finally {
      await locks.disposeAsync();
    }
  });

  it("waits for another process's write transaction and then indexes the corpus", async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'retrieval-lock-'),
    );
    const path = join(directory.path, 'store.sqlite');
    using database = new DatabaseSync(path, { allowExtension: true });
    database.loadExtension(sqliteVec.getLoadablePath());
    const store = new SQLiteStore(database, 3);
    const locks = new AsyncDisposableStack();
    try {
      await store.index('docs', {
        id: 'readme',
        cid: 'v1',
        // Another process writes for 200 ms while this corpus is being read.
        chunker: async function* (): AsyncGenerator<Chunk> {
          locks.use(await sqlite.writeLock(path, 200));
          yield { content: 'hello', embedding: [1, 0, 0] };
        },
      });

      const results = await store.search(
        'hello',
        { sourceId: 'docs' },
        async () => ({ embeddings: [[1, 0, 0]], dimensions: 3 }),
      );
      assert.deepEqual(
        results.map(({ content }) => content),
        ['hello'],
      );
    } finally {
      await locks.disposeAsync();
    }
  });
});
