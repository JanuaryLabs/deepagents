export function storeDDL(schema: string): string {
  return `
IF OBJECT_ID('[${schema}].[chats]', 'U') IS NULL
BEGIN
  CREATE TABLE [${schema}].[chats] (
    id NVARCHAR(255) PRIMARY KEY,
    userId NVARCHAR(255) NOT NULL,
    title NVARCHAR(MAX),
    metadata NVARCHAR(MAX),
    createdAt BIGINT NOT NULL DEFAULT DATEDIFF_BIG(ms, '1970-01-01', GETUTCDATE()),
    updatedAt BIGINT NOT NULL DEFAULT DATEDIFF_BIG(ms, '1970-01-01', GETUTCDATE())
  );
END;

IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'idx_${schema}_chats_updatedAt' AND object_id = OBJECT_ID('[${schema}].[chats]'))
  CREATE INDEX [idx_${schema}_chats_updatedAt] ON [${schema}].[chats](updatedAt);

IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'idx_${schema}_chats_userId' AND object_id = OBJECT_ID('[${schema}].[chats]'))
  CREATE INDEX [idx_${schema}_chats_userId] ON [${schema}].[chats](userId);

IF OBJECT_ID('[${schema}].[messages]', 'U') IS NULL
BEGIN
  CREATE TABLE [${schema}].[messages] (
    id NVARCHAR(255) PRIMARY KEY,
    chatId NVARCHAR(255) NOT NULL,
    parentId NVARCHAR(255),
    name NVARCHAR(255) NOT NULL,
    type NVARCHAR(255),
    data NVARCHAR(MAX) NOT NULL,
    createdAt BIGINT NOT NULL,
    FOREIGN KEY (chatId) REFERENCES [${schema}].[chats](id) ON DELETE CASCADE,
    FOREIGN KEY (parentId) REFERENCES [${schema}].[messages](id)
  );
END;

IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'idx_${schema}_messages_chatId' AND object_id = OBJECT_ID('[${schema}].[messages]'))
  CREATE INDEX [idx_${schema}_messages_chatId] ON [${schema}].[messages](chatId);

IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'idx_${schema}_messages_parentId' AND object_id = OBJECT_ID('[${schema}].[messages]'))
  CREATE INDEX [idx_${schema}_messages_parentId] ON [${schema}].[messages](parentId);

IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'idx_${schema}_messages_chatId_parentId' AND object_id = OBJECT_ID('[${schema}].[messages]'))
  CREATE INDEX [idx_${schema}_messages_chatId_parentId] ON [${schema}].[messages](chatId, parentId);

IF OBJECT_ID('[${schema}].[branches]', 'U') IS NULL
BEGIN
  CREATE TABLE [${schema}].[branches] (
    id NVARCHAR(255) PRIMARY KEY,
    chatId NVARCHAR(255) NOT NULL,
    name NVARCHAR(255) NOT NULL,
    headMessageId NVARCHAR(255),
    isActive BIT NOT NULL DEFAULT 0,
    createdAt BIGINT NOT NULL,
    FOREIGN KEY (chatId) REFERENCES [${schema}].[chats](id) ON DELETE CASCADE,
    FOREIGN KEY (headMessageId) REFERENCES [${schema}].[messages](id),
    CONSTRAINT [UQ_${schema}_branches_chatId_name] UNIQUE(chatId, name)
  );
END;

IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'idx_${schema}_branches_chatId' AND object_id = OBJECT_ID('[${schema}].[branches]'))
  CREATE INDEX [idx_${schema}_branches_chatId] ON [${schema}].[branches](chatId);

IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'idx_${schema}_branches_chatId_isActive' AND object_id = OBJECT_ID('[${schema}].[branches]'))
  CREATE INDEX [idx_${schema}_branches_chatId_isActive] ON [${schema}].[branches](chatId, isActive);

IF OBJECT_ID('[${schema}].[checkpoints]', 'U') IS NULL
BEGIN
  CREATE TABLE [${schema}].[checkpoints] (
    id NVARCHAR(255) PRIMARY KEY,
    chatId NVARCHAR(255) NOT NULL,
    name NVARCHAR(255) NOT NULL,
    messageId NVARCHAR(255) NOT NULL,
    createdAt BIGINT NOT NULL,
    FOREIGN KEY (chatId) REFERENCES [${schema}].[chats](id) ON DELETE CASCADE,
    FOREIGN KEY (messageId) REFERENCES [${schema}].[messages](id),
    CONSTRAINT [UQ_${schema}_checkpoints_chatId_name] UNIQUE(chatId, name)
  );
END;

IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'idx_${schema}_checkpoints_chatId' AND object_id = OBJECT_ID('[${schema}].[checkpoints]'))
  CREATE INDEX [idx_${schema}_checkpoints_chatId] ON [${schema}].[checkpoints](chatId);

IF OBJECT_ID('[${schema}].[messages_fts]', 'U') IS NULL
BEGIN
  CREATE TABLE [${schema}].[messages_fts] (
    messageId NVARCHAR(255) NOT NULL,
    chatId NVARCHAR(255) NOT NULL,
    name NVARCHAR(255) NOT NULL,
    content NVARCHAR(MAX) NOT NULL,
    CONSTRAINT [PK_${schema}_messages_fts] PRIMARY KEY (messageId),
    FOREIGN KEY (messageId) REFERENCES [${schema}].[messages](id) ON DELETE CASCADE
  );
END;

IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'idx_${schema}_messages_fts_chatId' AND object_id = OBJECT_ID('[${schema}].[messages_fts]'))
  CREATE INDEX [idx_${schema}_messages_fts_chatId] ON [${schema}].[messages_fts](chatId);

GO

IF SERVERPROPERTY('IsFullTextInstalled') = 1
BEGIN
  IF NOT EXISTS (SELECT * FROM sys.fulltext_catalogs WHERE name = '${schema}_context_store_catalog')
    CREATE FULLTEXT CATALOG [${schema}_context_store_catalog];

  IF NOT EXISTS (SELECT * FROM sys.fulltext_indexes WHERE object_id = OBJECT_ID('[${schema}].[messages_fts]'))
  BEGIN
    CREATE FULLTEXT INDEX ON [${schema}].[messages_fts](content)
      KEY INDEX [PK_${schema}_messages_fts]
      ON [${schema}_context_store_catalog]
      WITH STOPLIST = SYSTEM;
  END;
END;
`;
}
