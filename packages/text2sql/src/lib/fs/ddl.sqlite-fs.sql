-- SQLite-based filesystem schema for artifact storage
-- Tables: fs_entries (file/directory metadata), fs_chunks (file content)

-- Performance PRAGMAs (session-level, run on each connection)
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA cache_size = -64000;
PRAGMA temp_store = MEMORY;
PRAGMA mmap_size = 268435456;

-- Integrity
PRAGMA foreign_keys = ON;

-- Filesystem entries table (files, directories, symlinks)
CREATE TABLE IF NOT EXISTS fs_entries (
  path TEXT PRIMARY KEY,            -- Normalized absolute path (e.g., '/results/uuid.json')
  type TEXT NOT NULL,               -- 'file' | 'directory' | 'symlink'
  mode INTEGER NOT NULL,            -- Unix permissions (e.g., 0o644 = 420)
  size INTEGER NOT NULL,            -- File size in bytes (0 for directories)
  mtime INTEGER NOT NULL,           -- Modified time (milliseconds since epoch)
  symlinkTarget TEXT                -- Target path for symlinks (NULL for files/dirs)
);

CREATE INDEX IF NOT EXISTS idx_fs_entries_type ON fs_entries(type);

-- File content chunks table (for handling large files)
-- Files are split into 1MB chunks to avoid SQLite BLOB performance issues
CREATE TABLE IF NOT EXISTS fs_chunks (
  path TEXT NOT NULL,               -- Reference to fs_entries.path
  chunkIndex INTEGER NOT NULL,      -- 0-based chunk sequence
  data BLOB NOT NULL,               -- Chunk content (up to 1MB default)
  PRIMARY KEY (path, chunkIndex),
  FOREIGN KEY (path) REFERENCES fs_entries(path) ON DELETE CASCADE ON UPDATE CASCADE
);
