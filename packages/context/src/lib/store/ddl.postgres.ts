export function storeDDL(schema: string): string {
  return `
CREATE SCHEMA IF NOT EXISTS "${schema}";

CREATE TABLE IF NOT EXISTS "${schema}"."chats" (
  id TEXT PRIMARY KEY,
  userId TEXT NOT NULL,
  title TEXT,
  metadata JSONB,
  createdAt BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
  updatedAt BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
);

CREATE INDEX IF NOT EXISTS "idx_${schema}_chats_updatedAt" ON "${schema}"."chats"(updatedAt);
CREATE INDEX IF NOT EXISTS "idx_${schema}_chats_userId" ON "${schema}"."chats"(userId);
CREATE INDEX IF NOT EXISTS "idx_${schema}_chats_metadata" ON "${schema}"."chats" USING GIN (metadata);

CREATE TABLE IF NOT EXISTS "${schema}"."messages" (
  id TEXT PRIMARY KEY,
  chatId TEXT NOT NULL,
  parentId TEXT,
  name TEXT NOT NULL,
  type TEXT,
  data JSONB NOT NULL,
  createdAt BIGINT NOT NULL,
  FOREIGN KEY (chatId) REFERENCES "${schema}"."chats"(id) ON DELETE CASCADE,
  FOREIGN KEY (parentId) REFERENCES "${schema}"."messages"(id)
);

CREATE INDEX IF NOT EXISTS "idx_${schema}_messages_chatId" ON "${schema}"."messages"(chatId);
CREATE INDEX IF NOT EXISTS "idx_${schema}_messages_parentId" ON "${schema}"."messages"(parentId);

CREATE TABLE IF NOT EXISTS "${schema}"."branches" (
  id TEXT PRIMARY KEY,
  chatId TEXT NOT NULL,
  name TEXT NOT NULL,
  headMessageId TEXT,
  isActive BOOLEAN NOT NULL DEFAULT FALSE,
  createdAt BIGINT NOT NULL,
  FOREIGN KEY (chatId) REFERENCES "${schema}"."chats"(id) ON DELETE CASCADE,
  FOREIGN KEY (headMessageId) REFERENCES "${schema}"."messages"(id),
  UNIQUE(chatId, name)
);

CREATE INDEX IF NOT EXISTS "idx_${schema}_branches_chatId" ON "${schema}"."branches"(chatId);

CREATE TABLE IF NOT EXISTS "${schema}"."checkpoints" (
  id TEXT PRIMARY KEY,
  chatId TEXT NOT NULL,
  name TEXT NOT NULL,
  messageId TEXT NOT NULL,
  createdAt BIGINT NOT NULL,
  FOREIGN KEY (chatId) REFERENCES "${schema}"."chats"(id) ON DELETE CASCADE,
  FOREIGN KEY (messageId) REFERENCES "${schema}"."messages"(id),
  UNIQUE(chatId, name)
);

CREATE INDEX IF NOT EXISTS "idx_${schema}_checkpoints_chatId" ON "${schema}"."checkpoints"(chatId);

CREATE TABLE IF NOT EXISTS "${schema}"."messages_fts" (
  messageId TEXT PRIMARY KEY REFERENCES "${schema}"."messages"(id) ON DELETE CASCADE,
  chatId TEXT NOT NULL,
  name TEXT NOT NULL,
  content TEXT NOT NULL,
  content_vector TSVECTOR
);

CREATE INDEX IF NOT EXISTS "idx_${schema}_messages_fts_vector" ON "${schema}"."messages_fts" USING GIN(content_vector);
CREATE INDEX IF NOT EXISTS "idx_${schema}_messages_fts_chatId" ON "${schema}"."messages_fts"(chatId);

CREATE OR REPLACE FUNCTION "${schema}"."messages_fts_update_vector"() RETURNS TRIGGER AS $$
BEGIN
  NEW.content_vector := to_tsvector('english', NEW.content);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "${schema}_messages_fts_vector_update" ON "${schema}"."messages_fts";
CREATE TRIGGER "${schema}_messages_fts_vector_update"
  BEFORE INSERT OR UPDATE ON "${schema}"."messages_fts"
  FOR EACH ROW
  EXECUTE FUNCTION "${schema}"."messages_fts_update_vector"();
`;
}
