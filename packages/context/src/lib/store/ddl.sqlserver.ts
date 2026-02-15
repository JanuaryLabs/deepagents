export function storeDDL(schema: string): string {
  const s = schema;
  return `
IF OBJECT_ID('[${s}].[chats]', 'U') IS NULL
BEGIN
  CREATE TABLE [${s}].[chats] (
    id NVARCHAR(255) PRIMARY KEY,
    userId NVARCHAR(255) NOT NULL,
    title NVARCHAR(MAX),
    metadata NVARCHAR(MAX),
    createdAt BIGINT NOT NULL DEFAULT DATEDIFF_BIG(ms, '1970-01-01', GETUTCDATE()),
    updatedAt BIGINT NOT NULL DEFAULT DATEDIFF_BIG(ms, '1970-01-01', GETUTCDATE())
  );
END;

IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'idx_${s}_chats_updatedAt' AND object_id = OBJECT_ID('[${s}].[chats]'))
  CREATE INDEX [idx_${s}_chats_updatedAt] ON [${s}].[chats](updatedAt);

IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'idx_${s}_chats_userId' AND object_id = OBJECT_ID('[${s}].[chats]'))
  CREATE INDEX [idx_${s}_chats_userId] ON [${s}].[chats](userId);

IF OBJECT_ID('[${s}].[messages]', 'U') IS NULL
BEGIN
  CREATE TABLE [${s}].[messages] (
    id NVARCHAR(255) PRIMARY KEY,
    chatId NVARCHAR(255) NOT NULL,
    parentId NVARCHAR(255),
    name NVARCHAR(255) NOT NULL,
    type NVARCHAR(255),
    data NVARCHAR(MAX) NOT NULL,
    createdAt BIGINT NOT NULL,
    FOREIGN KEY (chatId) REFERENCES [${s}].[chats](id) ON DELETE CASCADE,
    FOREIGN KEY (parentId) REFERENCES [${s}].[messages](id)
  );
END;

IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'idx_${s}_messages_chatId' AND object_id = OBJECT_ID('[${s}].[messages]'))
  CREATE INDEX [idx_${s}_messages_chatId] ON [${s}].[messages](chatId);

IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'idx_${s}_messages_parentId' AND object_id = OBJECT_ID('[${s}].[messages]'))
  CREATE INDEX [idx_${s}_messages_parentId] ON [${s}].[messages](parentId);

IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'idx_${s}_messages_chatId_parentId' AND object_id = OBJECT_ID('[${s}].[messages]'))
  CREATE INDEX [idx_${s}_messages_chatId_parentId] ON [${s}].[messages](chatId, parentId);

IF OBJECT_ID('[${s}].[branches]', 'U') IS NULL
BEGIN
  CREATE TABLE [${s}].[branches] (
    id NVARCHAR(255) PRIMARY KEY,
    chatId NVARCHAR(255) NOT NULL,
    name NVARCHAR(255) NOT NULL,
    headMessageId NVARCHAR(255),
    isActive BIT NOT NULL DEFAULT 0,
    createdAt BIGINT NOT NULL,
    FOREIGN KEY (chatId) REFERENCES [${s}].[chats](id) ON DELETE CASCADE,
    FOREIGN KEY (headMessageId) REFERENCES [${s}].[messages](id),
    CONSTRAINT [UQ_${s}_branches_chatId_name] UNIQUE(chatId, name)
  );
END;

IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'idx_${s}_branches_chatId' AND object_id = OBJECT_ID('[${s}].[branches]'))
  CREATE INDEX [idx_${s}_branches_chatId] ON [${s}].[branches](chatId);

IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'idx_${s}_branches_chatId_isActive' AND object_id = OBJECT_ID('[${s}].[branches]'))
  CREATE INDEX [idx_${s}_branches_chatId_isActive] ON [${s}].[branches](chatId, isActive);

IF OBJECT_ID('[${s}].[checkpoints]', 'U') IS NULL
BEGIN
  CREATE TABLE [${s}].[checkpoints] (
    id NVARCHAR(255) PRIMARY KEY,
    chatId NVARCHAR(255) NOT NULL,
    name NVARCHAR(255) NOT NULL,
    messageId NVARCHAR(255) NOT NULL,
    createdAt BIGINT NOT NULL,
    FOREIGN KEY (chatId) REFERENCES [${s}].[chats](id) ON DELETE CASCADE,
    FOREIGN KEY (messageId) REFERENCES [${s}].[messages](id),
    CONSTRAINT [UQ_${s}_checkpoints_chatId_name] UNIQUE(chatId, name)
  );
END;

IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'idx_${s}_checkpoints_chatId' AND object_id = OBJECT_ID('[${s}].[checkpoints]'))
  CREATE INDEX [idx_${s}_checkpoints_chatId] ON [${s}].[checkpoints](chatId);

IF OBJECT_ID('[${s}].[messages_fts]', 'U') IS NULL
BEGIN
  CREATE TABLE [${s}].[messages_fts] (
    messageId NVARCHAR(255) NOT NULL,
    chatId NVARCHAR(255) NOT NULL,
    name NVARCHAR(255) NOT NULL,
    content NVARCHAR(MAX) NOT NULL,
    CONSTRAINT [PK_${s}_messages_fts] PRIMARY KEY (messageId),
    FOREIGN KEY (messageId) REFERENCES [${s}].[messages](id) ON DELETE CASCADE
  );
END;

IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'idx_${s}_messages_fts_chatId' AND object_id = OBJECT_ID('[${s}].[messages_fts]'))
  CREATE INDEX [idx_${s}_messages_fts_chatId] ON [${s}].[messages_fts](chatId);

GO

IF SERVERPROPERTY('IsFullTextInstalled') = 1
BEGIN
  IF NOT EXISTS (SELECT * FROM sys.fulltext_catalogs WHERE name = '${s}_context_store_catalog')
    CREATE FULLTEXT CATALOG [${s}_context_store_catalog];

  IF NOT EXISTS (SELECT * FROM sys.fulltext_indexes WHERE object_id = OBJECT_ID('[${s}].[messages_fts]'))
  BEGIN
    CREATE FULLTEXT INDEX ON [${s}].[messages_fts](content)
      KEY INDEX [PK_${s}_messages_fts]
      ON [${s}_context_store_catalog]
      WITH STOPLIST = SYSTEM;
  END;
END;
`;
}
