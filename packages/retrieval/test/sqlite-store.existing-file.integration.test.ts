import { Sqlite } from '@zukhruf/testing/sqlite';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import * as sqliteVec from 'sqlite-vec';

import { SQLiteStore, cid, similaritySearch } from '@deepagents/retrieval';

const sqlite = new Sqlite();

// The schema of @deepagents/retrieval 7.1.4 (sqlite.sql.ts) with its
// <%= DIMENSION %> filled with 3, frozen here because it is what every
// existing vector store file was made with.
const PREVIOUS_RELEASE_DDL = `-- Embedding store schema
-- Use <%= DIMENSION %> placeholder replaced at runtime.

PRAGMA busy_timeout = 5000;
PRAGMA page_size = 32768;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA temp_store = MEMORY;
PRAGMA foreign_keys = ON;
PRAGMA cache_size = -131072; -- ~128 MiB page cache for faster repeated reads
PRAGMA mmap_size = 268435456; -- 256 MiB memory map window to cut syscalls
PRAGMA wal_autocheckpoint = 1000;
PRAGMA optimize;

CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(
  source_id TEXT PARTITION KEY,
  document_id TEXT,
  embedding FLOAT[3] DISTANCE_METRIC=cosine,
  +content TEXT -- auxiliary payload (not filterable) for reconstruction
);

CREATE TABLE IF NOT EXISTS sources (
  source_id TEXT PRIMARY KEY,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  cid TEXT NOT NULL,
  metadata TEXT, -- JSON blob with arbitrary document metadata
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (source_id) REFERENCES sources(source_id) ON DELETE CASCADE
) STRICT;

-- Indexes to accelerate lookups / maintenance
CREATE INDEX IF NOT EXISTS idx_documents_source ON documents(source_id);
CREATE INDEX IF NOT EXISTS idx_documents_source_updated ON documents(source_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_documents_cid ON documents(cid);
CREATE INDEX IF NOT EXISTS idx_sources_expires_at ON sources(expires_at) WHERE expires_at IS NOT NULL;

-- emulate cascade for the virtual table
CREATE TRIGGER IF NOT EXISTS trg_documents_delete_vec
AFTER DELETE ON documents
BEGIN
  DELETE FROM vec_chunks
  WHERE source_id = OLD.source_id
    AND document_id = OLD.id;
END;
`;

const CONTENT = 'hello world';

// Writes one indexed document with the INSERTs the store runs in index().
function insertIndexedDocument(database: DatabaseSync) {
  database.prepare('INSERT INTO sources (source_id) VALUES (?)').run('docs');
  database
    .prepare(
      'INSERT INTO documents (id, source_id, cid, metadata) VALUES (?, ?, ?, json(?))',
    )
    .run('readme', 'docs', cid(CONTENT), null);
  database
    .prepare(
      'INSERT INTO vec_chunks (source_id, document_id, content, embedding) VALUES (?, ?, ?, vec_normalize(vec_f32(?)))',
    )
    .run(
      'docs',
      'readme',
      CONTENT,
      Buffer.from(new Float32Array([1, 0, 0]).buffer),
    );
}

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

describe('SQLiteStore on an existing file', () => {
  it('finds the documents of a file the previous release wrote, before any ingest', async () => {
    await using database = await sqlite.database();
    database.connection.close();
    const previous = openWithVec(database.path);
    previous.exec(PREVIOUS_RELEASE_DDL);
    insertIndexedDocument(previous);
    previous.close();

    using connection = openWithVec(database.path);
    const store = new SQLiteStore(connection, 3);
    const results = await store.search(
      'greeting',
      { sourceId: 'docs' },
      embedder({ greeting: [1, 0, 0] }),
    );

    assert.deepEqual(
      results.map(({ content, document_id }) => ({ content, document_id })),
      [{ content: CONTENT, document_id: 'readme' }],
    );
  });

  it('embeds the documents again after the embedding size changes', async () => {
    await using database = await sqlite.database();
    database.connection.close();
    const previous = openWithVec(database.path);
    previous.exec(PREVIOUS_RELEASE_DDL);
    insertIndexedDocument(previous);
    previous.close();

    using connection = openWithVec(database.path);
    const store = new SQLiteStore(connection, 4);
    const sourceKeptWithoutVectors = store.sourceExists('docs');
    const results = await similaritySearch('greeting', {
      store,
      embedder: embedder({
        greeting: [1, 0, 0, 0],
        [CONTENT]: [1, 0, 0, 0],
      }),
      connector: {
        sourceId: 'docs',
        sources: async function* () {
          yield { id: 'readme', content: async () => CONTENT };
        },
      },
    });

    assert.equal(sourceKeptWithoutVectors, false);
    assert.deepEqual(
      results.map(({ content, document_id }) => ({ content, document_id })),
      [{ content: CONTENT, document_id: 'readme' }],
    );
  });

  it('adds a column a table lacks and keeps its rows', async () => {
    await using database = await sqlite.database();
    database.connection.close();
    const previous = openWithVec(database.path);
    // No release made a sources table without expires_at. The short table is
    // the previous release's schema with that column and its index taken out,
    // to see the store bring a table up to its declaration.
    previous.exec(
      PREVIOUS_RELEASE_DDL.replace(
        `  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at TEXT
) STRICT;`,
        `  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;`,
      ).replace(
        'CREATE INDEX IF NOT EXISTS idx_sources_expires_at ON sources(expires_at) WHERE expires_at IS NOT NULL;',
        '',
      ),
    );
    insertIndexedDocument(previous);
    previous.close();

    using connection = openWithVec(database.path);
    const store = new SQLiteStore(connection, 3);
    const sourceKept = store.sourceExists('docs');
    store.setSourceExpiry('docs', new Date('2030-01-01T00:00:00.000Z'));
    const results = await store.search(
      'greeting',
      { sourceId: 'docs' },
      embedder({ greeting: [1, 0, 0] }),
    );

    assert.equal(sourceKept, true);
    assert.deepEqual(
      results.map(({ content, document_id }) => ({ content, document_id })),
      [{ content: CONTENT, document_id: 'readme' }],
    );
  });
});
