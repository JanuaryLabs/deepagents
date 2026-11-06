import { open } from '@zukhruf/sqlite-open';
import { TemporaryFiles } from '@zukhruf/testing/fs';
import { Sqlite } from '@zukhruf/testing/sqlite';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import * as sqliteVec from 'sqlite-vec';

import { type Chunk, SQLiteStore, nodeSQLite } from '@deepagents/retrieval';

const sqlite = new Sqlite();

describe('SQLiteStore under a cross-process write lock', () => {
  it("rejects with SQLite's busy error when another process takes the write lock while the corpus is chunked", async () => {
    await using directory = await new TemporaryFiles().directory(
      'retrieval-lock-',
    );
    const path = join(directory.path, 'store.sqlite');
    using database = open(path, { allowExtension: true });
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
    await using directory = await new TemporaryFiles().directory(
      'retrieval-lock-',
    );
    const path = join(directory.path, 'store.sqlite');
    using database = open(path, { allowExtension: true });
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

describe('a new vector store', () => {
  it('has pages of 32 KiB, for its large vector rows', async () => {
    await using directory = await new TemporaryFiles().directory(
      'retrieval-pages-',
    );
    const path = join(directory.path, 'store.sqlite');

    nodeSQLite(path, 3);

    using reader = open(path, { readOnly: true });
    assert.equal(reader.prepare('PRAGMA page_size').get()?.page_size, 32768);
  });
});
