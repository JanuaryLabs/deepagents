import * as assert from 'node:assert';
import { describe, it } from 'node:test';
import pg from 'pg';

import { withPostgresContainer } from '@deepagents/test';
import { PostgresFs } from '@deepagents/text2sql';

describe('PostgresFs', () => {
  describe('file operations', () => {
    it('should write and read a file', async () =>
      await withPostgresContainer(async (container) => {
        const fs = new PostgresFs({
          pool: container.connectionString,
          root: '/',
        });
        await fs.initialize();
        try {
          await fs.writeFile('/test.txt', 'Hello, World!');

          const result = await fs.readFile('/test.txt');
          assert.strictEqual(result, 'Hello, World!');
        } finally {
          await fs.close();
        }
      }));

    it('should write and read binary content', async () =>
      await withPostgresContainer(async (container) => {
        const fs = new PostgresFs({
          pool: container.connectionString,
          root: '/',
        });
        await fs.initialize();
        try {
          const content = new Uint8Array([0x00, 0x01, 0x02, 0xff, 0xfe]);
          await fs.writeFile('/binary.bin', content);

          const result = await fs.readFileBuffer('/binary.bin');
          assert.deepStrictEqual(result, content);
        } finally {
          await fs.close();
        }
      }));

    it('should overwrite existing file', async () =>
      await withPostgresContainer(async (container) => {
        const fs = new PostgresFs({
          pool: container.connectionString,
          root: '/',
        });
        await fs.initialize();
        try {
          await fs.writeFile('/overwrite.txt', 'original');
          await fs.writeFile('/overwrite.txt', 'updated');

          const result = await fs.readFile('/overwrite.txt');
          assert.strictEqual(result, 'updated');
        } finally {
          await fs.close();
        }
      }));

    it('should append to file', async () =>
      await withPostgresContainer(async (container) => {
        const fs = new PostgresFs({
          pool: container.connectionString,
          root: '/',
        });
        await fs.initialize();
        try {
          await fs.writeFile('/append.txt', 'Hello');
          await fs.appendFile('/append.txt', ', World!');

          const result = await fs.readFile('/append.txt');
          assert.strictEqual(result, 'Hello, World!');
        } finally {
          await fs.close();
        }
      }));

    it('should accumulate data across multiple appends', async () =>
      await withPostgresContainer(async (container) => {
        const fs = new PostgresFs({
          pool: container.connectionString,
          root: '/',
        });
        await fs.initialize();
        try {
          await fs.writeFile('/multi.txt', '');
          for (let i = 0; i < 5; i++) {
            await fs.appendFile('/multi.txt', `[${i}]`);
          }

          const result = await fs.readFile('/multi.txt');
          assert.strictEqual(result, '[0][1][2][3][4]');
        } finally {
          await fs.close();
        }
      }));

    it('should throw on reading non-existent file', async () =>
      await withPostgresContainer(async (container) => {
        const fs = new PostgresFs({
          pool: container.connectionString,
          root: '/',
        });
        await fs.initialize();
        try {
          await assert.rejects(() => fs.readFile('/nonexistent.txt'), /ENOENT/);
        } finally {
          await fs.close();
        }
      }));

    it('should write and read empty file', async () =>
      await withPostgresContainer(async (container) => {
        const fs = new PostgresFs({
          pool: container.connectionString,
          root: '/',
        });
        await fs.initialize();
        try {
          await fs.writeFile('/empty.txt', '');

          const result = await fs.readFile('/empty.txt');
          assert.strictEqual(result, '');

          const stat = await fs.stat('/empty.txt');
          assert.strictEqual(stat.size, 0);
        } finally {
          await fs.close();
        }
      }));

    it('should throw EISDIR when reading a directory', async () =>
      await withPostgresContainer(async (container) => {
        const fs = new PostgresFs({
          pool: container.connectionString,
          root: '/',
        });
        await fs.initialize();
        try {
          await fs.mkdir('/adir');

          await assert.rejects(() => fs.readFile('/adir'), /EISDIR/);
        } finally {
          await fs.close();
        }
      }));

    it('should append to non-existent file creating it', async () =>
      await withPostgresContainer(async (container) => {
        const fs = new PostgresFs({
          pool: container.connectionString,
          root: '/',
        });
        await fs.initialize();
        try {
          await fs.appendFile('/brand-new.txt', 'created via append');

          const result = await fs.readFile('/brand-new.txt');
          assert.strictEqual(result, 'created via append');
        } finally {
          await fs.close();
        }
      }));

    it('should throw when appending to a directory', async () =>
      await withPostgresContainer(async (container) => {
        const fs = new PostgresFs({
          pool: container.connectionString,
          root: '/',
        });
        await fs.initialize();
        try {
          await fs.mkdir('/appenddir');

          await assert.rejects(
            () => fs.appendFile('/appenddir', 'data'),
            /not a file/,
          );
        } finally {
          await fs.close();
        }
      }));

    it('should auto-create parent directories on write', async () =>
      await withPostgresContainer(async (container) => {
        const fs = new PostgresFs({
          pool: container.connectionString,
          root: '/',
        });
        await fs.initialize();
        try {
          await fs.writeFile('/deep/nested/path/file.txt', 'content');

          const result = await fs.readFile('/deep/nested/path/file.txt');
          assert.strictEqual(result, 'content');

          assert.strictEqual(await fs.exists('/deep'), true);
          assert.strictEqual(await fs.exists('/deep/nested'), true);
          assert.strictEqual(await fs.exists('/deep/nested/path'), true);
        } finally {
          await fs.close();
        }
      }));
  });

  describe('large file chunking', () => {
    it('should handle files larger than chunk size', async () =>
      await withPostgresContainer(async (container) => {
        const chunkSize = 1024;
        const fs = new PostgresFs({
          pool: container.connectionString,
          root: '/',
          chunkSize,
        });
        await fs.initialize();
        try {
          const size = chunkSize * 3 + 500;
          const content = new Uint8Array(size);
          for (let i = 0; i < size; i++) {
            content[i] = i % 256;
          }

          await fs.writeFile('/large.bin', content);

          const result = await fs.readFileBuffer('/large.bin');
          assert.strictEqual(result.length, size);
          assert.deepStrictEqual(result, content);
        } finally {
          await fs.close();
        }
      }));
  });

  describe('directory operations', () => {
    it('should create directory', async () =>
      await withPostgresContainer(async (container) => {
        const fs = new PostgresFs({
          pool: container.connectionString,
          root: '/',
        });
        await fs.initialize();
        try {
          await fs.mkdir('/newdir');
          const stat = await fs.stat('/newdir');
          assert.strictEqual(stat.isDirectory, true);
        } finally {
          await fs.close();
        }
      }));

    it('should create directory recursively', async () =>
      await withPostgresContainer(async (container) => {
        const fs = new PostgresFs({
          pool: container.connectionString,
          root: '/',
        });
        await fs.initialize();
        try {
          await fs.mkdir('/a/b/c/d', { recursive: true });

          assert.strictEqual(await fs.exists('/a'), true);
          assert.strictEqual(await fs.exists('/a/b'), true);
          assert.strictEqual(await fs.exists('/a/b/c'), true);
          assert.strictEqual(await fs.exists('/a/b/c/d'), true);
        } finally {
          await fs.close();
        }
      }));

    it('should list directory contents', async () =>
      await withPostgresContainer(async (container) => {
        const fs = new PostgresFs({
          pool: container.connectionString,
          root: '/',
        });
        await fs.initialize();
        try {
          await fs.mkdir('/listdir');
          await fs.writeFile('/listdir/file1.txt', 'content1');
          await fs.writeFile('/listdir/file2.txt', 'content2');
          await fs.mkdir('/listdir/subdir');

          const entries = await fs.readdir('/listdir');
          assert.deepStrictEqual(
            entries.sort(),
            ['file1.txt', 'file2.txt', 'subdir'].sort(),
          );
        } finally {
          await fs.close();
        }
      }));

    it('should list directory with file types', async () =>
      await withPostgresContainer(async (container) => {
        const fs = new PostgresFs({
          pool: container.connectionString,
          root: '/',
        });
        await fs.initialize();
        try {
          await fs.mkdir('/typedir');
          await fs.writeFile('/typedir/file.txt', 'content');
          await fs.mkdir('/typedir/subdir');

          const entries = await fs.readdirWithFileTypes('/typedir');
          const fileEntry = entries.find((e) => e.name === 'file.txt');
          const dirEntry = entries.find((e) => e.name === 'subdir');

          assert.strictEqual(fileEntry?.isFile, true);
          assert.strictEqual(fileEntry?.isDirectory, false);
          assert.strictEqual(dirEntry?.isFile, false);
          assert.strictEqual(dirEntry?.isDirectory, true);
        } finally {
          await fs.close();
        }
      }));

    it('should throw EEXIST on non-recursive mkdir of existing path', async () =>
      await withPostgresContainer(async (container) => {
        const fs = new PostgresFs({
          pool: container.connectionString,
          root: '/',
        });
        await fs.initialize();
        try {
          await fs.mkdir('/existing');

          await assert.rejects(() => fs.mkdir('/existing'), /EEXIST/);
        } finally {
          await fs.close();
        }
      }));

    it('should throw ENOENT on readdir of non-existent path', async () =>
      await withPostgresContainer(async (container) => {
        const fs = new PostgresFs({
          pool: container.connectionString,
          root: '/',
        });
        await fs.initialize();
        try {
          await assert.rejects(() => fs.readdir('/ghost'), /ENOENT/);
        } finally {
          await fs.close();
        }
      }));

    it('should throw ENOTDIR on readdir of a file', async () =>
      await withPostgresContainer(async (container) => {
        const fs = new PostgresFs({
          pool: container.connectionString,
          root: '/',
        });
        await fs.initialize();
        try {
          await fs.writeFile('/notadir.txt', 'content');

          await assert.rejects(() => fs.readdir('/notadir.txt'), /ENOTDIR/);
        } finally {
          await fs.close();
        }
      }));

    it('should return empty array for readdir of empty directory', async () =>
      await withPostgresContainer(async (container) => {
        const fs = new PostgresFs({
          pool: container.connectionString,
          root: '/',
        });
        await fs.initialize();
        try {
          await fs.mkdir('/emptydir');

          const entries = await fs.readdir('/emptydir');
          assert.deepStrictEqual(entries, []);
        } finally {
          await fs.close();
        }
      }));
  });

  describe('remove operations', () => {
    it('should remove file', async () =>
      await withPostgresContainer(async (container) => {
        const fs = new PostgresFs({
          pool: container.connectionString,
          root: '/',
        });
        await fs.initialize();
        try {
          await fs.writeFile('/toremove.txt', 'content');
          assert.strictEqual(await fs.exists('/toremove.txt'), true);

          await fs.rm('/toremove.txt');
          assert.strictEqual(await fs.exists('/toremove.txt'), false);
        } finally {
          await fs.close();
        }
      }));

    it('should remove directory recursively', async () =>
      await withPostgresContainer(async (container) => {
        const fs = new PostgresFs({
          pool: container.connectionString,
          root: '/',
        });
        await fs.initialize();
        try {
          await fs.mkdir('/rmdir');
          await fs.writeFile('/rmdir/file.txt', 'content');
          await fs.mkdir('/rmdir/subdir');
          await fs.writeFile('/rmdir/subdir/nested.txt', 'nested');

          await fs.rm('/rmdir', { recursive: true });
          assert.strictEqual(await fs.exists('/rmdir'), false);
        } finally {
          await fs.close();
        }
      }));

    it('should not throw on force remove of non-existent', async () =>
      await withPostgresContainer(async (container) => {
        const fs = new PostgresFs({
          pool: container.connectionString,
          root: '/',
        });
        await fs.initialize();
        try {
          await fs.rm('/nonexistent', { force: true });
        } finally {
          await fs.close();
        }
      }));

    it('should throw ENOTEMPTY on rm non-empty dir without recursive', async () =>
      await withPostgresContainer(async (container) => {
        const fs = new PostgresFs({
          pool: container.connectionString,
          root: '/',
        });
        await fs.initialize();
        try {
          await fs.mkdir('/notempty');
          await fs.writeFile('/notempty/child.txt', 'data');

          await assert.rejects(() => fs.rm('/notempty'), /ENOTEMPTY/);
        } finally {
          await fs.close();
        }
      }));

    it('should throw ENOENT on rm non-existent without force', async () =>
      await withPostgresContainer(async (container) => {
        const fs = new PostgresFs({
          pool: container.connectionString,
          root: '/',
        });
        await fs.initialize();
        try {
          await assert.rejects(() => fs.rm('/does-not-exist'), /ENOENT/);
        } finally {
          await fs.close();
        }
      }));
  });

  describe('copy and move operations', () => {
    it('should copy file', async () =>
      await withPostgresContainer(async (container) => {
        const fs = new PostgresFs({
          pool: container.connectionString,
          root: '/',
        });
        await fs.initialize();
        try {
          await fs.writeFile('/original.txt', 'original content');
          await fs.cp('/original.txt', '/copied.txt');

          const result = await fs.readFile('/copied.txt');
          assert.strictEqual(result, 'original content');
        } finally {
          await fs.close();
        }
      }));

    it('should copy directory recursively', async () =>
      await withPostgresContainer(async (container) => {
        const fs = new PostgresFs({
          pool: container.connectionString,
          root: '/',
        });
        await fs.initialize();
        try {
          await fs.mkdir('/srcdir');
          await fs.writeFile('/srcdir/file.txt', 'content');
          await fs.mkdir('/srcdir/nested');
          await fs.writeFile('/srcdir/nested/deep.txt', 'deep');

          await fs.cp('/srcdir', '/destdir', { recursive: true });

          assert.strictEqual(await fs.exists('/destdir'), true);
          assert.strictEqual(await fs.readFile('/destdir/file.txt'), 'content');
          assert.strictEqual(
            await fs.readFile('/destdir/nested/deep.txt'),
            'deep',
          );
        } finally {
          await fs.close();
        }
      }));

    it('should move file', async () =>
      await withPostgresContainer(async (container) => {
        const fs = new PostgresFs({
          pool: container.connectionString,
          root: '/',
        });
        await fs.initialize();
        try {
          await fs.writeFile('/tomove.txt', 'moving');
          await fs.mv('/tomove.txt', '/moved.txt');

          assert.strictEqual(await fs.exists('/tomove.txt'), false);
          assert.strictEqual(await fs.readFile('/moved.txt'), 'moving');
        } finally {
          await fs.close();
        }
      }));

    it('should overwrite existing file on move', async () =>
      await withPostgresContainer(async (container) => {
        const fs = new PostgresFs({
          pool: container.connectionString,
          root: '/',
        });
        await fs.initialize();
        try {
          await fs.writeFile('/src.txt', 'new content');
          await fs.writeFile('/dest.txt', 'old content');
          await fs.mv('/src.txt', '/dest.txt');

          assert.strictEqual(await fs.exists('/src.txt'), false);
          assert.strictEqual(await fs.readFile('/dest.txt'), 'new content');
        } finally {
          await fs.close();
        }
      }));

    it('should overwrite existing directory on move', async () =>
      await withPostgresContainer(async (container) => {
        const fs = new PostgresFs({
          pool: container.connectionString,
          root: '/',
        });
        await fs.initialize();
        try {
          await fs.mkdir('/src');
          await fs.writeFile('/src/a.txt', 'alpha');

          await fs.mkdir('/dest');
          await fs.writeFile('/dest/old.txt', 'stale');

          await fs.mv('/src', '/dest');

          assert.strictEqual(await fs.exists('/src'), false);
          assert.strictEqual(await fs.readFile('/dest/a.txt'), 'alpha');
          assert.strictEqual(await fs.exists('/dest/old.txt'), false);
        } finally {
          await fs.close();
        }
      }));

    it('should throw ENOENT when copying non-existent source', async () =>
      await withPostgresContainer(async (container) => {
        const fs = new PostgresFs({
          pool: container.connectionString,
          root: '/',
        });
        await fs.initialize();
        try {
          await assert.rejects(
            () => fs.cp('/ghost.txt', '/dest.txt'),
            /ENOENT/,
          );
        } finally {
          await fs.close();
        }
      }));

    it('should throw when copying directory without recursive', async () =>
      await withPostgresContainer(async (container) => {
        const fs = new PostgresFs({
          pool: container.connectionString,
          root: '/',
        });
        await fs.initialize();
        try {
          await fs.mkdir('/cpdir');

          await assert.rejects(
            () => fs.cp('/cpdir', '/cpdir2'),
            /not specified/,
          );
        } finally {
          await fs.close();
        }
      }));

    it('should copy file overwriting existing destination', async () =>
      await withPostgresContainer(async (container) => {
        const fs = new PostgresFs({
          pool: container.connectionString,
          root: '/',
        });
        await fs.initialize();
        try {
          await fs.writeFile('/src-cp.txt', 'new data');
          await fs.writeFile('/dest-cp.txt', 'old data');
          await fs.cp('/src-cp.txt', '/dest-cp.txt');

          assert.strictEqual(await fs.readFile('/dest-cp.txt'), 'new data');
          assert.strictEqual(await fs.readFile('/src-cp.txt'), 'new data');
        } finally {
          await fs.close();
        }
      }));

    it('should throw ENOENT when moving non-existent source', async () =>
      await withPostgresContainer(async (container) => {
        const fs = new PostgresFs({
          pool: container.connectionString,
          root: '/',
        });
        await fs.initialize();
        try {
          await assert.rejects(
            () => fs.mv('/ghost.txt', '/dest.txt'),
            /ENOENT/,
          );
        } finally {
          await fs.close();
        }
      }));

    it('should move directory to new path', async () =>
      await withPostgresContainer(async (container) => {
        const fs = new PostgresFs({
          pool: container.connectionString,
          root: '/',
        });
        await fs.initialize();
        try {
          await fs.mkdir('/mvdir');
          await fs.writeFile('/mvdir/file.txt', 'inside');
          await fs.mkdir('/mvdir/sub');
          await fs.writeFile('/mvdir/sub/nested.txt', 'deep');

          await fs.mv('/mvdir', '/moved-dir');

          assert.strictEqual(await fs.exists('/mvdir'), false);
          assert.strictEqual(
            await fs.readFile('/moved-dir/file.txt'),
            'inside',
          );
          assert.strictEqual(
            await fs.readFile('/moved-dir/sub/nested.txt'),
            'deep',
          );
        } finally {
          await fs.close();
        }
      }));
  });

  describe('stat operations', () => {
    it('should return file stats', async () =>
      await withPostgresContainer(async (container) => {
        const fs = new PostgresFs({
          pool: container.connectionString,
          root: '/',
        });
        await fs.initialize();
        try {
          await fs.writeFile('/statfile.txt', 'content');
          const stat = await fs.stat('/statfile.txt');

          assert.strictEqual(stat.isFile, true);
          assert.strictEqual(stat.isDirectory, false);
          assert.strictEqual(stat.size, 7);
        } finally {
          await fs.close();
        }
      }));

    it('should return directory stats', async () =>
      await withPostgresContainer(async (container) => {
        const fs = new PostgresFs({
          pool: container.connectionString,
          root: '/',
        });
        await fs.initialize();
        try {
          await fs.mkdir('/statdir');
          const stat = await fs.stat('/statdir');

          assert.strictEqual(stat.isFile, false);
          assert.strictEqual(stat.isDirectory, true);
        } finally {
          await fs.close();
        }
      }));

    it('should change file mode', async () =>
      await withPostgresContainer(async (container) => {
        const fs = new PostgresFs({
          pool: container.connectionString,
          root: '/',
        });
        await fs.initialize();
        try {
          await fs.writeFile('/modefile.txt', 'content');
          await fs.chmod('/modefile.txt', 0o755);

          const stat = await fs.stat('/modefile.txt');
          assert.strictEqual(stat.mode, 0o755);
        } finally {
          await fs.close();
        }
      }));
  });

  describe('symlink operations', () => {
    it('should create and read symlink', async () =>
      await withPostgresContainer(async (container) => {
        const fs = new PostgresFs({
          pool: container.connectionString,
          root: '/',
        });
        await fs.initialize();
        try {
          await fs.writeFile('/target.txt', 'target content');
          await fs.symlink('/target.txt', '/link.txt');

          const target = await fs.readlink('/link.txt');
          assert.strictEqual(target, '/target.txt');

          const content = await fs.readFile('/link.txt');
          assert.strictEqual(content, 'target content');
        } finally {
          await fs.close();
        }
      }));

    it('should distinguish lstat from stat for symlinks', async () =>
      await withPostgresContainer(async (container) => {
        const fs = new PostgresFs({
          pool: container.connectionString,
          root: '/',
        });
        await fs.initialize();
        try {
          await fs.writeFile('/lstat-target.txt', 'content');
          await fs.symlink('/lstat-target.txt', '/lstat-link.txt');

          const stat = await fs.stat('/lstat-link.txt');
          assert.strictEqual(stat.isSymbolicLink, false);

          const lstat = await fs.lstat('/lstat-link.txt');
          assert.strictEqual(lstat.isSymbolicLink, true);
        } finally {
          await fs.close();
        }
      }));
  });

  describe('root option', () => {
    it('should prefix paths with root', async () =>
      await withPostgresContainer(async (container) => {
        const fs = new PostgresFs({
          pool: container.connectionString,
          root: '/prefix',
        });
        await fs.initialize();
        try {
          await fs.writeFile('/file.txt', 'prefixed content');

          const content = await fs.readFile('/file.txt');
          assert.strictEqual(content, 'prefixed content');

          const allPaths = await fs.getAllPathsAsync();
          assert.ok(
            allPaths.includes('/prefix'),
            'Should have /prefix directory',
          );
          assert.ok(
            allPaths.includes('/prefix/file.txt'),
            'Should have /prefix/file.txt',
          );
        } finally {
          await fs.close();
        }
      }));

    it('should create root directory structure on initialization', async () =>
      await withPostgresContainer(async (container) => {
        const fs = new PostgresFs({
          pool: container.connectionString,
          root: '/chat/123/results',
        });
        await fs.initialize();
        try {
          const allPaths = await fs.getAllPathsAsync();

          assert.ok(allPaths.includes('/chat'), 'Should have /chat');
          assert.ok(allPaths.includes('/chat/123'), 'Should have /chat/123');
          assert.ok(
            allPaths.includes('/chat/123/results'),
            'Should have /chat/123/results',
          );
        } finally {
          await fs.close();
        }
      }));

    it('should isolate two instances with different roots', async () =>
      await withPostgresContainer(async (container) => {
        const pool = new pg.Pool({
          connectionString: container.connectionString,
        });
        try {
          const fs1 = new PostgresFs({ pool, root: '/chat-1' });
          await fs1.initialize();
          const fs2 = new PostgresFs({ pool, root: '/chat-2' });
          await fs2.initialize();

          await fs1.writeFile('/data.json', '{"chat": 1}');
          await fs2.writeFile('/data.json', '{"chat": 2}');

          assert.strictEqual(await fs1.readFile('/data.json'), '{"chat": 1}');
          assert.strictEqual(await fs2.readFile('/data.json'), '{"chat": 2}');

          await fs1.close();
          await fs2.close();
        } finally {
          await pool.end();
        }
      }));
  });

  describe('pool injection', () => {
    it('should accept a pre-existing Pool', async () =>
      await withPostgresContainer(async (container) => {
        const pool = new pg.Pool({
          connectionString: container.connectionString,
        });
        try {
          const fs = new PostgresFs({ pool, root: '/' });
          await fs.initialize();
          try {
            await fs.writeFile('/pool-test.txt', 'injected pool');

            const content = await fs.readFile('/pool-test.txt');
            assert.strictEqual(content, 'injected pool');
          } finally {
            await fs.close();
          }

          const result = await pool.query('SELECT 1 AS val');
          assert.strictEqual(result.rows[0].val, 1);
        } finally {
          await pool.end();
        }
      }));

    it('should not close external pool on close()', async () =>
      await withPostgresContainer(async (container) => {
        const pool = new pg.Pool({
          connectionString: container.connectionString,
        });
        try {
          const fs = new PostgresFs({ pool, root: '/' });
          await fs.initialize();
          await fs.writeFile('/no-close.txt', 'data');
          await fs.close();

          const result = await pool.query('SELECT 1 AS val');
          assert.strictEqual(result.rows[0].val, 1);
        } finally {
          await pool.end();
        }
      }));
  });

  describe('schema support', () => {
    it('should create tables in a custom schema', async () =>
      await withPostgresContainer(async (container) => {
        const fs = new PostgresFs({
          pool: container.connectionString,
          root: '/',
          schema: 'custom_fs_schema',
        });
        await fs.initialize();
        try {
          await fs.writeFile('/schema-test.txt', 'custom schema data');

          const content = await fs.readFile('/schema-test.txt');
          assert.strictEqual(content, 'custom schema data');

          const pool = new pg.Pool({
            connectionString: container.connectionString,
          });
          try {
            const result = await pool.query(`
              SELECT table_schema, table_name
              FROM information_schema.tables
              WHERE table_schema = 'custom_fs_schema'
            `);
            assert.ok(result.rows.length > 0);
            assert.ok(
              result.rows.every(
                (r: { table_schema: string }) =>
                  r.table_schema === 'custom_fs_schema',
              ),
            );
          } finally {
            await pool.end();
          }
        } finally {
          await fs.close();
        }
      }));

    it('should handle idempotent initialization', async () =>
      await withPostgresContainer(async (container) => {
        const fs = new PostgresFs({
          pool: container.connectionString,
          root: '/',
          schema: 'idempotent_fs_schema',
        });
        await fs.initialize();
        await fs.initialize();
        try {
          await fs.writeFile('/test.txt', 'idempotent');
          const content = await fs.readFile('/test.txt');
          assert.strictEqual(content, 'idempotent');
        } finally {
          await fs.close();
        }
      }));

    it('should create schema in information_schema.schemata', async () =>
      await withPostgresContainer(async (container) => {
        const fs = new PostgresFs({
          pool: container.connectionString,
          root: '/',
          schema: 'ddl_created_fs_schema',
        });
        await fs.initialize();
        try {
          const pool = new pg.Pool({
            connectionString: container.connectionString,
          });
          try {
            const result = await pool.query(`
              SELECT schema_name FROM information_schema.schemata
              WHERE schema_name = 'ddl_created_fs_schema'
            `);
            assert.strictEqual(result.rows.length, 1);
            assert.strictEqual(
              result.rows[0].schema_name,
              'ddl_created_fs_schema',
            );
          } finally {
            await pool.end();
          }
        } finally {
          await fs.close();
        }
      }));
  });

  describe('link operations', () => {
    it('should create hard link and read from both paths', async () =>
      await withPostgresContainer(async (container) => {
        const fs = new PostgresFs({
          pool: container.connectionString,
          root: '/',
        });
        await fs.initialize();
        try {
          await fs.writeFile('/link-src.txt', 'shared content');
          await fs.link('/link-src.txt', '/link-dest.txt');

          assert.strictEqual(
            await fs.readFile('/link-dest.txt'),
            'shared content',
          );
          assert.strictEqual(
            await fs.readFile('/link-src.txt'),
            'shared content',
          );
        } finally {
          await fs.close();
        }
      }));

    it('should throw ENOENT when link source does not exist', async () =>
      await withPostgresContainer(async (container) => {
        const fs = new PostgresFs({
          pool: container.connectionString,
          root: '/',
        });
        await fs.initialize();
        try {
          await assert.rejects(
            () => fs.link('/no-source.txt', '/link-dest.txt'),
            /ENOENT/,
          );
        } finally {
          await fs.close();
        }
      }));

    it('should throw EEXIST when link destination already exists', async () =>
      await withPostgresContainer(async (container) => {
        const fs = new PostgresFs({
          pool: container.connectionString,
          root: '/',
        });
        await fs.initialize();
        try {
          await fs.writeFile('/link-a.txt', 'a');
          await fs.writeFile('/link-b.txt', 'b');

          await assert.rejects(
            () => fs.link('/link-a.txt', '/link-b.txt'),
            /EEXIST/,
          );
        } finally {
          await fs.close();
        }
      }));

    it('should throw when linking a directory', async () =>
      await withPostgresContainer(async (container) => {
        const fs = new PostgresFs({
          pool: container.connectionString,
          root: '/',
        });
        await fs.initialize();
        try {
          await fs.mkdir('/linkdir');

          await assert.rejects(
            () => fs.link('/linkdir', '/linkdir2'),
            /not supported for directories/,
          );
        } finally {
          await fs.close();
        }
      }));
  });

  describe('realpath and utimes', () => {
    it('should return canonical path for a file', async () =>
      await withPostgresContainer(async (container) => {
        const fs = new PostgresFs({
          pool: container.connectionString,
          root: '/',
        });
        await fs.initialize();
        try {
          await fs.writeFile('/real.txt', 'content');

          const resolved = await fs.realpath('/real.txt');
          assert.strictEqual(resolved, '/real.txt');
        } finally {
          await fs.close();
        }
      }));

    it('should resolve symlink to physical path', async () =>
      await withPostgresContainer(async (container) => {
        const fs = new PostgresFs({
          pool: container.connectionString,
          root: '/',
        });
        await fs.initialize();
        try {
          await fs.writeFile('/real-target.txt', 'data');
          await fs.symlink('/real-target.txt', '/real-link.txt');

          const resolved = await fs.realpath('/real-link.txt');
          assert.strictEqual(resolved, '/real-target.txt');
        } finally {
          await fs.close();
        }
      }));

    it('should throw ENOENT for realpath of non-existent path', async () =>
      await withPostgresContainer(async (container) => {
        const fs = new PostgresFs({
          pool: container.connectionString,
          root: '/',
        });
        await fs.initialize();
        try {
          await assert.rejects(() => fs.realpath('/nope.txt'), /ENOENT/);
        } finally {
          await fs.close();
        }
      }));

    it('should set mtime via utimes and verify via stat', async () =>
      await withPostgresContainer(async (container) => {
        const fs = new PostgresFs({
          pool: container.connectionString,
          root: '/',
        });
        await fs.initialize();
        try {
          await fs.writeFile('/timed.txt', 'content');

          const targetDate = new Date('2024-06-15T12:00:00Z');
          await fs.utimes('/timed.txt', new Date(), targetDate);

          const stat = await fs.stat('/timed.txt');
          assert.strictEqual(stat.mtime.getTime(), targetDate.getTime());
        } finally {
          await fs.close();
        }
      }));

    it('should throw ENOENT on utimes of non-existent path', async () =>
      await withPostgresContainer(async (container) => {
        const fs = new PostgresFs({
          pool: container.connectionString,
          root: '/',
        });
        await fs.initialize();
        try {
          await assert.rejects(
            () => fs.utimes('/nope.txt', new Date(), new Date()),
            /ENOENT/,
          );
        } finally {
          await fs.close();
        }
      }));
  });

  describe('symlink edge cases', () => {
    it('should throw EEXIST when creating symlink at existing path', async () =>
      await withPostgresContainer(async (container) => {
        const fs = new PostgresFs({
          pool: container.connectionString,
          root: '/',
        });
        await fs.initialize();
        try {
          await fs.writeFile('/sym-target.txt', 'data');
          await fs.writeFile('/sym-existing.txt', 'occupied');

          await assert.rejects(
            () => fs.symlink('/sym-target.txt', '/sym-existing.txt'),
            /EEXIST/,
          );
        } finally {
          await fs.close();
        }
      }));

    it('should throw when readlink on a regular file', async () =>
      await withPostgresContainer(async (container) => {
        const fs = new PostgresFs({
          pool: container.connectionString,
          root: '/',
        });
        await fs.initialize();
        try {
          await fs.writeFile('/regular.txt', 'not a link');

          await assert.rejects(
            () => fs.readlink('/regular.txt'),
            /not a symbolic link/,
          );
        } finally {
          await fs.close();
        }
      }));

    it('should throw ENOENT on stat of non-existent path', async () =>
      await withPostgresContainer(async (container) => {
        const fs = new PostgresFs({
          pool: container.connectionString,
          root: '/',
        });
        await fs.initialize();
        try {
          await assert.rejects(
            () => fs.stat('/nonexistent-stat.txt'),
            /ENOENT/,
          );
        } finally {
          await fs.close();
        }
      }));
  });
});
