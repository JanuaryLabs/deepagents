PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS streams (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK(status IN ('queued','running','completed','failed','cancelled')),
  createdAt INTEGER NOT NULL,
  startedAt INTEGER,
  finishedAt INTEGER,
  cancelRequestedAt INTEGER,
  error TEXT
);

CREATE TABLE IF NOT EXISTS stream_chunks (
  streamId TEXT NOT NULL,
  seq INTEGER NOT NULL,
  data TEXT NOT NULL,
  createdAt INTEGER NOT NULL,
  PRIMARY KEY (streamId, seq),
  FOREIGN KEY (streamId) REFERENCES streams(id) ON DELETE CASCADE
);
