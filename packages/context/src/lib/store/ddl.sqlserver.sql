-- Context Store DDL for SQL Server
-- This schema implements a DAG-based message history with branching and checkpoints.

-- Chats table
-- createdAt/updatedAt: DEFAULT for insert, inline SET for updates
IF OBJECT_ID('chats', 'U') IS NULL
BEGIN
  CREATE TABLE chats (
    id NVARCHAR(255) PRIMARY KEY,
    userId NVARCHAR(255) NOT NULL,
    title NVARCHAR(MAX),
    metadata NVARCHAR(MAX),
    createdAt BIGINT NOT NULL DEFAULT DATEDIFF_BIG(ms, '1970-01-01', GETUTCDATE()),
    updatedAt BIGINT NOT NULL DEFAULT DATEDIFF_BIG(ms, '1970-01-01', GETUTCDATE())
  );
END;

IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'idx_chats_updatedAt' AND object_id = OBJECT_ID('chats'))
  CREATE INDEX idx_chats_updatedAt ON chats(updatedAt);

IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'idx_chats_userId' AND object_id = OBJECT_ID('chats'))
  CREATE INDEX idx_chats_userId ON chats(userId);

-- Messages table (nodes in the DAG)
IF OBJECT_ID('messages', 'U') IS NULL
BEGIN
  CREATE TABLE messages (
    id NVARCHAR(255) PRIMARY KEY,
    chatId NVARCHAR(255) NOT NULL,
    parentId NVARCHAR(255),
    name NVARCHAR(255) NOT NULL,
    type NVARCHAR(255),
    data NVARCHAR(MAX) NOT NULL,
    createdAt BIGINT NOT NULL,
    FOREIGN KEY (chatId) REFERENCES chats(id) ON DELETE CASCADE,
    FOREIGN KEY (parentId) REFERENCES messages(id)
  );
END;

IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'idx_messages_chatId' AND object_id = OBJECT_ID('messages'))
  CREATE INDEX idx_messages_chatId ON messages(chatId);

IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'idx_messages_parentId' AND object_id = OBJECT_ID('messages'))
  CREATE INDEX idx_messages_parentId ON messages(parentId);

IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'idx_messages_chatId_parentId' AND object_id = OBJECT_ID('messages'))
  CREATE INDEX idx_messages_chatId_parentId ON messages(chatId, parentId);

-- Branches table (pointers to head messages)
IF OBJECT_ID('branches', 'U') IS NULL
BEGIN
  CREATE TABLE branches (
    id NVARCHAR(255) PRIMARY KEY,
    chatId NVARCHAR(255) NOT NULL,
    name NVARCHAR(255) NOT NULL,
    headMessageId NVARCHAR(255),
    isActive BIT NOT NULL DEFAULT 0,
    createdAt BIGINT NOT NULL,
    FOREIGN KEY (chatId) REFERENCES chats(id) ON DELETE CASCADE,
    FOREIGN KEY (headMessageId) REFERENCES messages(id),
    CONSTRAINT UQ_branches_chatId_name UNIQUE(chatId, name)
  );
END;

IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'idx_branches_chatId' AND object_id = OBJECT_ID('branches'))
  CREATE INDEX idx_branches_chatId ON branches(chatId);

IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'idx_branches_chatId_isActive' AND object_id = OBJECT_ID('branches'))
  CREATE INDEX idx_branches_chatId_isActive ON branches(chatId, isActive);

-- Checkpoints table (pointers to message nodes)
IF OBJECT_ID('checkpoints', 'U') IS NULL
BEGIN
  CREATE TABLE checkpoints (
    id NVARCHAR(255) PRIMARY KEY,
    chatId NVARCHAR(255) NOT NULL,
    name NVARCHAR(255) NOT NULL,
    messageId NVARCHAR(255) NOT NULL,
    createdAt BIGINT NOT NULL,
    FOREIGN KEY (chatId) REFERENCES chats(id) ON DELETE CASCADE,
    FOREIGN KEY (messageId) REFERENCES messages(id),
    CONSTRAINT UQ_checkpoints_chatId_name UNIQUE(chatId, name)
  );
END;

IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'idx_checkpoints_chatId' AND object_id = OBJECT_ID('checkpoints'))
  CREATE INDEX idx_checkpoints_chatId ON checkpoints(chatId);

-- Full-text search table
IF OBJECT_ID('messages_fts', 'U') IS NULL
BEGIN
  CREATE TABLE messages_fts (
    messageId NVARCHAR(255) NOT NULL,
    chatId NVARCHAR(255) NOT NULL,
    name NVARCHAR(255) NOT NULL,
    content NVARCHAR(MAX) NOT NULL,
    CONSTRAINT PK_messages_fts PRIMARY KEY (messageId),
    FOREIGN KEY (messageId) REFERENCES messages(id) ON DELETE CASCADE
  );
END;

IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'idx_messages_fts_chatId' AND object_id = OBJECT_ID('messages_fts'))
  CREATE INDEX idx_messages_fts_chatId ON messages_fts(chatId);

-- Full-text catalog and index (only if FTS is installed)
-- FTS is optional - search will gracefully degrade without it
IF SERVERPROPERTY('IsFullTextInstalled') = 1
BEGIN
  -- Create catalog if not exists
  IF NOT EXISTS (SELECT * FROM sys.fulltext_catalogs WHERE name = 'context_store_catalog')
    CREATE FULLTEXT CATALOG context_store_catalog AS DEFAULT;

  -- Create full-text index on messages_fts.content
  -- Note: This requires the table to have a unique index, which PK provides
  IF NOT EXISTS (SELECT * FROM sys.fulltext_indexes WHERE object_id = OBJECT_ID('messages_fts'))
  BEGIN
    CREATE FULLTEXT INDEX ON messages_fts(content)
      KEY INDEX PK_messages_fts
      ON context_store_catalog
      WITH STOPLIST = SYSTEM;
  END;
END;
