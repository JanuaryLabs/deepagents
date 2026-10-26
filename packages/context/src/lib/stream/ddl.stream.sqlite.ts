// Stream store schema for SQLite. SQLite stores the text of each CREATE and
// @zukhruf/sqlite-drift compares it, so the text after each object name must
// stay byte-identical to what earlier releases wrote.

// Session-level PRAGMAs, run on each connection before the schema is applied.
export const SETUP = `
PRAGMA busy_timeout = 5000;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
`;

export const statements = [
  `CREATE TABLE streams (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK(status IN ('queued','running','completed','failed','cancelled')),
  createdAt INTEGER NOT NULL,
  startedAt INTEGER,
  finishedAt INTEGER,
  cancelRequestedAt INTEGER,
  error TEXT
)`,
  `CREATE TABLE stream_chunks (
  streamId TEXT NOT NULL,
  seq INTEGER NOT NULL,
  data TEXT NOT NULL,
  createdAt INTEGER NOT NULL,
  PRIMARY KEY (streamId, seq),
  FOREIGN KEY (streamId) REFERENCES streams(id) ON DELETE CASCADE
)`,
  // Supports ordered listing across all streams.
  `CREATE INDEX idx_streams_created_at_id
  ON streams(createdAt, id)`,
  // Supports status-filtered ordered listing (e.g. running streams).
  `CREATE INDEX idx_streams_status_created_at_id
  ON streams(status, createdAt, id)`,
];
