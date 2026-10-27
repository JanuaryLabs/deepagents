# Retrieval database and architecture

Implementation guide for `@deepagents/retrieval` ingestion and SQLite vector storage.

## Architecture overview

Connectors supply document IDs, content, and metadata. `ingest()` splits and embeds changed documents. `similaritySearch()` decides whether to ingest, then queries the configured store. Applications pass the results to their own answer-generation flow.

The public entry point is [`src/index.ts`](../index.ts). The [store guide](../../../../apps/docs/app/docs/retrieval/stores.mdx) covers the public API and schema.

## Database implementation

### Core technology stack

- **Database:** the built-in `node:sqlite` module with the `sqlite-vec` extension.
- **Vector dimensions:** configured per store to match its embedder.
- **Distance metric:** cosine distance; lower values mean closer matches.
- **Schema management:** `@zukhruf/sqlite-drift` applies declarations on each open.

### Database schema

[`stores/sqlite/ddl.sqlite.ts`](./stores/sqlite/ddl.sqlite.ts) defines the tables, indexes, delete trigger, and connection PRAGMAs.

#### Sources table

`sources` records `source_id`, `updated_at`, and optional `expires_at`. Ingestion refreshes the expiry from the connector's `expiresAfter` duration in milliseconds when it indexes a nonempty document.

#### Documents table

`documents` records the document ID, source ID, SHA-256 content hash (`cid`), JSON metadata, and update time. Deleting a source cascades to its documents; a trigger removes their vector chunks.

#### Vector chunks table

`vec_chunks` is a `vec0` virtual table partitioned by source. It stores document IDs, vectors of the configured dimension, and chunk content as an auxiliary field.

A new dimension makes the store replace this table with an empty table. In the same transaction, the store deletes all sources and their documents. The next ingest reads the connector content and embeds the documents again. To keep the indexes of two dimensions, use one file for each dimension.

### Database configuration

```typescript
import { nodeSQLite } from '@deepagents/retrieval';

const store = nodeSQLite('./knowledge.db', 384);
```

`nodeSQLite()` opens a `DatabaseSync` connection, loads `sqlite-vec`, and constructs `SQLiteStore`. The constructor applies the connection PRAGMAs and schema. A stale table keeps its rows. A replaced `vec_chunks` has no rows, as described above.

## Content processing pipeline

### 1. Ingestion pipeline

```typescript
import { fastembed, ingest, nodeSQLite } from '@deepagents/retrieval';
import { local } from '@deepagents/retrieval/connectors';

const store = nodeSQLite('./knowledge.db', 384);
const embedder = fastembed();
const connector = local('docs/**/*.md');

await ingest({ connector, store, embedder });
```

[`ingest.ts`](./ingest.ts) reads each document, skips empty content, computes its hash, and passes a chunk generator and optional expiry date to `store.index()`. A direct call to `ingest()` always reads every document of the connector. `similaritySearch()` applies the `ingestWhen` policy first.

### 2. Text chunking

The default splitter uses LangChain's `MarkdownTextSplitter`. Pass `splitter(id, content)` to `ingest()` to supply a custom splitter. The ingestion pipeline sends chunks to the embedder in batches of up to 40.

### 3. Embedding generation

An `Embedder` accepts an array of strings and returns `{ embeddings, dimensions }`. `fastembed()` uses Transformers.js for local feature extraction. Callers can supply any implementation of the same interface. The store normalizes vectors with `vec_normalize()` for indexing and search.

## Search implementation

### Similarity search

```typescript
import { fastembed, nodeSQLite, similaritySearch } from '@deepagents/retrieval';
import { local } from '@deepagents/retrieval/connectors';

const results = await similaritySearch('authentication', {
  connector: local('docs/**/*.md'),
  store: nodeSQLite('./knowledge.db', 384),
  embedder: fastembed(),
});
```

[`similiarty-search.ts`](./similiarty-search.ts) applies the connector's ingestion policy, searches its `sourceId`, and requests up to 50 results. It adds `similarity: 1 - distance` to each result.

For direct searches, `store.search(query, options, embedder)` accepts `sourceId`, optional `documentId`, and optional `topN` (default 10). It returns content, distance, document ID, and metadata. Metadata is `null` when absent.

