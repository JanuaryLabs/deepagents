export function postgresFsDDL(schema: string): string {
  return `
CREATE SCHEMA IF NOT EXISTS "${schema}";

CREATE TABLE IF NOT EXISTS "${schema}"."fs_entries" (
  path TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  mode INTEGER NOT NULL,
  size BIGINT NOT NULL,
  mtime BIGINT NOT NULL,
  symlink_target TEXT
);

CREATE INDEX IF NOT EXISTS "idx_${schema}_fs_entries_type" ON "${schema}"."fs_entries"(type);

CREATE TABLE IF NOT EXISTS "${schema}"."fs_chunks" (
  path TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  data BYTEA NOT NULL,
  PRIMARY KEY (path, chunk_index),
  FOREIGN KEY (path) REFERENCES "${schema}"."fs_entries"(path) ON DELETE CASCADE ON UPDATE CASCADE
);
`;
}
