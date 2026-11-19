import { Sqlite } from '@zukhruf/testing/sqlite';
import * as assert from 'node:assert';
import { describe, it } from 'node:test';

import { SqliteFs } from '@deepagents/text2sql';

const sqlite = new Sqlite();

describe('SqliteFs', () => {
  describe('file operations', () => {
    it('rejects with the error SQLite ended the write transaction with', async () => {
      await using database = await sqlite.database();
      const sqliteFs = new SqliteFs({ dbPath: database.path, root: '/' });
      // SqliteFs opens its own connection, so a full disk cannot be staged
      // on it. A RAISE(ROLLBACK) trigger makes SQLite end the transaction
      // itself the same way.
      database.connection.exec(`
        CREATE TRIGGER fail_chunk_write BEFORE INSERT ON fs_chunks
        BEGIN SELECT RAISE(ROLLBACK, 'chunk write failed'); END
      `);

      await assert.rejects(sqliteFs.writeFile('/test.txt', 'Hello, World!'), {
        errcode: 1811,
        message: 'chunk write failed',
      });
    });
  });

  describe('large file chunking', () => {
    it('should handle files larger than chunk size', async () => {
      await using database = await sqlite.database();
      const sqliteFs = new SqliteFs({ dbPath: database.path, root: '/' });

      // Create a 2MB file (larger than 1MB chunk size)
      const size = 2 * 1024 * 1024;
      const content = new Uint8Array(size);
      for (let i = 0; i < size; i++) {
        content[i] = i % 256;
      }

      await sqliteFs.writeFile('/large.bin', content);

      const result = await sqliteFs.readFileBuffer('/large.bin');
      assert.strictEqual(result.length, size);
      assert.deepStrictEqual(result, content);
    });
  });

  describe('copy and move operations', () => {
    it('reads a file moved onto the path of a removed file as the moved file', async () => {
      await using database = await sqlite.database();
      const sqliteFs = new SqliteFs({
        dbPath: database.path,
        root: '/',
        chunkSize: 4,
      });
      await sqliteFs.writeFile('/report.txt', 'old-old-old-');
      await sqliteFs.rm('/report.txt');
      await sqliteFs.writeFile('/draft.txt', 'new');

      await sqliteFs.mv('/draft.txt', '/report.txt');

      assert.strictEqual(await sqliteFs.readFile('/report.txt'), 'new');
    });
  });

  describe('path operations', () => {
    it('should resolve paths', async () => {
      await using database = await sqlite.database();
      const sqliteFs = new SqliteFs({ dbPath: database.path, root: '/' });

      assert.strictEqual(sqliteFs.resolvePath('/home', 'user'), '/home/user');
      assert.strictEqual(sqliteFs.resolvePath('/home/user', '..'), '/home');
      assert.strictEqual(
        sqliteFs.resolvePath('/home', '/absolute'),
        '/absolute',
      );
    });

    it('should get all paths', async () => {
      await using database = await sqlite.database();
      const sqliteFs = new SqliteFs({ dbPath: database.path, root: '/' });

      // Create some entries
      await sqliteFs.mkdir('/getall');
      await sqliteFs.writeFile('/getall/file.txt', 'content');

      const paths = sqliteFs.getAllPaths();
      assert.strictEqual(paths.includes('/'), true);
      assert.strictEqual(paths.includes('/getall'), true);
      assert.strictEqual(paths.includes('/getall/file.txt'), true);
    });
  });

  describe('persistence', () => {
    it('should persist data across instances', async () => {
      await using database = await sqlite.database();
      const dbPath = database.path;

      // Write with first instance
      const fs1 = new SqliteFs({ dbPath, root: '/' });
      await fs1.writeFile('/persist.txt', 'persistent data');

      // Read with second instance
      const fs2 = new SqliteFs({ dbPath, root: '/' });
      const content = await fs2.readFile('/persist.txt');

      assert.strictEqual(content, 'persistent data');
    });
  });

  describe('root option', () => {
    it('should prefix paths with root', async () => {
      await using database = await sqlite.database();
      const dbPath = database.path;
      const rootFs = new SqliteFs({ dbPath, root: '/prefix' });

      // Write a file via the prefixed fs
      await rootFs.writeFile('/file.txt', 'prefixed content');

      // The file should be accessible at /file.txt through the same instance
      const content = await rootFs.readFile('/file.txt');
      assert.strictEqual(content, 'prefixed content');

      // Create another instance at root level to verify storage location
      const rawFs = new SqliteFs({ dbPath, root: '/' });
      const allPaths = rawFs.getAllPaths();

      // File should be stored at /prefix/file.txt internally
      assert.ok(allPaths.includes('/prefix'), 'Should have /prefix directory');
      assert.ok(
        allPaths.includes('/prefix/file.txt'),
        'Should have /prefix/file.txt',
      );
    });

    it('should create root directory structure on initialization', async () => {
      await using database = await sqlite.database();
      const dbPath = database.path;
      const rootFs = new SqliteFs({ dbPath, root: '/chat/123/results' });

      // Verify root directory was created
      const rawFs = new SqliteFs({ dbPath, root: '/' });
      const allPaths = rawFs.getAllPaths();

      assert.ok(allPaths.includes('/chat'), 'Should have /chat');
      assert.ok(allPaths.includes('/chat/123'), 'Should have /chat/123');
      assert.ok(
        allPaths.includes('/chat/123/results'),
        'Should have /chat/123/results',
      );
    });

    it('should isolate two instances with different roots', async () => {
      await using database = await sqlite.database();
      const dbPath = database.path;

      // Create two filesystems with different roots
      const fs1 = new SqliteFs({ dbPath, root: '/chat-1' });
      const fs2 = new SqliteFs({ dbPath, root: '/chat-2' });

      // Write same filename to both
      await fs1.writeFile('/data.json', '{"chat": 1}');
      await fs2.writeFile('/data.json', '{"chat": 2}');

      // Each should see its own data
      assert.strictEqual(await fs1.readFile('/data.json'), '{"chat": 1}');
      assert.strictEqual(await fs2.readFile('/data.json'), '{"chat": 2}');

      // Verify raw storage has both
      const rawFs = new SqliteFs({ dbPath, root: '/' });
      const allPaths = rawFs.getAllPaths();
      assert.ok(
        allPaths.includes('/chat-1/data.json'),
        'Should have /chat-1/data.json',
      );
      assert.ok(
        allPaths.includes('/chat-2/data.json'),
        'Should have /chat-2/data.json',
      );
    });

    it('should handle nested paths with root', async () => {
      await using database = await sqlite.database();
      const dbPath = database.path;
      const rootFs = new SqliteFs({ dbPath, root: '/artifacts' });

      // Create nested structure
      await rootFs.mkdir('/results', { recursive: true });
      await rootFs.writeFile('/results/query.json', '[]');

      // Should be accessible
      assert.ok(await rootFs.exists('/results'));
      assert.ok(await rootFs.exists('/results/query.json'));

      // Verify internal storage
      const rawFs = new SqliteFs({ dbPath, root: '/' });
      const allPaths = rawFs.getAllPaths();
      assert.ok(
        allPaths.includes('/artifacts/results'),
        'Should have /artifacts/results',
      );
      assert.ok(
        allPaths.includes('/artifacts/results/query.json'),
        'Should have /artifacts/results/query.json',
      );
    });

    it('should handle root directory reads correctly', async () => {
      await using database = await sqlite.database();
      const dbPath = database.path;
      const rootFs = new SqliteFs({ dbPath, root: '/myroot' });

      // Create some files in the root
      await rootFs.writeFile('/file1.txt', 'content1');
      await rootFs.mkdir('/subdir');
      await rootFs.writeFile('/subdir/file2.txt', 'content2');

      // readdir of '/' should show files in root
      const entries = await rootFs.readdir('/');
      assert.ok(entries.includes('file1.txt'), 'Should list file1.txt');
      assert.ok(entries.includes('subdir'), 'Should list subdir');
    });

    it('should normalize root path variations', async () => {
      await using database = await sqlite.database();
      const dbPath = database.path;

      // Trailing slash should be normalized
      const fs1 = new SqliteFs({ dbPath, root: '/prefix/' });
      await fs1.writeFile('/test.txt', 'content');

      // No leading slash should add one
      const fs2 = new SqliteFs({ dbPath, root: 'prefix' });
      const content = await fs2.readFile('/test.txt');
      assert.strictEqual(content, 'content');

      // Relative path with ./ should normalize to /prefix
      const fs3 = new SqliteFs({ dbPath, root: './prefix' });
      const content3 = await fs3.readFile('/test.txt');
      assert.strictEqual(content3, 'content');

      // Verify actual storage path shows all variations access same data
      const rawFs = new SqliteFs({ dbPath, root: '/' });
      const allPaths = rawFs.getAllPaths();
      assert.ok(
        allPaths.includes('/prefix/test.txt'),
        'Should store at /prefix/test.txt',
      );
    });
  });
});
