import * as assert from 'node:assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { SqliteFs } from '@deepagents/text2sql';

describe('SqliteFs', () => {
  let tempDir: string;
  let sqliteFs: SqliteFs;

  before(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sqlite-fs-test-'));
    sqliteFs = new SqliteFs({
      dbPath: path.join(tempDir, 'test.db'),
      root: '/',
    });
  });

  after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe('file operations', () => {
    it('should write and read a file', async () => {
      const content = 'Hello, World!';
      await sqliteFs.writeFile('/test.txt', content);

      const result = await sqliteFs.readFile('/test.txt');
      assert.strictEqual(result, content);
    });

    it('should write and read binary content', async () => {
      const content = new Uint8Array([0x00, 0x01, 0x02, 0xff, 0xfe]);
      await sqliteFs.writeFile('/binary.bin', content);

      const result = await sqliteFs.readFileBuffer('/binary.bin');
      assert.deepStrictEqual(result, content);
    });

    it('should overwrite existing file', async () => {
      await sqliteFs.writeFile('/overwrite.txt', 'original');
      await sqliteFs.writeFile('/overwrite.txt', 'updated');

      const result = await sqliteFs.readFile('/overwrite.txt');
      assert.strictEqual(result, 'updated');
    });

    it('should append to file', async () => {
      await sqliteFs.writeFile('/append.txt', 'Hello');
      await sqliteFs.appendFile('/append.txt', ', World!');

      const result = await sqliteFs.readFile('/append.txt');
      assert.strictEqual(result, 'Hello, World!');
    });

    it('should throw on reading non-existent file', async () => {
      await assert.rejects(
        () => sqliteFs.readFile('/nonexistent.txt'),
        /ENOENT/,
      );
    });

    it('should auto-create parent directories on write', async () => {
      await sqliteFs.writeFile('/deep/nested/path/file.txt', 'content');

      const result = await sqliteFs.readFile('/deep/nested/path/file.txt');
      assert.strictEqual(result, 'content');

      // Verify directories were created
      assert.strictEqual(await sqliteFs.exists('/deep'), true);
      assert.strictEqual(await sqliteFs.exists('/deep/nested'), true);
      assert.strictEqual(await sqliteFs.exists('/deep/nested/path'), true);
    });
  });

  describe('large file chunking', () => {
    it('should handle files larger than chunk size', async () => {
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

  describe('directory operations', () => {
    it('should create directory', async () => {
      await sqliteFs.mkdir('/newdir');
      const stat = await sqliteFs.stat('/newdir');
      assert.strictEqual(stat.isDirectory, true);
    });

    it('should create directory recursively', async () => {
      await sqliteFs.mkdir('/a/b/c/d', { recursive: true });

      assert.strictEqual(await sqliteFs.exists('/a'), true);
      assert.strictEqual(await sqliteFs.exists('/a/b'), true);
      assert.strictEqual(await sqliteFs.exists('/a/b/c'), true);
      assert.strictEqual(await sqliteFs.exists('/a/b/c/d'), true);
    });

    it('should list directory contents', async () => {
      await sqliteFs.mkdir('/listdir');
      await sqliteFs.writeFile('/listdir/file1.txt', 'content1');
      await sqliteFs.writeFile('/listdir/file2.txt', 'content2');
      await sqliteFs.mkdir('/listdir/subdir');

      const entries = await sqliteFs.readdir('/listdir');
      assert.deepStrictEqual(
        entries.sort(),
        ['file1.txt', 'file2.txt', 'subdir'].sort(),
      );
    });

    it('should list directory with file types', async () => {
      await sqliteFs.mkdir('/typedir');
      await sqliteFs.writeFile('/typedir/file.txt', 'content');
      await sqliteFs.mkdir('/typedir/subdir');

      const entries = await sqliteFs.readdirWithFileTypes('/typedir');
      const fileEntry = entries.find((e) => e.name === 'file.txt');
      const dirEntry = entries.find((e) => e.name === 'subdir');

      assert.strictEqual(fileEntry?.isFile, true);
      assert.strictEqual(fileEntry?.isDirectory, false);
      assert.strictEqual(dirEntry?.isFile, false);
      assert.strictEqual(dirEntry?.isDirectory, true);
    });
  });

  describe('remove operations', () => {
    it('should remove file', async () => {
      await sqliteFs.writeFile('/toremove.txt', 'content');
      assert.strictEqual(await sqliteFs.exists('/toremove.txt'), true);

      await sqliteFs.rm('/toremove.txt');
      assert.strictEqual(await sqliteFs.exists('/toremove.txt'), false);
    });

    it('should remove directory recursively', async () => {
      await sqliteFs.mkdir('/rmdir');
      await sqliteFs.writeFile('/rmdir/file.txt', 'content');
      await sqliteFs.mkdir('/rmdir/subdir');
      await sqliteFs.writeFile('/rmdir/subdir/nested.txt', 'nested');

      await sqliteFs.rm('/rmdir', { recursive: true });
      assert.strictEqual(await sqliteFs.exists('/rmdir'), false);
    });

    it('should not throw on force remove of non-existent', async () => {
      await sqliteFs.rm('/nonexistent', { force: true });
      // Should not throw
    });
  });

  describe('copy and move operations', () => {
    it('should copy file', async () => {
      await sqliteFs.writeFile('/original.txt', 'original content');
      await sqliteFs.cp('/original.txt', '/copied.txt');

      const result = await sqliteFs.readFile('/copied.txt');
      assert.strictEqual(result, 'original content');
    });

    it('should copy directory recursively', async () => {
      await sqliteFs.mkdir('/srcdir');
      await sqliteFs.writeFile('/srcdir/file.txt', 'content');
      await sqliteFs.mkdir('/srcdir/nested');
      await sqliteFs.writeFile('/srcdir/nested/deep.txt', 'deep');

      await sqliteFs.cp('/srcdir', '/destdir', { recursive: true });

      assert.strictEqual(await sqliteFs.exists('/destdir'), true);
      assert.strictEqual(
        await sqliteFs.readFile('/destdir/file.txt'),
        'content',
      );
      assert.strictEqual(
        await sqliteFs.readFile('/destdir/nested/deep.txt'),
        'deep',
      );
    });

    it('should move file', async () => {
      await sqliteFs.writeFile('/tomove.txt', 'moving');
      await sqliteFs.mv('/tomove.txt', '/moved.txt');

      assert.strictEqual(await sqliteFs.exists('/tomove.txt'), false);
      assert.strictEqual(await sqliteFs.readFile('/moved.txt'), 'moving');
    });
  });

  describe('stat operations', () => {
    it('should return file stats', async () => {
      await sqliteFs.writeFile('/statfile.txt', 'content');
      const stat = await sqliteFs.stat('/statfile.txt');

      assert.strictEqual(stat.isFile, true);
      assert.strictEqual(stat.isDirectory, false);
      assert.strictEqual(stat.size, 7); // 'content'.length
    });

    it('should return directory stats', async () => {
      await sqliteFs.mkdir('/statdir');
      const stat = await sqliteFs.stat('/statdir');

      assert.strictEqual(stat.isFile, false);
      assert.strictEqual(stat.isDirectory, true);
    });

    it('should change file mode', async () => {
      await sqliteFs.writeFile('/modefile.txt', 'content');
      await sqliteFs.chmod('/modefile.txt', 0o755);

      const stat = await sqliteFs.stat('/modefile.txt');
      assert.strictEqual(stat.mode, 0o755);
    });
  });

  describe('symlink operations', () => {
    it('should create and read symlink', async () => {
      await sqliteFs.writeFile('/target.txt', 'target content');
      await sqliteFs.symlink('/target.txt', '/link.txt');

      // readlink should return the target
      const target = await sqliteFs.readlink('/link.txt');
      assert.strictEqual(target, '/target.txt');

      // Reading through symlink should work
      const content = await sqliteFs.readFile('/link.txt');
      assert.strictEqual(content, 'target content');
    });

    it('should distinguish lstat from stat for symlinks', async () => {
      await sqliteFs.writeFile('/lstat-target.txt', 'content');
      await sqliteFs.symlink('/lstat-target.txt', '/lstat-link.txt');

      const stat = await sqliteFs.stat('/lstat-link.txt');
      assert.strictEqual(stat.isSymbolicLink, false); // stat follows symlinks

      const lstat = await sqliteFs.lstat('/lstat-link.txt');
      assert.strictEqual(lstat.isSymbolicLink, true); // lstat does not follow
    });
  });

  describe('path operations', () => {
    it('should resolve paths', () => {
      assert.strictEqual(sqliteFs.resolvePath('/home', 'user'), '/home/user');
      assert.strictEqual(sqliteFs.resolvePath('/home/user', '..'), '/home');
      assert.strictEqual(
        sqliteFs.resolvePath('/home', '/absolute'),
        '/absolute',
      );
    });

    it('should get all paths', async () => {
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
      const dbPath = path.join(tempDir, 'persist.db');

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
      const dbPath = path.join(tempDir, 'root-test.db');
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
      const dbPath = path.join(tempDir, 'root-init.db');
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
      const dbPath = path.join(tempDir, 'multi-root.db');

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
      const dbPath = path.join(tempDir, 'nested-root.db');
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
      const dbPath = path.join(tempDir, 'root-read.db');
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
      const dbPath = path.join(tempDir, 'normalize-root.db');

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
