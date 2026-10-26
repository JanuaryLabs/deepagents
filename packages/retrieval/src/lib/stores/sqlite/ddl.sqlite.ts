// Embedding store schema for SQLite. SQLite stores the text of each CREATE and
// @zukhruf/sqlite-drift compares it, so the text after each object name must
// stay byte-identical to what earlier releases wrote, inline comments included.

// Session-level PRAGMAs, run on each connection before the schema is applied.
export const SETUP = `
PRAGMA busy_timeout = 5000;
PRAGMA page_size = 32768;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA temp_store = MEMORY;
PRAGMA cache_size = -131072; -- ~128 MiB page cache for faster repeated reads
PRAGMA mmap_size = 268435456; -- 256 MiB memory map window to cut syscalls
PRAGMA wal_autocheckpoint = 1000;
PRAGMA optimize;
`;

export function vectors(dimension: number) {
  return `CREATE VIRTUAL TABLE vec_chunks USING vec0(
  source_id TEXT PARTITION KEY,
  document_id TEXT,
  embedding FLOAT[${dimension}] DISTANCE_METRIC=cosine,
  +content TEXT -- auxiliary payload (not filterable) for reconstruction
)`;
}

export const statements = [
  `CREATE TABLE sources (
  source_id TEXT PRIMARY KEY,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at TEXT
) STRICT`,
  `CREATE TABLE documents (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  cid TEXT NOT NULL,
  metadata TEXT, -- JSON blob with arbitrary document metadata
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (source_id) REFERENCES sources(source_id) ON DELETE CASCADE
) STRICT`,
  // Indexes to accelerate lookups / maintenance
  `CREATE INDEX idx_documents_source ON documents(source_id)`,
  `CREATE INDEX idx_documents_source_updated ON documents(source_id, updated_at)`,
  `CREATE INDEX idx_documents_cid ON documents(cid)`,
  `CREATE INDEX idx_sources_expires_at ON sources(expires_at) WHERE expires_at IS NOT NULL`,
  // emulate cascade for the virtual table
  `CREATE TRIGGER trg_documents_delete_vec
AFTER DELETE ON documents
BEGIN
  DELETE FROM vec_chunks
  WHERE source_id = OLD.source_id
    AND document_id = OLD.id;
END`,
];
