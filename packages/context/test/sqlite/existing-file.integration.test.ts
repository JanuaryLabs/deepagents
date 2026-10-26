import { Sqlite } from '@zukhruf/testing/sqlite';
import assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';

import { SqliteContextStore, SqliteStreamStore } from '@deepagents/context';

const sqlite = new Sqlite();

// The schema file of @deepagents/context 7.1.4 (ddl.sqlite.sql), frozen
// here because it is what every existing .context.sqlite file was made with.
const PREVIOUS_RELEASE_CONTEXT_DDL = `-- Context Store DDL for SQLite
-- This schema implements a DAG-based message history with branching and checkpoints.

-- Performance PRAGMAs (session-level, run on each connection)
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA cache_size = -64000;
PRAGMA temp_store = MEMORY;
PRAGMA mmap_size = 268435456;
PRAGMA busy_timeout = 5000;

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
`;

const userMessage =
  '{"role":"user","parts":[{"type":"text","text":"Which harbour has the cheapest ferry?"}]}';
const assistantMessage =
  '{"role":"assistant","parts":[{"type":"text","text":"The northern harbour sells ferry tickets for less."}]}';

describe('SqliteContextStore on an existing file', () => {
  it('keeps the chats, messages and search hits of a file the previous release wrote', async () => {
    await using database = await sqlite.database();
    // The rows below are what the 7.1.4 store wrote for createChat,
    // addMessages, updateBranchHead and createCheckpoint, read back from its
    // file with SELECT * on each table.
    database.connection.exec(PREVIOUS_RELEASE_CONTEXT_DDL);
    database.connection.exec(`
      INSERT INTO chats (id, userId, title, metadata, createdAt, updatedAt)
        VALUES ('chat-1', 'user-1', 'Trip planning', NULL, 1793038911000, 1793038911000);
      INSERT INTO messages (id, chatId, parentId, name, type, data, createdAt) VALUES
        ('msg-1', 'chat-1', NULL, 'user', 'message', '${userMessage}', 1761480000000),
        ('msg-2', 'chat-1', 'msg-1', 'assistant', 'message', '${assistantMessage}', 1761480001000);
      INSERT INTO branches (id, chatId, name, headMessageId, isActive, createdAt)
        VALUES ('b298b662-e0c8-40c4-9f36-669717578126', 'chat-1', 'main', 'msg-2', 1, 1793038911416);
      INSERT INTO checkpoints (id, chatId, name, messageId, createdAt)
        VALUES ('cp-1', 'chat-1', 'before-booking', 'msg-2', 1761480002000);
      INSERT INTO messages_fts (messageId, chatId, name, content) VALUES
        ('msg-1', 'chat-1', 'user', '${userMessage}'),
        ('msg-2', 'chat-1', 'assistant', '${assistantMessage}');
    `);
    database.connection.close();

    using connection = new DatabaseSync(database.path);
    const store = new SqliteContextStore(connection);

    const chat = await store.getChat('chat-1');
    assert.strictEqual(chat?.title, 'Trip planning');
    const messages = await store.getMessages('chat-1');
    assert.deepStrictEqual(
      messages.map((message) => [message.id, message.data]),
      [
        ['msg-1', JSON.parse(userMessage)],
        ['msg-2', JSON.parse(assistantMessage)],
      ],
    );
    const branch = await store.getActiveBranch('chat-1');
    assert.strictEqual(branch?.headMessageId, 'msg-2');
    const checkpoint = await store.getCheckpoint('chat-1', 'before-booking');
    assert.strictEqual(checkpoint?.messageId, 'msg-2');
    const hits = await store.searchMessages('chat-1', 'harbour');
    assert.deepStrictEqual(hits.map((hit) => hit.message.id).sort(), [
      'msg-1',
      'msg-2',
    ]);
  });

  it('adds a column a table lacks and keeps its rows', async () => {
    await using database = await sqlite.database();
    // No release made a chats table without metadata. The short table is
    // written by hand, to see the store bring a table up to its declaration.
    database.connection.exec(`
      CREATE TABLE chats (
        id TEXT PRIMARY KEY,
        userId TEXT NOT NULL,
        title TEXT,
        createdAt INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
        updatedAt INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
      );
      CREATE TABLE messages (
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
      INSERT INTO chats (id, userId, title) VALUES ('old-chat', 'user-1', 'Old chat');
      INSERT INTO messages (id, chatId, parentId, name, type, data, createdAt)
        VALUES ('old-msg', 'old-chat', NULL, 'user', 'message', '"hello"', 1761480000000);
    `);
    database.connection.close();

    using connection = new DatabaseSync(database.path);
    const store = new SqliteContextStore(connection);
    await store.createChat({
      id: 'new-chat',
      userId: 'user-1',
      metadata: { pinned: true },
    });

    assert.strictEqual((await store.getChat('old-chat'))?.title, 'Old chat');
    assert.strictEqual((await store.getMessage('old-msg'))?.data, 'hello');
    assert.deepStrictEqual((await store.getChat('new-chat'))?.metadata, {
      pinned: true,
    });
  });
});

describe('SqliteStreamStore on an existing file', () => {
  it('adds a column a table lacks and keeps its rows', async () => {
    await using database = await sqlite.database();
    // No release made a streams table without cancelRequestedAt. The short
    // table is written by hand, to see the store bring a table up to its
    // declaration.
    database.connection.exec(`
      CREATE TABLE streams (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'queued',
        createdAt INTEGER NOT NULL,
        startedAt INTEGER,
        finishedAt INTEGER,
        error TEXT
      );
      CREATE TABLE stream_chunks (
        streamId TEXT NOT NULL,
        seq INTEGER NOT NULL,
        data TEXT NOT NULL,
        createdAt INTEGER NOT NULL,
        PRIMARY KEY (streamId, seq),
        FOREIGN KEY (streamId) REFERENCES streams(id) ON DELETE CASCADE
      );
      INSERT INTO streams (id, status, createdAt) VALUES ('old-stream', 'completed', 1761480000000);
      INSERT INTO stream_chunks (streamId, seq, data, createdAt)
        VALUES ('old-stream', 0, '{"type":"text-delta","id":"t1","delta":"hi"}', 1761480000001);
    `);
    database.connection.close();

    using connection = new DatabaseSync(database.path);
    const store = new SqliteStreamStore(connection);
    await store.createStream({
      id: 'new-stream',
      status: 'running',
      createdAt: 1761480002000,
      startedAt: 1761480002000,
      finishedAt: null,
      cancelRequestedAt: 1761480003000,
      error: null,
    });

    assert.strictEqual(
      (await store.getStream('old-stream'))?.cancelRequestedAt,
      null,
    );
    assert.deepStrictEqual(
      (await store.getChunks('old-stream')).map((chunk) => chunk.data),
      [{ type: 'text-delta', id: 't1', delta: 'hi' }],
    );
    assert.strictEqual(
      (await store.getStream('new-stream'))?.cancelRequestedAt,
      1761480003000,
    );
  });
});
