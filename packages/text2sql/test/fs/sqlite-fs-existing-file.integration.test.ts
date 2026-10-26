import { Sqlite } from '@zukhruf/testing/sqlite';
import * as assert from 'node:assert';
import { describe, it } from 'node:test';

import { SqliteFs } from '@deepagents/text2sql';

const sqlite = new Sqlite();

describe('SqliteFs on an existing file', () => {
  it('adds a column a table lacks and keeps its rows', async () => {
    await using database = await sqlite.database();
    // No release made an fs_entries table without symlinkTarget. The short
    // table is written by hand, to see the store bring a table up to its
    // declaration. The index and fs_chunks are the text the previous release
    // wrote, unindented, so only fs_entries differs from the declaration.
    database.connection.exec(`
CREATE TABLE fs_entries (
  path TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  mode INTEGER NOT NULL,
  size INTEGER NOT NULL,
  mtime INTEGER NOT NULL
);
CREATE INDEX idx_fs_entries_type ON fs_entries(type);
CREATE TABLE fs_chunks (
  path TEXT NOT NULL,               -- Reference to fs_entries.path
  chunkIndex INTEGER NOT NULL,      -- 0-based chunk sequence
  data BLOB NOT NULL,               -- Chunk content (up to 1MB default)
  PRIMARY KEY (path, chunkIndex),
  FOREIGN KEY (path) REFERENCES fs_entries(path) ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO fs_entries (path, type, mode, size, mtime) VALUES
  ('/', 'directory', 493, 0, 1761480000000),
  ('/old.txt', 'file', 420, 11, 1761480000000);
INSERT INTO fs_chunks (path, chunkIndex, data) VALUES
  ('/old.txt', 0, CAST('old content' AS BLOB));
`);
    database.connection.close();

    const sqliteFs = new SqliteFs({ dbPath: database.path, root: '/' });
    await sqliteFs.symlink('/old.txt', '/link.txt');

    assert.strictEqual(await sqliteFs.readFile('/old.txt'), 'old content');
    assert.strictEqual(await sqliteFs.readlink('/link.txt'), '/old.txt');
    assert.strictEqual(await sqliteFs.readFile('/link.txt'), 'old content');
  });
});
