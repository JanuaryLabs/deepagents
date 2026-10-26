import { Sqlite } from '@zukhruf/testing/sqlite';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import * as sqliteVec from 'sqlite-vec';

import { SQLiteStore, similaritySearch } from '@deepagents/retrieval';

const sqlite = new Sqlite();

function openWithVec(path: string) {
  const database = new DatabaseSync(path, { allowExtension: true });
  database.loadExtension(sqliteVec.getLoadablePath());
  return database;
}

// Answers only the texts it knows, with vectors of the given size.
function embedder(vectors: Record<string, number[]>) {
  return async (texts: string[]) => ({
    embeddings: texts.map((text) => {
      const vector = vectors[text];
      if (!vector) throw new Error(`Unexpected text to embed: ${text}`);
      return vector;
    }),
    dimensions: Object.values(vectors)[0].length,
  });
}

describe('SQLiteStore source expiry', () => {
  it('indexes a source with an expiry date and finds its document', async () => {
    await using database = await sqlite.database();
    database.connection.close();
    using connection = openWithVec(database.path);
    const store = new SQLiteStore(connection, 3);

    await store.index(
      'docs',
      {
        id: 'readme',
        cid: 'v1',
        chunker: async function* () {
          yield { content: 'hello world', embedding: [1, 0, 0] };
        },
      },
      new Date('2100-01-01T00:00:00.000Z'),
    );
    const results = await store.search(
      'greeting',
      { sourceId: 'docs' },
      embedder({ greeting: [1, 0, 0] }),
    );

    assert.deepEqual(
      results.map(({ content, document_id }) => ({ content, document_id })),
      [{ content: 'hello world', document_id: 'readme' }],
    );
  });

  it("ingests a source again in the 'expired' mode only after its expiry has passed", async () => {
    await using database = await sqlite.database();
    database.connection.close();
    using connection = openWithVec(database.path);
    const store = new SQLiteStore(connection, 3);
    let listed = 0;
    const config = {
      store,
      embedder: embedder({ greeting: [1, 0, 0], 'hello world': [1, 0, 0] }),
      connector: {
        sourceId: 'docs',
        ingestWhen: 'expired' as const,
        sources: async function* () {
          listed++;
          yield { id: 'readme', content: async () => 'hello world' };
        },
      },
    };

    await similaritySearch('greeting', config);
    store.setSourceExpiry('docs', new Date('2100-01-01T00:00:00.000Z'));
    await similaritySearch('greeting', config);
    const listedBeforeExpiry = listed;
    store.setSourceExpiry('docs', new Date('2000-01-01T00:00:00.000Z'));
    await similaritySearch('greeting', config);

    assert.equal(listedBeforeExpiry, 1);
    assert.equal(listed, 2);
  });

  it("ingests a source again in the 'expired' mode once its expiresAfter has passed, and not again until the new expiry", async (t) => {
    await using database = await sqlite.database();
    database.connection.close();
    using connection = openWithVec(database.path);
    const store = new SQLiteStore(connection, 3);
    let listed = 0;
    const config = {
      store,
      embedder: embedder({ greeting: [1, 0, 0], 'hello world': [1, 0, 0] }),
      connector: {
        sourceId: 'docs',
        ingestWhen: 'expired' as const,
        expiresAfter: 60 * 60 * 1000,
        sources: async function* () {
          listed++;
          yield { id: 'readme', content: async () => 'hello world' };
        },
      },
    };

    // The first ingest runs a day ago, so its hour-long expiry has passed.
    t.mock.timers.enable({
      apis: ['Date'],
      now: Date.now() - 24 * 60 * 60 * 1000,
    });
    try {
      await similaritySearch('greeting', config);
    } finally {
      t.mock.timers.reset();
    }
    await similaritySearch('greeting', config);
    const listedAfterExpiry = listed;
    await similaritySearch('greeting', config);

    assert.equal(listedAfterExpiry, 2);
    assert.equal(listed, 2);
  });

  it("does not ingest a source again in the 'expired' mode before its expiresAfter has passed", async () => {
    await using database = await sqlite.database();
    database.connection.close();
    using connection = openWithVec(database.path);
    const store = new SQLiteStore(connection, 3);
    let listed = 0;
    const config = {
      store,
      embedder: embedder({ greeting: [1, 0, 0], 'hello world': [1, 0, 0] }),
      connector: {
        sourceId: 'docs',
        ingestWhen: 'expired' as const,
        expiresAfter: 60 * 60 * 1000,
        sources: async function* () {
          listed++;
          yield { id: 'readme', content: async () => 'hello world' };
        },
      },
    };

    await similaritySearch('greeting', config);
    await similaritySearch('greeting', config);

    assert.equal(listed, 1);
  });
});