## Vector store management

### Core store interface

[`stores/store.ts`](./stores/store.ts) defines `Store`, `SearchOptions`, `SearchResult`, `Corpus`, and `Embedder`. The public store methods are `search()`, `index()`, `sourceExists()`, `sourceExpired()`, and `setSourceExpiry()`.

`SQLiteStore` takes a `node:sqlite` `DatabaseSync` connection and a vector dimension. If you construct it directly, load `sqlite-vec` on that connection first. `nodeSQLite()` handles this setup.

### Change detection algorithm

`index()` upserts the source and its expiry before comparing the document's hash. An unchanged hash skips chunk generation and embedding. It still refreshes a supplied expiry. A changed hash updates document metadata, removes the old chunks, and inserts new chunks.

With `ingestWhen: 'expired'`, `similaritySearch()` ingests missing or expired sources and skips existing sources whose expiry has not passed. A source without an expiry time is not expired.

### Transaction management

[`stores/sqlite/sqlite.ts`](./stores/sqlite/sqlite.ts) uses `@zukhruf/sqlite-transaction` with `mode: 'immediate'`. One transaction deletes the old chunks. Each batch of up to 32 new chunks has its own transaction. Source and document upserts happen before those transactions.

A full ingestion is not atomic. If embedding or a later batch fails, earlier metadata changes and committed chunk batches remain. Do not treat a failed ingestion as a rollback of the whole document or source.

## Performance optimizations

### Database level

The connection setup enables WAL mode, in-memory temporary storage, and a five-second busy timeout. Source partitions limit vector searches, and indexes support document lookup and source expiry checks. See `SETUP` and `statements` in the schema module for the exact settings.

### Application level

Content hashes skip unchanged document embeddings. Embedding requests and SQLite insertions use separate batch sizes: up to 40 texts per embedder call and 32 chunks per insertion transaction. A store reuses its database connection across operations.

## Monitoring and debugging

### Content hash utility

```typescript
import { cid } from '@deepagents/retrieval';

console.log(cid('Hello, world!')); // SHA-256 hash
```

### Database inspection

```sql
-- Check source expiry
SELECT source_id, updated_at, expires_at FROM sources;

-- View document versions and metadata
SELECT id, source_id, cid, metadata, updated_at FROM documents;

-- Count chunks per document
SELECT document_id, COUNT(*) AS chunk_count
FROM vec_chunks
GROUP BY document_id;
```

Vector queries require a connection with `sqlite-vec` loaded. Use `store.search()` to normalize the query vector and apply source and document filters.

## File structure

- [`ingest.ts`](./ingest.ts): document loading, splitting, and embedding.
- [`similiarty-search.ts`](./similiarty-search.ts): ingestion policy and result scoring.
- [`connectors/connector.ts`](./connectors/connector.ts): source and expiry contract.
- [`embedders/fastembed.ts`](./embedders/fastembed.ts): local embedder.
- [`stores/store.ts`](./stores/store.ts): store and embedding interfaces.
- [`stores/sqlite/node-sqlite.ts`](./stores/sqlite/node-sqlite.ts): public store factory.
- [`stores/sqlite/open.ts`](./stores/sqlite/open.ts): connection and extension loading.
- [`stores/sqlite/ddl.sqlite.ts`](./stores/sqlite/ddl.sqlite.ts): schema declarations.
- [`stores/sqlite/sqlite.ts`](./stores/sqlite/sqlite.ts): indexing and search.

## Dependencies

The store uses `node:sqlite`, `sqlite-vec`, `@zukhruf/sqlite-drift`, and `@zukhruf/sqlite-transaction`. The default splitter uses `@langchain/textsplitters`. The local embedder uses `@huggingface/transformers`. See the [package manifest](../../package.json) for dependency ranges.

## Development setup

1. Choose an embedder and match the store's dimension to its output.
2. Open a database file with `nodeSQLite()`; a relative path resolves from the process's working directory.
3. Supply a connector, then call `ingest()` or `similaritySearch()`.
4. To keep the existing index, use a separate file for another vector dimension.
