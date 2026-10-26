// SQLite-based filesystem schema for artifact storage. SQLite stores the text
// of each CREATE and @zukhruf/sqlite-drift compares it, so the text after each
// object name must stay byte-identical to what earlier releases wrote.

// Performance PRAGMAs (session-level, run on each connection before the
// schema is applied).
export const SETUP = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA cache_size = -64000;
PRAGMA temp_store = MEMORY;
PRAGMA mmap_size = 268435456;
`;

export const statements = [
  // Filesystem entries table (files, directories, symlinks)
  `CREATE TABLE fs_entries (
  path TEXT PRIMARY KEY,            -- Normalized absolute path (e.g., '/results/uuid.json')
  type TEXT NOT NULL,               -- 'file' | 'directory' | 'symlink'
  mode INTEGER NOT NULL,            -- Unix permissions (e.g., 0o644 = 420)
  size INTEGER NOT NULL,            -- File size in bytes (0 for directories)
  mtime INTEGER NOT NULL,           -- Modified time (milliseconds since epoch)
  symlinkTarget TEXT                -- Target path for symlinks (NULL for files/dirs)
)`,
  `CREATE INDEX idx_fs_entries_type ON fs_entries(type)`,
  // File content chunks table (for handling large files)
  // Files are split into 1MB chunks to avoid SQLite BLOB performance issues
  `CREATE TABLE fs_chunks (
  path TEXT NOT NULL,               -- Reference to fs_entries.path
  chunkIndex INTEGER NOT NULL,      -- 0-based chunk sequence
  data BLOB NOT NULL,               -- Chunk content (up to 1MB default)
  PRIMARY KEY (path, chunkIndex),
  FOREIGN KEY (path) REFERENCES fs_entries(path) ON DELETE CASCADE ON UPDATE CASCADE
)`,
];
