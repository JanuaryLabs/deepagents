import { Declaration } from '@zukhruf/sqlite-drift';
import { transaction } from '@zukhruf/sqlite-transaction';
import dedent from 'dedent';
import type { DatabaseSync } from 'node:sqlite';

import type {
  Chunk,
  Corpus,
  Embedder,
  SearchOptions,
  SearchResult,
  Store,
} from '../store.ts';
import { SETUP, statements, vectors } from './ddl.sqlite.ts';
import { open } from './open.ts';

const DEFAULT_TOP_N = 10;

const tables = new Declaration(statements, { rows: 'keep' });

export class SQLiteStore implements Store {
  readonly #db: DatabaseSync;
  constructor(db: DatabaseSync, dimension: number) {
    this.#db = db;
    this.#db.exec(SETUP);
    const chunks = new Declaration([vectors(dimension)], {
      rows: 'replace',
      devDatabase: () => open(':memory:'),
    });
    transaction(
      this.#db,
      () => {
        const stale = chunks.drift(this.#db) === 'stale';
        chunks.apply(this.#db);
        // A replaced vec_chunks is empty, yet upsertDoc skips a document whose
        // cid is unchanged and similaritySearch skips a source that exists.
        // Deleting the sources cascades to their documents, so the next
        // ingest embeds every document again.
        if (stale) this.#db.exec('DELETE FROM sources');
      },
      { mode: 'immediate' },
    );
    tables.apply(this.#db);
  }

  #searchByDocument(inputs: {
    sourceId: string;
    documentId: string;
    embedding: Buffer<ArrayBufferLike>;
    k: number;
  }) {
    const stmt = this.#db.prepare(dedent`
				SELECT v.content, v.distance, v.document_id, d.metadata
				FROM vec_chunks v
				JOIN documents d ON d.id = v.document_id
				WHERE v.source_id = ?
					AND v.document_id = ?
					AND v.embedding MATCH vec_normalize(vec_f32(?))
					AND v.k = ?
				ORDER BY v.distance ASC
			`);
    return stmt.all(
      inputs.sourceId,
      inputs.documentId,
      inputs.embedding,
      inputs.k,
    );
  }
  #searchBySource(inputs: {
    sourceId: string;
    embedding: Buffer<ArrayBufferLike>;
    k: number;
  }) {
    const stmt = this.#db.prepare(dedent`
				SELECT v.content, v.distance, v.document_id, d.metadata
				FROM vec_chunks v
				JOIN documents d ON d.id = v.document_id
				WHERE v.source_id = ?
					AND v.embedding MATCH vec_normalize(vec_f32(?))
					AND v.k = ?
				ORDER BY v.distance ASC
			`);
    return stmt.all(inputs.sourceId, inputs.embedding, inputs.k);
  }
  async search(query: string, options: SearchOptions, embedder: Embedder) {
    const { embeddings } = await embedder([query]);
    if (!embeddings.length) {
      return [];
    }
    const vectorBlob = vectorToBlob(embeddings[0]);
    const topN = options.topN;

    if (options.documentId) {
      const rows = this.#searchByDocument({
        sourceId: options.sourceId,
        documentId: options.documentId,
        embedding: vectorBlob,
        k: topN ?? DEFAULT_TOP_N,
      });
      return rows.map(toSearchResult);
    }

    const rows = this.#searchBySource({
      sourceId: options.sourceId,
      embedding: vectorBlob,
      k: topN ?? DEFAULT_TOP_N,
    });
    return rows.map(toSearchResult);
  }
  #upsertSource(inputs: { sourceId: string }) {
    const stmt = this.#db.prepare(dedent`
				INSERT INTO sources (source_id) VALUES (?)
				ON CONFLICT(source_id) DO UPDATE SET updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
			`);
    return stmt.run(inputs.sourceId);
  }
  #upsertSourceWithExpiry(inputs: { sourceId: string; expiresAt: string }) {
    const stmt = this.#db.prepare(dedent`
				INSERT INTO sources (source_id, expires_at) VALUES (?, ?)
				ON CONFLICT(source_id) DO UPDATE SET
					updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
					expires_at=excluded.expires_at
			`);
    return stmt.run(inputs.sourceId, inputs.expiresAt);
  }
  upsertDoc(inputs: {
    documentId: string;
    sourceId: string;
    cid: string;
    metadata?: Record<string, any>;
  }) {
    const stmt = this.#db.prepare(dedent`
        INSERT INTO documents (id, source_id, cid, metadata)
        VALUES (?, ?, ?, json(?))
        ON CONFLICT(id) DO UPDATE SET
          cid=excluded.cid,
          metadata=COALESCE(excluded.metadata, documents.metadata),
          updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE documents.cid != excluded.cid;
      `);
    return stmt.run(
      inputs.documentId,
      inputs.sourceId,
      inputs.cid,
      inputs.metadata ? JSON.stringify(inputs.metadata) : null,
    );
  }
  insertDoc(inputs: { sourceId: string; documentId: string }) {
    const stmt = this.#db.prepare(dedent`
				INSERT INTO vec_chunks (source_id, document_id, content, embedding)
				VALUES (?, ?, ?, vec_normalize(vec_f32(?)))
			`);
    return (chunk: Chunk) => {
      stmt.run(
        inputs.sourceId,
        inputs.documentId,
        chunk.content,
        vectorToBlob(chunk.embedding),
      );
    };
  }
  delete(inputs: { sourceId: string; documentId: string }) {
    const stmt = this.#db.prepare(dedent`
				DELETE FROM vec_chunks WHERE source_id = ? AND document_id = ?
			`);
    return stmt.run(inputs.sourceId, inputs.documentId);
  }
  sourceExists(sourceId: string) {
    const stmt = this.#db.prepare(dedent`
				SELECT 1 FROM sources WHERE source_id = ? LIMIT 1
			`);
    const row = stmt.get(sourceId);
    return Boolean(row);
  }
  sourceExpired(sourceId: string) {
    const stmt = this.#db.prepare(dedent`
				SELECT 1 FROM sources
				WHERE source_id = ?
					AND expires_at IS NOT NULL
					AND expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now')
				LIMIT 1
			`);
    const row = stmt.get(sourceId);
    return Boolean(row);
  }
  setSourceExpiry(sourceId: string, expiryDate: Date) {
    const stmt = this.#db.prepare(dedent`
				UPDATE sources
				SET expires_at = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
				WHERE source_id = ?
			`);
    stmt.run(expiryDate.toISOString(), sourceId);
  }
  async index(sourceId: string, corpus: Corpus, expiryDate?: Date) {
    if (expiryDate) {
      this.#upsertSourceWithExpiry({
        expiresAt: expiryDate.toISOString(),
        sourceId,
      });
    } else {
      this.#upsertSource({ sourceId });
    }

    const info = this.upsertDoc({
      documentId: corpus.id,
      sourceId,
      cid: corpus.cid,
      metadata: corpus.metadata,
    });
    const changed = info.changes > 0;

    if (!changed) {
      return;
    }

    const insert = this.insertDoc({ sourceId, documentId: corpus.id });
    // Delete previous rows once before inserting
    transaction(
      this.#db,
      () => {
        this.delete({ sourceId, documentId: corpus.id });
      },
      { mode: 'immediate' },
    );

    const batchSize = 32;
    let batch: Chunk[] = [];
    const flush = () => {
      if (!batch.length) return;
      transaction(
        this.#db,
        () => {
          for (let i = 0; i < batch.length; i++) {
            insert(batch[i]);
          }
        },
        { mode: 'immediate' },
      );
      batch = [];
    };

    for await (const chunk of corpus.chunker()) {
      batch.push(chunk);
      if (batch.length >= batchSize) flush();
    }
    // flush any remaining
    flush();
  }
}

export function vectorToBlob(vector: number[] | Float32Array): Buffer {
  if (vector instanceof Float32Array) {
    // Copy into a fresh Buffer to avoid retaining references to a larger batch tensor buffer
    const copied = new Float32Array(vector.length);
    copied.set(vector);
    return Buffer.from(copied.buffer);
  }
  const floatArray = new Float32Array(vector);
  return Buffer.from(floatArray.buffer);
}

function toSearchResult(row: unknown): SearchResult {
  if (
    typeof row !== 'object' ||
    row === null ||
    !('content' in row) ||
    typeof row.content !== 'string' ||
    !('distance' in row) ||
    typeof row.distance !== 'number' ||
    !('document_id' in row) ||
    typeof row.document_id !== 'string' ||
    !('metadata' in row) ||
    (row.metadata !== null && typeof row.metadata !== 'string')
  ) {
    throw new Error('Unexpected vector search row');
  }
  return {
    content: row.content,
    distance: row.distance,
    document_id: row.document_id,
    metadata: parseMetadata(row.metadata),
  };
}

function parseMetadata(value: string | null): Record<string, unknown> | null {
  if (value === null) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
