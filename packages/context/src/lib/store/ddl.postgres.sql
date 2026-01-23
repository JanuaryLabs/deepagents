-- Context Store DDL for PostgreSQL
-- This schema implements a DAG-based message history with branching and checkpoints.

-- Chats table
-- createdAt/updatedAt: DEFAULT for insert, inline SET for updates
CREATE TABLE IF NOT EXISTS chats (
  id TEXT PRIMARY KEY,
  userId TEXT NOT NULL,
  title TEXT,
  metadata JSONB,
  createdAt BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
  updatedAt BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
);

CREATE INDEX IF NOT EXISTS idx_chats_updatedAt ON chats(updatedAt);
CREATE INDEX IF NOT EXISTS idx_chats_userId ON chats(userId);
CREATE INDEX IF NOT EXISTS idx_chats_metadata ON chats USING GIN (metadata);

-- Messages table (nodes in the DAG)
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  chatId TEXT NOT NULL,
  parentId TEXT,
  name TEXT NOT NULL,
  type TEXT,
  data JSONB NOT NULL,
  createdAt BIGINT NOT NULL,
  FOREIGN KEY (chatId) REFERENCES chats(id) ON DELETE CASCADE,
  FOREIGN KEY (parentId) REFERENCES messages(id)
);

CREATE INDEX IF NOT EXISTS idx_messages_chatId ON messages(chatId);
CREATE INDEX IF NOT EXISTS idx_messages_parentId ON messages(parentId);

-- Branches table (pointers to head messages)
CREATE TABLE IF NOT EXISTS branches (
  id TEXT PRIMARY KEY,
  chatId TEXT NOT NULL,
  name TEXT NOT NULL,
  headMessageId TEXT,
  isActive BOOLEAN NOT NULL DEFAULT FALSE,
  createdAt BIGINT NOT NULL,
  FOREIGN KEY (chatId) REFERENCES chats(id) ON DELETE CASCADE,
  FOREIGN KEY (headMessageId) REFERENCES messages(id),
  UNIQUE(chatId, name)
);

CREATE INDEX IF NOT EXISTS idx_branches_chatId ON branches(chatId);

-- Checkpoints table (pointers to message nodes)
CREATE TABLE IF NOT EXISTS checkpoints (
  id TEXT PRIMARY KEY,
  chatId TEXT NOT NULL,
  name TEXT NOT NULL,
  messageId TEXT NOT NULL,
  createdAt BIGINT NOT NULL,
  FOREIGN KEY (chatId) REFERENCES chats(id) ON DELETE CASCADE,
  FOREIGN KEY (messageId) REFERENCES messages(id),
  UNIQUE(chatId, name)
);

CREATE INDEX IF NOT EXISTS idx_checkpoints_chatId ON checkpoints(chatId);

-- Full-text search using tsvector + GIN index
CREATE TABLE IF NOT EXISTS messages_fts (
  messageId TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  chatId TEXT NOT NULL,
  name TEXT NOT NULL,
  content TEXT NOT NULL,
  content_vector TSVECTOR
);

CREATE INDEX IF NOT EXISTS idx_messages_fts_vector ON messages_fts USING GIN(content_vector);
CREATE INDEX IF NOT EXISTS idx_messages_fts_chatId ON messages_fts(chatId);

-- Trigger to automatically update tsvector on insert/update
CREATE OR REPLACE FUNCTION messages_fts_update_vector() RETURNS TRIGGER AS $$
BEGIN
  NEW.content_vector := to_tsvector('english', NEW.content);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS messages_fts_vector_update ON messages_fts;
CREATE TRIGGER messages_fts_vector_update
  BEFORE INSERT OR UPDATE ON messages_fts
  FOR EACH ROW
  EXECUTE FUNCTION messages_fts_update_vector();
