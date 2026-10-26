import { Sqlite } from '@zukhruf/testing/sqlite';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import * as sqliteVec from 'sqlite-vec';

import { SQLiteStore } from '@deepagents/retrieval';

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
});
