export function mssqlFsDDL(schema: string): string {
  const s = schema;
  return `
IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[${s}].[fs_entries]') AND type = 'U')
CREATE TABLE [${s}].[fs_entries] (
  path NVARCHAR(900) PRIMARY KEY,
  type NVARCHAR(20) NOT NULL,
  mode INT NOT NULL,
  size BIGINT NOT NULL,
  mtime BIGINT NOT NULL,
  symlinkTarget NVARCHAR(900) NULL
);
GO

IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'idx_${s}_fs_entries_type')
CREATE INDEX [idx_${s}_fs_entries_type] ON [${s}].[fs_entries](type);
GO

IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[${s}].[fs_chunks]') AND type = 'U')
CREATE TABLE [${s}].[fs_chunks] (
  path NVARCHAR(900) NOT NULL,
  chunkIndex INT NOT NULL,
  data VARBINARY(MAX) NOT NULL,
  PRIMARY KEY (path, chunkIndex),
  FOREIGN KEY (path) REFERENCES [${s}].[fs_entries](path) ON DELETE CASCADE ON UPDATE CASCADE
);
GO
`;
}
