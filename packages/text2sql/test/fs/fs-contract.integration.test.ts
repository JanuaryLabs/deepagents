import { describe, it } from '@zukhruf/testing/node';
import * as assert from 'node:assert';

import { fsCases } from './fs-cases.ts';

void describe.each(fsCases, (fsCase) =>
  describe(fsCase.name, () => {
    describe('file system', () => {
      describe('file operations', () => {
        it('should write and read a file', async () => {
          await using opened = await fsCase.open();
          const { fs } = opened;
          await fs.writeFile('/test.txt', 'Hello, World!');

          const result = await fs.readFile('/test.txt');
          assert.strictEqual(result, 'Hello, World!');
        });

        it('should write and read binary content', async () => {
          await using opened = await fsCase.open();
          const { fs } = opened;
          const content = new Uint8Array([0x00, 0x01, 0x02, 0xff, 0xfe]);
          await fs.writeFile('/binary.bin', content);

          const result = await fs.readFileBuffer('/binary.bin');
          assert.deepStrictEqual(result, content);
        });

        it('should overwrite existing file', async () => {
          await using opened = await fsCase.open();
          const { fs } = opened;
          await fs.writeFile('/overwrite.txt', 'original');
          await fs.writeFile('/overwrite.txt', 'updated');

          const result = await fs.readFile('/overwrite.txt');
          assert.strictEqual(result, 'updated');
        });

        it('should append to file', async () => {
          await using opened = await fsCase.open();
          const { fs } = opened;
          await fs.writeFile('/append.txt', 'Hello');
          await fs.appendFile('/append.txt', ', World!');

          const result = await fs.readFile('/append.txt');
          assert.strictEqual(result, 'Hello, World!');
        });

        it('should accumulate data across multiple appends', async () => {
          await using opened = await fsCase.open();
          const { fs } = opened;
          await fs.writeFile('/multi.txt', '');
          for (let i = 0; i < 5; i++) {
            await fs.appendFile('/multi.txt', `[${i}]`);
          }

          const result = await fs.readFile('/multi.txt');
          assert.strictEqual(result, '[0][1][2][3][4]');
        });

        it('should throw on reading non-existent file', async () => {
          await using opened = await fsCase.open();
          const { fs } = opened;
          await assert.rejects(() => fs.readFile('/nonexistent.txt'), /ENOENT/);
        });

        it('should write and read empty file', async () => {
          await using opened = await fsCase.open();
          const { fs } = opened;
          await fs.writeFile('/empty.txt', '');

          const result = await fs.readFile('/empty.txt');
          assert.strictEqual(result, '');

          const stat = await fs.stat('/empty.txt');
          assert.strictEqual(stat.size, 0);
        });

        it('should throw EISDIR when reading a directory', async () => {
          await using opened = await fsCase.open();
          const { fs } = opened;
          await fs.mkdir('/adir');

          await assert.rejects(() => fs.readFile('/adir'), /EISDIR/);
        });

        it('should append to non-existent file creating it', async () => {
          await using opened = await fsCase.open();
          const { fs } = opened;
          await fs.appendFile('/brand-new.txt', 'created via append');

          const result = await fs.readFile('/brand-new.txt');
          assert.strictEqual(result, 'created via append');
        });

        it('should throw when appending to a directory', async () => {
          await using opened = await fsCase.open();
          const { fs } = opened;
          await fs.mkdir('/appenddir');

          await assert.rejects(
            () => fs.appendFile('/appenddir', 'data'),
            /not a file/,
          );
        });

        it('should auto-create parent directories on write', async () => {
          await using opened = await fsCase.open();
          const { fs } = opened;
          await fs.writeFile('/deep/nested/path/file.txt', 'content');

          const result = await fs.readFile('/deep/nested/path/file.txt');
          assert.strictEqual(result, 'content');

          assert.strictEqual(await fs.exists('/deep'), true);
          assert.strictEqual(await fs.exists('/deep/nested'), true);
          assert.strictEqual(await fs.exists('/deep/nested/path'), true);
        });
      });

      describe('directory operations', () => {
        it('should create directory', async () => {
          await using opened = await fsCase.open();
          const { fs } = opened;
          await fs.mkdir('/newdir');
          const stat = await fs.stat('/newdir');
          assert.strictEqual(stat.isDirectory, true);
        });

        it('should create directory recursively', async () => {
          await using opened = await fsCase.open();
          const { fs } = opened;
          await fs.mkdir('/a/b/c/d', { recursive: true });

          assert.strictEqual(await fs.exists('/a'), true);
          assert.strictEqual(await fs.exists('/a/b'), true);
          assert.strictEqual(await fs.exists('/a/b/c'), true);
          assert.strictEqual(await fs.exists('/a/b/c/d'), true);
        });

        it('should list directory contents', async () => {
          await using opened = await fsCase.open();
          const { fs } = opened;
          await fs.mkdir('/listdir');
          await fs.writeFile('/listdir/file1.txt', 'content1');
          await fs.writeFile('/listdir/file2.txt', 'content2');
          await fs.mkdir('/listdir/subdir');

          const entries = await fs.readdir('/listdir');
          assert.deepStrictEqual(
            entries.sort(),
            ['file1.txt', 'file2.txt', 'subdir'].sort(),
          );
        });

        it('should list directory with file types', async () => {
          await using opened = await fsCase.open();
          const { fs } = opened;
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
        });

        it('should throw EEXIST on non-recursive mkdir of existing path', async () => {
          await using opened = await fsCase.open();
          const { fs } = opened;
          await fs.mkdir('/existing');

          await assert.rejects(() => fs.mkdir('/existing'), /EEXIST/);
        });

        it('should throw ENOENT on readdir of non-existent path', async () => {
          await using opened = await fsCase.open();
          const { fs } = opened;
          await assert.rejects(() => fs.readdir('/ghost'), /ENOENT/);
        });

        it('should throw ENOTDIR on readdir of a file', async () => {
          await using opened = await fsCase.open();
          const { fs } = opened;
          await fs.writeFile('/notadir.txt', 'content');

          await assert.rejects(() => fs.readdir('/notadir.txt'), /ENOTDIR/);
        });

        it('should return empty array for readdir of empty directory', async () => {
          await using opened = await fsCase.open();
          const { fs } = opened;
          await fs.mkdir('/emptydir');

          const entries = await fs.readdir('/emptydir');
          assert.deepStrictEqual(entries, []);
        });
      });

      describe('remove operations', () => {
        it('should remove file', async () => {
          await using opened = await fsCase.open();
          const { fs } = opened;
          await fs.writeFile('/toremove.txt', 'content');
          assert.strictEqual(await fs.exists('/toremove.txt'), true);

          await fs.rm('/toremove.txt');
          assert.strictEqual(await fs.exists('/toremove.txt'), false);
        });

        it('should remove directory recursively', async () => {
          await using opened = await fsCase.open();
          const { fs } = opened;
          await fs.mkdir('/rmdir');
          await fs.writeFile('/rmdir/file.txt', 'content');
          await fs.mkdir('/rmdir/subdir');
          await fs.writeFile('/rmdir/subdir/nested.txt', 'nested');

          await fs.rm('/rmdir', { recursive: true });
          assert.strictEqual(await fs.exists('/rmdir'), false);
        });

        it('should not throw on force remove of non-existent', async () => {
          await using opened = await fsCase.open();
          const { fs } = opened;
          await fs.rm('/nonexistent', { force: true });
        });

        it('should throw ENOTEMPTY on rm non-empty dir without recursive', async () => {
          await using opened = await fsCase.open();
          const { fs } = opened;
          await fs.mkdir('/notempty');
          await fs.writeFile('/notempty/child.txt', 'data');

          await assert.rejects(() => fs.rm('/notempty'), /ENOTEMPTY/);
        });

        it('should throw ENOENT on rm non-existent without force', async () => {
          await using opened = await fsCase.open();
          const { fs } = opened;
          await assert.rejects(() => fs.rm('/does-not-exist'), /ENOENT/);
        });
      });

      describe('copy and move operations', () => {
        it('should copy file', async () => {
          await using opened = await fsCase.open();
          const { fs } = opened;
          await fs.writeFile('/original.txt', 'original content');
          await fs.cp('/original.txt', '/copied.txt');

          const result = await fs.readFile('/copied.txt');
          assert.strictEqual(result, 'original content');
        });

        it('should copy directory recursively', async () => {
          await using opened = await fsCase.open();
          const { fs } = opened;
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
        });

        it('should move file', async () => {
          await using opened = await fsCase.open();
          const { fs } = opened;
          await fs.writeFile('/tomove.txt', 'moving');
          await fs.mv('/tomove.txt', '/moved.txt');

          assert.strictEqual(await fs.exists('/tomove.txt'), false);
          assert.strictEqual(await fs.readFile('/moved.txt'), 'moving');
        });

        it('should throw ENOENT when copying non-existent source', async () => {
          await using opened = await fsCase.open();
          const { fs } = opened;
          await assert.rejects(
            () => fs.cp('/ghost.txt', '/dest.txt'),
            /ENOENT/,
          );
        });

        it('should throw when copying directory without recursive', async () => {
          await using opened = await fsCase.open();
          const { fs } = opened;
          await fs.mkdir('/cpdir');

          await assert.rejects(
            () => fs.cp('/cpdir', '/cpdir2'),
            /not specified/,
          );
        });

        it('should copy file overwriting existing destination', async () => {
          await using opened = await fsCase.open();
          const { fs } = opened;
          await fs.writeFile('/src-cp.txt', 'new data');
          await fs.writeFile('/dest-cp.txt', 'old data');
          await fs.cp('/src-cp.txt', '/dest-cp.txt');

          assert.strictEqual(await fs.readFile('/dest-cp.txt'), 'new data');
          assert.strictEqual(await fs.readFile('/src-cp.txt'), 'new data');
        });

        it('should throw ENOENT when moving non-existent source', async () => {
          await using opened = await fsCase.open();
          const { fs } = opened;
          await assert.rejects(
            () => fs.mv('/ghost.txt', '/dest.txt'),
            /ENOENT/,
          );
        });

        it('should move directory to new path', async () => {
          await using opened = await fsCase.open();
          const { fs } = opened;
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
        });

        it('should overwrite existing file on move', async () => {
          await using opened = await fsCase.open();
          const { fs } = opened;
          await fs.writeFile('/src.txt', 'new content');
          await fs.writeFile('/dest.txt', 'old content');
          await fs.mv('/src.txt', '/dest.txt');

          assert.strictEqual(await fs.exists('/src.txt'), false);
          assert.strictEqual(await fs.readFile('/dest.txt'), 'new content');
        });

        it('should overwrite existing directory on move', async () => {
          await using opened = await fsCase.open();
          const { fs } = opened;
          await fs.mkdir('/src');
          await fs.writeFile('/src/a.txt', 'alpha');

          await fs.mkdir('/dest');
          await fs.writeFile('/dest/old.txt', 'stale');

          await fs.mv('/src', '/dest');

          assert.strictEqual(await fs.exists('/src'), false);
          assert.strictEqual(await fs.readFile('/dest/a.txt'), 'alpha');
          assert.strictEqual(await fs.exists('/dest/old.txt'), false);
        });

        it('should keep a file moved onto itself', async () => {
          await using opened = await fsCase.open();
          const { fs } = opened;
          await fs.writeFile('/same.txt', 'kept');

          await fs.mv('/same.txt', '/same.txt');

          assert.strictEqual(await fs.readFile('/same.txt'), 'kept');
        });

        it('should keep a directory and its children moved onto itself', async () => {
          await using opened = await fsCase.open();
          const { fs } = opened;
          await fs.mkdir('/same');
          await fs.writeFile('/same/child.txt', 'kept');

          await fs.mv('/same/', '/same');

          assert.strictEqual((await fs.stat('/same')).isDirectory, true);
          assert.strictEqual(await fs.readFile('/same/child.txt'), 'kept');
        });
      });

      describe('stat operations', () => {
        it('should return file stats', async () => {
          await using opened = await fsCase.open();
          const { fs } = opened;
          await fs.writeFile('/statfile.txt', 'content');
          const stat = await fs.stat('/statfile.txt');

          assert.strictEqual(stat.isFile, true);
          assert.strictEqual(stat.isDirectory, false);
          assert.strictEqual(stat.size, 7);
        });

        it('should return directory stats', async () => {
          await using opened = await fsCase.open();
          const { fs } = opened;
          await fs.mkdir('/statdir');
          const stat = await fs.stat('/statdir');

          assert.strictEqual(stat.isFile, false);
          assert.strictEqual(stat.isDirectory, true);
        });

        it('should change file mode', async () => {
          await using opened = await fsCase.open();
          const { fs } = opened;
          await fs.writeFile('/modefile.txt', 'content');
          await fs.chmod('/modefile.txt', 0o755);

          const stat = await fs.stat('/modefile.txt');
          assert.strictEqual(stat.mode, 0o755);
        });
      });

      describe('symlink operations', () => {
        it('should create and read symlink', async () => {
          await using opened = await fsCase.open();
          const { fs } = opened;
          await fs.writeFile('/target.txt', 'target content');
          await fs.symlink('/target.txt', '/link.txt');

          const target = await fs.readlink('/link.txt');
          assert.strictEqual(target, '/target.txt');

          const content = await fs.readFile('/link.txt');
          assert.strictEqual(content, 'target content');
        });

        it('should distinguish lstat from stat for symlinks', async () => {
          await using opened = await fsCase.open();
          const { fs } = opened;
          await fs.writeFile('/lstat-target.txt', 'content');
          await fs.symlink('/lstat-target.txt', '/lstat-link.txt');

          const stat = await fs.stat('/lstat-link.txt');
          assert.strictEqual(stat.isSymbolicLink, false);

          const lstat = await fs.lstat('/lstat-link.txt');
          assert.strictEqual(lstat.isSymbolicLink, true);
        });
      });

      describe('link operations', () => {
        it('should create hard link and read from both paths', async () => {
          await using opened = await fsCase.open();
          const { fs } = opened;
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
        });

        it('should throw ENOENT when link source does not exist', async () => {
          await using opened = await fsCase.open();
          const { fs } = opened;
          await assert.rejects(
            () => fs.link('/no-source.txt', '/link-dest.txt'),
            /ENOENT/,
          );
        });

        it('should throw EEXIST when link destination already exists', async () => {
          await using opened = await fsCase.open();
          const { fs } = opened;
          await fs.writeFile('/link-a.txt', 'a');
          await fs.writeFile('/link-b.txt', 'b');

          await assert.rejects(
            () => fs.link('/link-a.txt', '/link-b.txt'),
            /EEXIST/,
          );
        });

        it('should throw when linking a directory', async () => {
          await using opened = await fsCase.open();
          const { fs } = opened;
          await fs.mkdir('/linkdir');

          await assert.rejects(
            () => fs.link('/linkdir', '/linkdir2'),
            /not supported for directories/,
          );
        });
      });

      describe('realpath and utimes', () => {
        it('should return canonical path for a file', async () => {
          await using opened = await fsCase.open();
          const { fs } = opened;
          await fs.writeFile('/real.txt', 'content');

          const resolved = await fs.realpath('/real.txt');
          assert.strictEqual(resolved, '/real.txt');
        });

        it('should resolve symlink to physical path', async () => {
          await using opened = await fsCase.open();
          const { fs } = opened;
          await fs.writeFile('/real-target.txt', 'data');
          await fs.symlink('/real-target.txt', '/real-link.txt');

          const resolved = await fs.realpath('/real-link.txt');
          assert.strictEqual(resolved, '/real-target.txt');
        });

        it('should throw ENOENT for realpath of non-existent path', async () => {
          await using opened = await fsCase.open();
          const { fs } = opened;
          await assert.rejects(() => fs.realpath('/nope.txt'), /ENOENT/);
        });

        it('should set mtime via utimes and verify via stat', async () => {
          await using opened = await fsCase.open();
          const { fs } = opened;
          await fs.writeFile('/timed.txt', 'content');

          const targetDate = new Date('2024-06-15T12:00:00Z');
          await fs.utimes('/timed.txt', new Date(), targetDate);

          const stat = await fs.stat('/timed.txt');
          assert.strictEqual(stat.mtime.getTime(), targetDate.getTime());
        });

        it('should throw ENOENT on utimes of non-existent path', async () => {
          await using opened = await fsCase.open();
          const { fs } = opened;
          await assert.rejects(
            () => fs.utimes('/nope.txt', new Date(), new Date()),
            /ENOENT/,
          );
        });
      });

      describe('symlink edge cases', () => {
        it('should throw EEXIST when creating symlink at existing path', async () => {
          await using opened = await fsCase.open();
          const { fs } = opened;
          await fs.writeFile('/sym-target.txt', 'data');
          await fs.writeFile('/sym-existing.txt', 'occupied');

          await assert.rejects(
            () => fs.symlink('/sym-target.txt', '/sym-existing.txt'),
            /EEXIST/,
          );
        });

        it('should throw when readlink on a regular file', async () => {
          await using opened = await fsCase.open();
          const { fs } = opened;
          await fs.writeFile('/regular.txt', 'not a link');

          await assert.rejects(
            () => fs.readlink('/regular.txt'),
            /not a symbolic link/,
          );
        });

        it('should throw ENOENT on stat of non-existent path', async () => {
          await using opened = await fsCase.open();
          const { fs } = opened;
          await assert.rejects(
            () => fs.stat('/nonexistent-stat.txt'),
            /ENOENT/,
          );
        });
      });
    });
  }),
);
