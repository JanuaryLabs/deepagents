# Embed System Database & Architecture

Technical implementation guide for the vector database and embedding pipeline powering the RAG system.

## Architecture Overview

The embed system uses a three-layer architecture:

```
┌─────────────────────────────────────────────────────────────────┐
│                        RAG Layer (rag.ts)                      │
│  • Entry point for developers                                  │
│  • Orchestrates ingest → search → generate workflow            │
└─────────────────────────────────────────────────────────────────┘
                                   │
┌─────────────────────────────────────────────────────────────────┐
│                   Pipeline Layer (pipeline.ts)                 │
│  • Content ingestion with change detection                     │
│  • Text chunking and embedding generation                      │
│  • Semantic search with similarity scoring                     │
└─────────────────────────────────────────────────────────────────┘
                                   │
┌─────────────────────────────────────────────────────────────────┐
│                  Storage Layer (store.ts + SQLite)             │
│  • Vector database with SQLite-vec                             │
│  • Content hashing for change detection                        │
│  • Transaction management and data integrity                   │
└─────────────────────────────────────────────────────────────────┘
```

## Database Implementation

### Core Technology Stack

- **Database**: SQLite with `sqlite-vec` extension
- **Vector Dimensions**: 1024 (Qwen embeddings)
- **Distance Metric**: Cosine similarity
- **Performance**: WAL mode with memory temp storage

### Database Schema

The system uses a three-table design for optimal performance and data integrity:

#### Sources Table
```sql
CREATE TABLE sources (
  source_id TEXT PRIMARY KEY,           -- e.g., 'github', 'rss', 'local'
  updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
```

#### Documents Table  
```sql
CREATE TABLE documents (
  id TEXT PRIMARY KEY,                  -- Document identifier (e.g., file path)
  source_id TEXT,                       -- References sources.source_id
  cid TEXT,                            -- SHA-256 content hash for change detection
  updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY(source_id) REFERENCES sources(source_id)
);
```

#### Vector Chunks Table
```sql
CREATE VIRTUAL TABLE vec_chunks USING vec0(
  source_id TEXT,                       -- Partition key for performance
  document_id TEXT,                     -- Document this chunk belongs to
  embedding FLOAT[1024] DISTANCE_METRIC=cosine,  -- 1024-dimensional vector
  content TEXT                          -- The actual text content
);
```

### Database Configuration

Performance-optimized SQLite settings:

```typescript
import { DatabaseSync } from 'node:sqlite';
import * as sqliteVec from 'sqlite-vec';

const db = new DatabaseSync('embed.sqlite', { allowExtension: true });
sqliteVec.load(db);

// Performance optimizations applied automatically:
// PRAGMA journal_mode = WAL;     -- Write-Ahead Logging
// PRAGMA synchronous = NORMAL;   -- Balanced safety/performance  
// PRAGMA temp_store = MEMORY;    -- Memory temp storage
```

## Content Processing Pipeline

### 1. Ingestion Pipeline

```typescript
export async function ingest(
  sourceId: string,      // Data source identifier
  documentId: string,    // Document identifier  
  cid: string,          // Content hash (SHA-256)
  getDocument: () => Content | Promise<Content>
) {
  return store.upsertIfChanged(sourceId, documentId, cid, async () => {
    const document = await getDocument();
    const chunks = await split(document.content);      // Text chunking
    const { embeddings } = await embed(chunks);       // Vector generation
    return chunks.map((content, idx) => ({
      content,
      embedding: embeddings[idx]
    }));
  });
}
```

**Key Features:**
- **Change Detection**: Only processes content when SHA-256 hash changes
- **Transactional**: All operations wrapped in database transactions
- **Batch Processing**: Multiple chunks embedded in single API call

### 2. Text Chunking

```typescript
async function split(content: string): Promise<string[]> {
  const splitter = new MarkdownTextSplitter();
  return splitter.splitText(content);
}
```

Uses LangChain's MarkdownTextSplitter for intelligent content segmentation that respects document structure.

### 3. Embedding Generation  

```typescript
async function embed(documents: string[]) {
  const dimensions = 1024;
  const { embeddings } = await embedMany({
    model: lmstudio.textEmbeddingModel('text-embedding-qwen3-embedding-0.6b'),
    values: documents,
    providerOptions: { lmstudio: { dimensions } }
  });
  return { embeddings, dimensions };
}
```

**Model Details:**
- **Model**: `text-embedding-qwen3-embedding-0.6b`
- **Provider**: LM Studio (local inference)
- **Dimensions**: 1024
- **Normalization**: Automatic vector normalization for cosine similarity

## Search Implementation

### Similarity Search

