export function postgresStreamDDL(schema: string): string {
  return `
CREATE SCHEMA IF NOT EXISTS "${schema}";

CREATE TABLE IF NOT EXISTS "${schema}"."streams" (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  created_at BIGINT NOT NULL,
  started_at BIGINT,
  finished_at BIGINT,
  cancel_requested_at BIGINT,
  error TEXT
);

CREATE TABLE IF NOT EXISTS "${schema}"."stream_chunks" (
  stream_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  data JSONB NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (stream_id, seq),
  FOREIGN KEY (stream_id) REFERENCES "${schema}"."streams"(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "idx_${schema}_streams_created_at_id"
  ON "${schema}"."streams"(created_at, id);

CREATE INDEX IF NOT EXISTS "idx_${schema}_streams_status_created_at_id"
  ON "${schema}"."streams"(status, created_at, id);
`;
}
