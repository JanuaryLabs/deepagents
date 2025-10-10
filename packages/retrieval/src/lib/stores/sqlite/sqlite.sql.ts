export default `-- Embedding store schema
-- Use <%= DIMENSION %> placeholder replaced at runtime.

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
  embedding FLOAT[<%= DIMENSION %>] DISTANCE_METRIC=cosine,
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
`