```typescript
export async function similaritySearch(
  query: string,
  { sourceId, documentId, topN = 10 }: SearchOptions
) {
  const { embeddings } = await embed([query]);
  const qVec = JSON.stringify(embeddings[0]);

  // Search within specific document
  if (documentId) {
    const stmt = db.prepare(`
      SELECT v.content, v.distance
      FROM vec_chunks v
      WHERE v.source_id = ?
        AND v.document_id = ?
        AND v.embedding MATCH vec_normalize(vec_f32(?))
        AND v.k = ?
      ORDER BY v.distance ASC
    `);
    return stmt.all(sourceId, documentId, qVec, topN);
  }

  // Search across all documents in source
  const stmt = db.prepare(`
    SELECT v.content, v.distance, v.document_id
    FROM vec_chunks v
    WHERE v.source_id = ?
      AND v.embedding MATCH vec_normalize(vec_f32(?))
      AND v.k = ?
    ORDER BY v.distance ASC
  `);
  return stmt.all(sourceId, qVec, topN);
}
```

**Search Features:**
- **Partitioned Search**: Search by source for performance
- **Document-Specific**: Optionally limit to specific documents
- **Top-K Results**: Configurable result count (default: 10)
- **Similarity Scoring**: Cosine distance returned for each result

## Vector Store Management

### Core Store Interface

```typescript
export async function vectorStore(dimension: number) {
  // Initialize database schema with template
  const compiled = template(
    readFileSync(new URL('./embed.sql', import.meta.url), 'utf8')
  );
  db.exec(compiled({ DIMENSION: dimension }));
  
  return {
    upsertIfChanged: async (
      sourceId: string,
      documentId: string, 
      cid: string,
      getChunks: Embedder
    ) => {
      // Implementation handles change detection and upsert logic
    }
  };
}
```

### Change Detection Algorithm

The system uses content hashing to avoid unnecessary reprocessing:

```typescript
// 1. Calculate content hash
const contentHash = createHash('sha256').update(content).digest('hex');

// 2. Check if content changed
const upsertDoc = db.prepare(`
  INSERT INTO documents (id, source_id, cid)
  VALUES (?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    cid=excluded.cid,
    updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
  WHERE documents.cid != excluded.cid;
`);
const info = upsertDoc.run(documentId, sourceId, contentHash);
const changed = info.changes > 0;

// 3. Only process if changed
if (!changed) {
  console.log(`No changes detected for document ${documentId}`);
  return;
}
```

### Transaction Management

All multi-step operations are wrapped in database transactions:

```typescript
function transaction(callback: () => void) {
  try {
    db.exec('BEGIN');
    callback();
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

// Usage in upsert operations
transaction(() => {
  deleteStmt.run(sourceId, documentId);  // Remove old chunks
  for (const chunk of chunks) {
    insert(chunk);                       // Insert new chunks
  }
});
```

## Performance Optimizations

### Database Level

1. **WAL Mode**: Enables concurrent reads during writes
2. **Memory Temp Storage**: Faster temporary operations  
3. **Vector Normalization**: Pre-normalized vectors for faster similarity
4. **Partitioned Tables**: Source-based partitioning for query performance

### Application Level

1. **Batch Embeddings**: Multiple texts embedded in single API call
2. **Smart Caching**: SHA-256 hashing prevents redundant work
3. **Prepared Statements**: Reused SQL statements for better performance
4. **Connection Reuse**: Single database connection across operations

## Monitoring and Debugging

### Content Hash Utility

```typescript
export function cid(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}
```

Use this to manually check content hashes and debug change detection.

### Database Inspection

```sql
-- Check source status
SELECT source_id, updated_at FROM sources;

-- View document versions  
SELECT id, source_id, cid, updated_at FROM documents;

-- Count chunks per document
SELECT document_id, COUNT(*) as chunk_count 
FROM vec_chunks 
GROUP BY document_id;

-- Test vector search manually
SELECT content, distance 
FROM vec_chunks 
WHERE source_id = 'your_source'
  AND embedding MATCH vec_normalize(vec_f32('[...]'))
  AND k = 5;
```

## File Structure

```
apps/api/src/swarm/embed/
├── store.ts              # Vector store implementation
│   ├── vectorStore()     # Main store factory
│   ├── cid()            # Content hashing utility  
│   └── transaction()    # Transaction wrapper
├── pipeline.ts          # Processing pipeline
│   ├── ingest()         # Content ingestion
│   ├── split()          # Text chunking  
│   ├── embed()          # Vector generation
│   └── similaritySearch() # Semantic search
├── embed.sql           # Database schema template
└── connectors/         # Data source connectors
    ├── connector.ts    # Interface definition
    ├── github.ts      # GitHub API connector
    ├── rss.ts         # RSS feed connector
    ├── local.ts       # Local file connector
    └── linear.ts      # Linear API connector
```

## Dependencies

```json
{
  "node:sqlite": "Built-in SQLite database",
  "sqlite-vec": "Vector extension for SQLite", 
  "ai": "AI SDK for embeddings",
  "langchain": "Text splitting utilities",
  "lodash-es": "Template compilation"
}
```

## Development Setup

1. **Install sqlite-vec**: Ensure the extension is available
2. **Configure LM Studio**: Load the Qwen embedding model
3. **Database Location**: `embed.sqlite` created in project root
4. **Schema Management**: Auto-created on first vectorStore() call

The database layer is designed for reliability, performance, and easy debugging. All operations are transactional and include comprehensive change detection to minimize unnecessary work.