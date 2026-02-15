import sql from 'mssql';
import * as assert from 'node:assert';
import { describe, it } from 'node:test';

import { withSqlServerContainer } from '@deepagents/test';
import { MssqlFs } from '@deepagents/text2sql';

describe('MssqlFs', () => {
  describe('file operations', () => {
    it('should write and read a file', () =>
      withSqlServerContainer(async (container) => {
        const fs = new MssqlFs({
          pool: container.connectionString,
          root: '/',
        });
        try {
          await fs.writeFile('/test.txt', 'Hello, World!');

          const result = await fs.readFile('/test.txt');
          assert.strictEqual(result, 'Hello, World!');
        } finally {
          await fs.close();
        }
      }));

    it('should write and read binary content', () =>
      withSqlServerContainer(async (container) => {
        const fs = new MssqlFs({
          pool: container.connectionString,
          root: '/',
        });
        try {
          const content = new Uint8Array([0x00, 0x01, 0x02, 0xff, 0xfe]);
          await fs.writeFile('/binary.bin', content);

          const result = await fs.readFileBuffer('/binary.bin');
          assert.deepStrictEqual(result, content);
        } finally {
          await fs.close();
        }
      }));

    it('should overwrite existing file', () =>
      withSqlServerContainer(async (container) => {
        const fs = new MssqlFs({
          pool: container.connectionString,
          root: '/',
        });
        try {
          await fs.writeFile('/overwrite.txt', 'original');
          await fs.writeFile('/overwrite.txt', 'updated');

          const result = await fs.readFile('/overwrite.txt');
          assert.strictEqual(result, 'updated');
        } finally {
          await fs.close();
        }
      }));

    it('should append to file', () =>
      withSqlServerContainer(async (container) => {
        const fs = new MssqlFs({
          pool: container.connectionString,
          root: '/',
        });
        try {
          await fs.writeFile('/append.txt', 'Hello');
          await fs.appendFile('/append.txt', ', World!');

          const result = await fs.readFile('/append.txt');
          assert.strictEqual(result, 'Hello, World!');
        } finally {
          await fs.close();
        }
      }));

    it('should throw on reading non-existent file', () =>
      withSqlServerContainer(async (container) => {
        const fs = new MssqlFs({
          pool: container.connectionString,
          root: '/',
        });
        try {
          await assert.rejects(() => fs.readFile('/nonexistent.txt'), /ENOENT/);
        } finally {
          await fs.close();
        }
      }));

    it('should auto-create parent directories on write', () =>
      withSqlServerContainer(async (container) => {
        const fs = new MssqlFs({
          pool: container.connectionString,
          root: '/',
        });
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
    it('should handle files larger than chunk size', () =>
      withSqlServerContainer(async (container) => {
        const chunkSize = 1024;
        const fs = new MssqlFs({
          pool: container.connectionString,
          root: '/',
          chunkSize,
        });
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
    it('should create directory', () =>
      withSqlServerContainer(async (container) => {
        const fs = new MssqlFs({
          pool: container.connectionString,
          root: '/',
        });
        try {
          await fs.mkdir('/newdir');
          const stat = await fs.stat('/newdir');
          assert.strictEqual(stat.isDirectory, true);
        } finally {
          await fs.close();
        }
      }));

    it('should create directory recursively', () =>
      withSqlServerContainer(async (container) => {
        const fs = new MssqlFs({
          pool: container.connectionString,
          root: '/',
        });
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

    it('should list directory contents', () =>
      withSqlServerContainer(async (container) => {
        const fs = new MssqlFs({
          pool: container.connectionString,
          root: '/',
        });
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

    it('should list directory with file types', () =>
      withSqlServerContainer(async (container) => {
        const fs = new MssqlFs({
          pool: container.connectionString,
          root: '/',
        });
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
  });

  describe('remove operations', () => {
    it('should remove file', () =>
      withSqlServerContainer(async (container) => {
        const fs = new MssqlFs({
          pool: container.connectionString,
          root: '/',
        });
        try {
          await fs.writeFile('/toremove.txt', 'content');
          assert.strictEqual(await fs.exists('/toremove.txt'), true);

          await fs.rm('/toremove.txt');
          assert.strictEqual(await fs.exists('/toremove.txt'), false);
        } finally {
          await fs.close();
        }
      }));

    it('should remove directory recursively', () =>
      withSqlServerContainer(async (container) => {
        const fs = new MssqlFs({
          pool: container.connectionString,
          root: '/',
        });
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

    it('should not throw on force remove of non-existent', () =>
      withSqlServerContainer(async (container) => {
        const fs = new MssqlFs({
          pool: container.connectionString,
          root: '/',
        });
        try {
          await fs.rm('/nonexistent', { force: true });
        } finally {
          await fs.close();
        }
      }));
  });

  describe('copy and move operations', () => {
    it('should copy file', () =>
      withSqlServerContainer(async (container) => {
        const fs = new MssqlFs({
          pool: container.connectionString,
          root: '/',
        });
        try {
          await fs.writeFile('/original.txt', 'original content');
          await fs.cp('/original.txt', '/copied.txt');

          const result = await fs.readFile('/copied.txt');
          assert.strictEqual(result, 'original content');
        } finally {
          await fs.close();
        }
      }));

    it('should copy directory recursively', () =>
      withSqlServerContainer(async (container) => {
        const fs = new MssqlFs({
          pool: container.connectionString,
          root: '/',
        });
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

    it('should move file', () =>
      withSqlServerContainer(async (container) => {
        const fs = new MssqlFs({
          pool: container.connectionString,
          root: '/',
        });
        try {
          await fs.writeFile('/tomove.txt', 'moving');
          await fs.mv('/tomove.txt', '/moved.txt');

          assert.strictEqual(await fs.exists('/tomove.txt'), false);
          assert.strictEqual(await fs.readFile('/moved.txt'), 'moving');
        } finally {
          await fs.close();
        }
      }));
  });

  describe('stat operations', () => {
    it('should return file stats', () =>
      withSqlServerContainer(async (container) => {
        const fs = new MssqlFs({
          pool: container.connectionString,
          root: '/',
        });
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

    it('should return directory stats', () =>
      withSqlServerContainer(async (container) => {
        const fs = new MssqlFs({
          pool: container.connectionString,
          root: '/',
        });
        try {
          await fs.mkdir('/statdir');
          const stat = await fs.stat('/statdir');

          assert.strictEqual(stat.isFile, false);
          assert.strictEqual(stat.isDirectory, true);
        } finally {
          await fs.close();
        }
      }));

    it('should change file mode', () =>
      withSqlServerContainer(async (container) => {
        const fs = new MssqlFs({
          pool: container.connectionString,
          root: '/',
        });
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
    it('should create and read symlink', () =>
      withSqlServerContainer(async (container) => {
        const fs = new MssqlFs({
          pool: container.connectionString,
          root: '/',
        });
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

    it('should distinguish lstat from stat for symlinks', () =>
      withSqlServerContainer(async (container) => {
        const fs = new MssqlFs({
          pool: container.connectionString,
          root: '/',
        });
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
    it('should prefix paths with root', () =>
      withSqlServerContainer(async (container) => {
        const fs = new MssqlFs({
          pool: container.connectionString,
          root: '/prefix',
        });
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

    it('should create root directory structure on initialization', () =>
      withSqlServerContainer(async (container) => {
        const fs = new MssqlFs({
          pool: container.connectionString,
          root: '/chat/123/results',
        });
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

    it('should isolate two instances with different roots', () =>
      withSqlServerContainer(async (container) => {
        const pool = new sql.ConnectionPool(container.connectionString);
        await pool.connect();
        try {
          const fs1 = new MssqlFs({ pool, root: '/chat-1' });
          const fs2 = new MssqlFs({ pool, root: '/chat-2' });

          await fs1.writeFile('/data.json', '{"chat": 1}');
          await fs2.writeFile('/data.json', '{"chat": 2}');

          assert.strictEqual(await fs1.readFile('/data.json'), '{"chat": 1}');
          assert.strictEqual(await fs2.readFile('/data.json'), '{"chat": 2}');

          await fs1.close();
          await fs2.close();
        } finally {
          await pool.close();
        }
      }));
  });

  describe('pool injection', () => {
    it('should accept a pre-existing ConnectionPool', () =>
      withSqlServerContainer(async (container) => {
        const pool = new sql.ConnectionPool(container.connectionString);
        await pool.connect();
        try {
          const fs = new MssqlFs({ pool, root: '/' });
          try {
            await fs.writeFile('/pool-test.txt', 'injected pool');

            const content = await fs.readFile('/pool-test.txt');
            assert.strictEqual(content, 'injected pool');
          } finally {
            await fs.close();
          }

          assert.strictEqual(pool.connected, true);
        } finally {
          await pool.close();
        }
      }));

    it('should not close external pool on close()', () =>
      withSqlServerContainer(async (container) => {
        const pool = new sql.ConnectionPool(container.connectionString);
        await pool.connect();
        try {
          const fs = new MssqlFs({ pool, root: '/' });
          await fs.writeFile('/no-close.txt', 'data');
          await fs.close();

          assert.strictEqual(pool.connected, true);

          const result = await pool.request().query('SELECT 1 AS val');
          assert.strictEqual(result.recordset[0].val, 1);
        } finally {
          await pool.close();
        }
      }));
  });

  describe('schema support', () => {
    it('should create tables in a custom schema', () =>
      withSqlServerContainer(async (container) => {
        const fs = new MssqlFs({
          pool: container.connectionString,
          root: '/',
          schema: 'custom_fs_schema',
        });
        try {
          await fs.writeFile('/schema-test.txt', 'custom schema data');

          const content = await fs.readFile('/schema-test.txt');
          assert.strictEqual(content, 'custom schema data');

          const pool = new sql.ConnectionPool(container.connectionString);
          await pool.connect();
          try {
            const result = await pool.request().query(`
              SELECT TABLE_SCHEMA, TABLE_NAME
              FROM INFORMATION_SCHEMA.TABLES
              WHERE TABLE_SCHEMA = 'custom_fs_schema'
            `);
            assert.ok(result.recordset.length > 0);
            assert.ok(
              result.recordset.every(
                (r: { TABLE_SCHEMA: string }) =>
                  r.TABLE_SCHEMA === 'custom_fs_schema',
              ),
            );
          } finally {
            await pool.close();
          }
        } finally {
          await fs.close();
        }
      }));
  });
});
