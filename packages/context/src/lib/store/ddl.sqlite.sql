-- Context Store DDL for SQLite
-- This schema implements a DAG-based message history with branching and checkpoints.

-- Performance PRAGMAs (session-level, run on each connection)
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA cache_size = -64000;
PRAGMA temp_store = MEMORY;
PRAGMA mmap_size = 268435456;

-- Integrity
PRAGMA foreign_keys = ON;

-- Chats table
-- createdAt/updatedAt: DEFAULT for insert, inline SET for updates
CREATE TABLE IF NOT EXISTS chats (
  id TEXT PRIMARY KEY,
  userId TEXT NOT NULL,
  title TEXT,
  metadata TEXT,
  createdAt INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
  updatedAt INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
);

CREATE INDEX IF NOT EXISTS idx_chats_updatedAt ON chats(updatedAt);
CREATE INDEX IF NOT EXISTS idx_chats_userId ON chats(userId);
-- Composite index for listChats(): WHERE userId = ? ORDER BY updatedAt DESC
CREATE INDEX IF NOT EXISTS idx_chats_userId_updatedAt ON chats(userId, updatedAt DESC);

-- Messages table (nodes in the DAG)
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  chatId TEXT NOT NULL,
  parentId TEXT,
  name TEXT NOT NULL,
  type TEXT,
  data TEXT NOT NULL,
  createdAt INTEGER NOT NULL,
  FOREIGN KEY (chatId) REFERENCES chats(id) ON DELETE CASCADE,
  FOREIGN KEY (parentId) REFERENCES messages(id)
);

CREATE INDEX IF NOT EXISTS idx_messages_chatId ON messages(chatId);
CREATE INDEX IF NOT EXISTS idx_messages_parentId ON messages(parentId);
-- Composite index for recursive CTE parent traversal in getMessageChain()
CREATE INDEX IF NOT EXISTS idx_messages_chatId_parentId ON messages(chatId, parentId);

-- Branches table (pointers to head messages)
CREATE TABLE IF NOT EXISTS branches (
  id TEXT PRIMARY KEY,
  chatId TEXT NOT NULL,
  name TEXT NOT NULL,
  headMessageId TEXT,
  isActive INTEGER NOT NULL DEFAULT 0,
  createdAt INTEGER NOT NULL,
  FOREIGN KEY (chatId) REFERENCES chats(id) ON DELETE CASCADE,
  FOREIGN KEY (headMessageId) REFERENCES messages(id),
  UNIQUE(chatId, name)
);

CREATE INDEX IF NOT EXISTS idx_branches_chatId ON branches(chatId);
-- Composite index for getActiveBranch(): WHERE chatId = ? AND isActive = 1
CREATE INDEX IF NOT EXISTS idx_branches_chatId_isActive ON branches(chatId, isActive);

-- Checkpoints table (pointers to message nodes)
CREATE TABLE IF NOT EXISTS checkpoints (
  id TEXT PRIMARY KEY,
  chatId TEXT NOT NULL,
  name TEXT NOT NULL,
  messageId TEXT NOT NULL,
  createdAt INTEGER NOT NULL,
  FOREIGN KEY (chatId) REFERENCES chats(id) ON DELETE CASCADE,
  FOREIGN KEY (messageId) REFERENCES messages(id),
  UNIQUE(chatId, name)
);

CREATE INDEX IF NOT EXISTS idx_checkpoints_chatId ON checkpoints(chatId);

-- FTS5 virtual table for full-text search
-- messageId/chatId/name are UNINDEXED (stored but not searchable, used for filtering/joining)
-- Only 'content' is indexed for full-text search
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  messageId UNINDEXED,
  chatId UNINDEXED,
  name UNINDEXED,
  content,
  tokenize='porter unicode61'
);
