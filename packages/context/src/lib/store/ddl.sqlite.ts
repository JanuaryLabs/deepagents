// Context store schema for SQLite: a DAG of messages with branches and
// checkpoints. SQLite stores the text of each CREATE and
// @zukhruf/sqlite-drift compares it, so the text after each object name must
// stay byte-identical to what earlier releases wrote.

// Session-level PRAGMAs, run on each connection before the schema is applied.
export const SETUP = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA cache_size = -64000;
PRAGMA temp_store = MEMORY;
PRAGMA mmap_size = 268435456;
PRAGMA busy_timeout = 5000;
`;

export const statements = [
  // createdAt/updatedAt: DEFAULT for insert, inline SET for updates
  `CREATE TABLE chats (
  id TEXT PRIMARY KEY,
  userId TEXT NOT NULL,
  title TEXT,
  metadata TEXT,
  createdAt INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
  updatedAt INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
)`,
  `CREATE INDEX idx_chats_updatedAt ON chats(updatedAt)`,
  `CREATE INDEX idx_chats_userId ON chats(userId)`,
  // Composite index for listChats(): WHERE userId = ? ORDER BY updatedAt DESC
  `CREATE INDEX idx_chats_userId_updatedAt ON chats(userId, updatedAt DESC)`,
  // Messages are the nodes of the DAG
  `CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  chatId TEXT NOT NULL,
  parentId TEXT,
  name TEXT NOT NULL,
  type TEXT,
  data TEXT NOT NULL,
  createdAt INTEGER NOT NULL,
  FOREIGN KEY (chatId) REFERENCES chats(id) ON DELETE CASCADE,
  FOREIGN KEY (parentId) REFERENCES messages(id)
)`,
  `CREATE INDEX idx_messages_chatId ON messages(chatId)`,
  `CREATE INDEX idx_messages_parentId ON messages(parentId)`,
  // Composite index for recursive CTE parent traversal in getMessageChain()
  `CREATE INDEX idx_messages_chatId_parentId ON messages(chatId, parentId)`,
  // Branches point to head messages
  `CREATE TABLE branches (
  id TEXT PRIMARY KEY,
  chatId TEXT NOT NULL,
  name TEXT NOT NULL,
  headMessageId TEXT,
  isActive INTEGER NOT NULL DEFAULT 0,
  createdAt INTEGER NOT NULL,
  FOREIGN KEY (chatId) REFERENCES chats(id) ON DELETE CASCADE,
  FOREIGN KEY (headMessageId) REFERENCES messages(id),
  UNIQUE(chatId, name)
)`,
  `CREATE INDEX idx_branches_chatId ON branches(chatId)`,
  // Composite index for getActiveBranch(): WHERE chatId = ? AND isActive = 1
  `CREATE INDEX idx_branches_chatId_isActive ON branches(chatId, isActive)`,
  // Checkpoints point to message nodes
  `CREATE TABLE checkpoints (
  id TEXT PRIMARY KEY,
  chatId TEXT NOT NULL,
  name TEXT NOT NULL,
  messageId TEXT NOT NULL,
  createdAt INTEGER NOT NULL,
  FOREIGN KEY (chatId) REFERENCES chats(id) ON DELETE CASCADE,
  FOREIGN KEY (messageId) REFERENCES messages(id),
  UNIQUE(chatId, name)
)`,
  `CREATE INDEX idx_checkpoints_chatId ON checkpoints(chatId)`,
];

// FTS5 table for full-text search over message content. The store fills it
// when it inserts a message, so it is derived data and may be rebuilt.
// messageId/chatId/name are UNINDEXED (stored but not searchable, used for
// filtering/joining). Only 'content' is indexed for full-text search.
export const searchStatements = [
  `CREATE VIRTUAL TABLE messages_fts USING fts5(
  messageId UNINDEXED,
  chatId UNINDEXED,
  name UNINDEXED,
  content,
  tokenize='porter unicode61'
)`,
];
