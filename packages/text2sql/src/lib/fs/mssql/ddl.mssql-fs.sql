-- SQL Server filesystem schema for artifact storage
-- Tables: fs_entries (file/directory metadata), fs_chunks (file content)

-- Filesystem entries table (files, directories, symlinks)
IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'fs_entries') AND type = 'U')
CREATE TABLE fs_entries (
  path NVARCHAR(900) PRIMARY KEY,
  type NVARCHAR(20) NOT NULL,
  mode INT NOT NULL,
  size BIGINT NOT NULL,
  mtime BIGINT NOT NULL,
  symlinkTarget NVARCHAR(900) NULL
);
GO

IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'idx_fs_entries_type')
CREATE INDEX idx_fs_entries_type ON fs_entries(type);
GO

-- File content chunks table (for handling large files)
-- Files are split into 1MB chunks to avoid performance issues with large BLOBs
IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'fs_chunks') AND type = 'U')
CREATE TABLE fs_chunks (
  path NVARCHAR(900) NOT NULL,
  chunkIndex INT NOT NULL,
  data VARBINARY(MAX) NOT NULL,
  PRIMARY KEY (path, chunkIndex),
  FOREIGN KEY (path) REFERENCES fs_entries(path) ON DELETE CASCADE ON UPDATE CASCADE
);
GO
