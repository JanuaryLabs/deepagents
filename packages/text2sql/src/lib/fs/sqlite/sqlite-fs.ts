import type {
  CpOptions,
  FileContent,
  FsStat,
  IFileSystem,
  MkdirOptions,
  RmOptions,
} from 'just-bash';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import SQLITE_FS_DDL from './ddl.sqlite-fs.sql';

// Types not exported from just-bash main index but defined in IFileSystem
interface ReadFileOptions {
  encoding?: BufferEncoding | null;
}

interface WriteFileOptions {
  encoding?: BufferEncoding;
}

interface DirentEntry {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
}

/**
 * Options for creating a SQLite filesystem.
 */
export interface SqliteFsOptions {
  /** Path to SQLite database file */
  dbPath: string;

  /**
   * Root path prefix for all operations (required).
   * All filesystem operations will be scoped under this path.
   * Use '/' for root-level storage without namespace isolation.
   *
   * @example
   * // With root: '/chat-123/results'
   * // writeFile('/file.json') → stores at '/chat-123/results/file.json'
   * // readFile('/file.json') → reads from '/chat-123/results/file.json'
   */
  root: string;

  /** Chunk size for large files in bytes (default: 1MB) */
  chunkSize?: number;
}

type EntryType = 'file' | 'directory' | 'symlink';

interface FsEntryRow {
  path: string;
  type: EntryType;
  mode: number;
  size: number;
  mtime: number;
  symlinkTarget: string | null;
}

interface ChunkRow {
  data: Uint8Array;
}

/**
 * SQLite-based filesystem implementing IFileSystem interface.
 *
 * Provides persistent storage for files and directories using SQLite.
 * Files are stored in chunks (default 1MB) to handle large files efficiently.
 *
 * Uses WAL mode and prepared statement caching for performance.
 */
export class SqliteFs implements IFileSystem {
  #db: DatabaseSync;
  #statements = new Map<string, ReturnType<DatabaseSync['prepare']>>();
  #chunkSize: number;
  #root: string;

  constructor(options: SqliteFsOptions) {
    this.#chunkSize = options.chunkSize ?? 1024 * 1024; // 1MB default
    // Normalize root; if user passes '/', treat as empty (root-level storage)
    const normalizedRoot = this.#normalizeRoot(options.root);
    this.#root = normalizedRoot === '/' ? '' : normalizedRoot;
    this.#db = new DatabaseSync(options.dbPath);
    this.#db.exec(SQLITE_FS_DDL);

    // Always ensure '/' exists first (for all instances sharing the DB)
    const rootSlashExists = this.#stmt(
      'SELECT 1 FROM fs_entries WHERE path = ?',
    ).get('/');
    if (!rootSlashExists) {
      this.#stmt(
        `INSERT INTO fs_entries (path, type, mode, size, mtime)
         VALUES ('/', 'directory', 493, 0, ?)`,
      ).run(Date.now());
    }

    if (this.#root) {
      this.#createParentDirs(this.#root);

      const rootExists = this.#stmt(
        'SELECT 1 FROM fs_entries WHERE path = ?',
      ).get(this.#root);
      if (!rootExists) {
        this.#stmt(
          `INSERT INTO fs_entries (path, type, mode, size, mtime)
           VALUES (?, 'directory', 493, 0, ?)`,
        ).run(this.#root, Date.now());
      }
    }
  }

  /**
   * Create parent directories for a path (used during initialization).
   * Creates all segments EXCEPT the last one (the path itself).
   */
  #createParentDirs(p: string): void {
    const segments = p.split('/').filter(Boolean);
    let currentPath = '/';

    for (let i = 0; i < segments.length - 1; i++) {
      currentPath = path.posix.join(currentPath, segments[i]);
      const exists = this.#stmt('SELECT 1 FROM fs_entries WHERE path = ?').get(
        currentPath,
      );

      if (!exists) {
        this.#stmt(
          `INSERT INTO fs_entries (path, type, mode, size, mtime)
           VALUES (?, 'directory', 493, 0, ?)`,
        ).run(currentPath, Date.now());
      }
    }
  }

  #stmt(sql: string): ReturnType<DatabaseSync['prepare']> {
    let stmt = this.#statements.get(sql);
    if (!stmt) {
      stmt = this.#db.prepare(sql);
      this.#statements.set(sql, stmt);
    }
    return stmt;
  }

  #normalizeRoot(root: string): string {
    return path.posix.resolve('/', root.trim());
  }

  #prefixPath(p: string): string {
    if (!this.#root) {
      return p;
    }
    // path.posix.join('/root', '/') incorrectly returns '/root/'
    if (p === '/') {
      return this.#root;
    }
    return path.posix.join(this.#root, p);
  }

  #unprefixPath(p: string): string {
    if (!this.#root) {
      return p;
    }
    if (p === this.#root) {
      return '/';
    }
    if (p.startsWith(this.#root + '/')) {
      return p.slice(this.#root.length) || '/';
    }
    // Should not happen unless a symlink escapes the configured root.
    // Return the best-effort canonical path to avoid breaking callers.
    return p;
  }

  #useTransaction<T>(fn: () => T): T {
    this.#db.exec('BEGIN TRANSACTION');
    try {
      const result = fn();
      this.#db.exec('COMMIT');
      return result;
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  #normalizePath(p: string): string {
    return path.posix.resolve('/', p);
  }

  #dirname(p: string): string {
    const dir = path.posix.dirname(p);
    return dir === '' ? '/' : dir;
  }

  #ensureParentExists(filePath: string): void {
    const parent = this.#dirname(filePath);
    const rootPath = this.#root || '/';
    if (parent === rootPath || parent === '/') return;

    const entry = this.#stmt('SELECT type FROM fs_entries WHERE path = ?').get(
      parent,
    ) as { type: string } | undefined;

    if (!entry) {
      this.#ensureParentExists(parent);
      this.#stmt(
        `INSERT INTO fs_entries (path, type, mode, size, mtime)
         VALUES (?, 'directory', 493, 0, ?)`,
      ).run(parent, Date.now());
    } else if (entry.type !== 'directory') {
      throw new Error(`mkdir: parent is not a directory: ${parent}`);
    }
  }

  #writeChunks(filePath: string, content: Uint8Array): void {
    this.#stmt('DELETE FROM fs_chunks WHERE path = ?').run(filePath);

    for (let i = 0; i < content.length; i += this.#chunkSize) {
      const chunk = content.slice(
        i,
        Math.min(i + this.#chunkSize, content.length),
      );
      this.#stmt(
        'INSERT INTO fs_chunks (path, chunkIndex, data) VALUES (?, ?, ?)',
      ).run(filePath, Math.floor(i / this.#chunkSize), chunk);
    }
  }

  #readChunks(filePath: string): Uint8Array {
    const rows = this.#stmt(
      'SELECT data FROM fs_chunks WHERE path = ? ORDER BY chunkIndex',
    ).all(filePath) as unknown as ChunkRow[];

    if (rows.length === 0) {
      return new Uint8Array(0);
    }

    const totalSize = rows.reduce((sum, row) => sum + row.data.length, 0);
    const result = new Uint8Array(totalSize);
    let offset = 0;

    for (const row of rows) {
      result.set(row.data, offset);
      offset += row.data.length;
    }

    return result;
  }

  #resolveSymlink(p: string, seen = new Set<string>()): string {
    if (seen.has(p)) {
      throw new Error(`readFile: circular symlink: ${p}`);
    }

    const entry = this.#stmt(
      'SELECT type, symlinkTarget FROM fs_entries WHERE path = ?',
    ).get(p) as Pick<FsEntryRow, 'type' | 'symlinkTarget'> | undefined;

    if (!entry) {
      throw new Error(`ENOENT: no such file or directory: ${p}`);
    }

    if (entry.type !== 'symlink') {
      return p;
    }

    seen.add(p);
    const target = this.#normalizePath(
      path.posix.resolve(this.#dirname(p), entry.symlinkTarget!),
    );
    return this.#resolveSymlink(target, seen);
  }

  #toUint8Array(content: FileContent, encoding?: string): Uint8Array {
    if (content instanceof Uint8Array) {
      return content;
    }
    const enc = (encoding ?? 'utf8') as BufferEncoding;
    return new Uint8Array(Buffer.from(content, enc));
  }

  // ============================================================================
  // IFileSystem Implementation
  // ============================================================================

  async readFile(
    filePath: string,
    options?: ReadFileOptions | string,
  ): Promise<string> {
    const normalized = this.#normalizePath(filePath);
    const prefixed = this.#prefixPath(normalized);
    const resolved = this.#resolveSymlink(prefixed);

    const entry = this.#stmt('SELECT type FROM fs_entries WHERE path = ?').get(
      resolved,
    ) as Pick<FsEntryRow, 'type'> | undefined;

    if (!entry) {
      throw new Error(`ENOENT: no such file or directory: ${filePath}`);
    }
    if (entry.type === 'directory') {
      throw new Error(`EISDIR: illegal operation on a directory: ${filePath}`);
    }

    const content = this.#readChunks(resolved);
    const encoding =
      typeof options === 'string' ? options : (options?.encoding ?? 'utf8');
    return Buffer.from(content).toString(encoding as BufferEncoding);
  }

  async readFileBuffer(filePath: string): Promise<Uint8Array> {
    const normalized = this.#normalizePath(filePath);
    const prefixed = this.#prefixPath(normalized);
    const resolved = this.#resolveSymlink(prefixed);

    const entry = this.#stmt('SELECT type FROM fs_entries WHERE path = ?').get(
      resolved,
    ) as Pick<FsEntryRow, 'type'> | undefined;

    if (!entry) {
      throw new Error(`ENOENT: no such file or directory: ${filePath}`);
    }
    if (entry.type === 'directory') {
      throw new Error(`EISDIR: illegal operation on a directory: ${filePath}`);
    }

    return this.#readChunks(resolved);
  }

  async writeFile(
    filePath: string,
    content: FileContent,
    options?: WriteFileOptions | string,
  ): Promise<void> {
    const normalized = this.#normalizePath(filePath);
    const prefixed = this.#prefixPath(normalized);
    const encoding = typeof options === 'string' ? options : options?.encoding;
    const data = this.#toUint8Array(content, encoding);

    this.#useTransaction(() => {
      this.#ensureParentExists(prefixed);

      this.#stmt(
        `INSERT INTO fs_entries (path, type, mode, size, mtime)
         VALUES (?, 'file', 420, ?, ?)
         ON CONFLICT(path) DO UPDATE SET
           type = 'file',
           size = excluded.size,
           mtime = excluded.mtime`,
      ).run(prefixed, data.length, Date.now());

      this.#writeChunks(prefixed, data);
    });
  }

  async appendFile(
    filePath: string,
    content: FileContent,
    options?: WriteFileOptions | string,
  ): Promise<void> {
    const normalized = this.#normalizePath(filePath);
    const prefixed = this.#prefixPath(normalized);
    const encoding = typeof options === 'string' ? options : options?.encoding;
    const newData = this.#toUint8Array(content, encoding);

    this.#useTransaction(() => {
      this.#ensureParentExists(prefixed);

      const entry = this.#stmt(
        'SELECT type FROM fs_entries WHERE path = ?',
      ).get(prefixed) as Pick<FsEntryRow, 'type'> | undefined;

      if (entry && entry.type !== 'file') {
        throw new Error(`appendFile: not a file: ${filePath}`);
      }

      const existing = entry ? this.#readChunks(prefixed) : new Uint8Array(0);
      const combined = new Uint8Array(existing.length + newData.length);
      combined.set(existing, 0);
      combined.set(newData, existing.length);

      this.#stmt(
        `INSERT INTO fs_entries (path, type, mode, size, mtime)
         VALUES (?, 'file', 420, ?, ?)
         ON CONFLICT(path) DO UPDATE SET
           size = excluded.size,
           mtime = excluded.mtime`,
      ).run(prefixed, combined.length, Date.now());

      this.#writeChunks(prefixed, combined);
    });
  }

  async exists(filePath: string): Promise<boolean> {
    const normalized = this.#normalizePath(filePath);
    const prefixed = this.#prefixPath(normalized);
    const row = this.#stmt('SELECT 1 FROM fs_entries WHERE path = ?').get(
      prefixed,
    );
    return row !== undefined;
  }

  async stat(filePath: string): Promise<FsStat> {
    const normalized = this.#normalizePath(filePath);
    const prefixed = this.#prefixPath(normalized);
    const resolved = this.#resolveSymlink(prefixed);

    const entry = this.#stmt('SELECT * FROM fs_entries WHERE path = ?').get(
      resolved,
    ) as FsEntryRow | undefined;

    if (!entry) {
      throw new Error(`ENOENT: no such file or directory: ${filePath}`);
    }

    return {
      isFile: entry.type === 'file',
      isDirectory: entry.type === 'directory',
      isSymbolicLink: false, // stat follows symlinks
      mode: entry.mode,
      size: entry.size,
      mtime: new Date(entry.mtime),
    };
  }

  async lstat(filePath: string): Promise<FsStat> {
    const normalized = this.#normalizePath(filePath);
    const prefixed = this.#prefixPath(normalized);

    const entry = this.#stmt('SELECT * FROM fs_entries WHERE path = ?').get(
      prefixed,
    ) as FsEntryRow | undefined;

    if (!entry) {
      throw new Error(`ENOENT: no such file or directory: ${filePath}`);
    }

    return {
      isFile: entry.type === 'file',
      isDirectory: entry.type === 'directory',
      isSymbolicLink: entry.type === 'symlink',
      mode: entry.mode,
      size: entry.size,
      mtime: new Date(entry.mtime),
    };
  }

  async mkdir(dirPath: string, options?: MkdirOptions): Promise<void> {
    const normalized = this.#normalizePath(dirPath);
    const prefixed = this.#prefixPath(normalized);

    const existing = this.#stmt(
      'SELECT type FROM fs_entries WHERE path = ?',
    ).get(prefixed) as Pick<FsEntryRow, 'type'> | undefined;

    if (existing) {
      if (options?.recursive) {
        return; // Already exists, ok for recursive
      }
      throw new Error(`EEXIST: file already exists: ${dirPath}`);
    }

    this.#useTransaction(() => {
      if (options?.recursive) {
        const rootPath = this.#root || '/';
        const relativePath = path.posix.relative(rootPath, prefixed);
        const segments = relativePath.split('/').filter(Boolean);
        let currentPath = rootPath;

        for (const segment of segments) {
          currentPath = path.posix.join(currentPath, segment);
          const exists = this.#stmt(
            'SELECT type FROM fs_entries WHERE path = ?',
          ).get(currentPath) as Pick<FsEntryRow, 'type'> | undefined;

          if (!exists) {
            this.#stmt(
              `INSERT INTO fs_entries (path, type, mode, size, mtime)
               VALUES (?, 'directory', 493, 0, ?)`,
            ).run(currentPath, Date.now());
          } else if (exists.type !== 'directory') {
            throw new Error(`mkdir: not a directory: ${currentPath}`);
          }
        }
      } else {
        // Non-recursive: parent must exist
        const parent = this.#dirname(prefixed);
        const parentEntry = this.#stmt(
          'SELECT type FROM fs_entries WHERE path = ?',
        ).get(parent) as Pick<FsEntryRow, 'type'> | undefined;

        if (!parentEntry) {
          throw new Error(`mkdir: parent does not exist: ${parent}`);
        }
        if (parentEntry.type !== 'directory') {
          throw new Error(`mkdir: parent is not a directory: ${parent}`);
        }

        this.#stmt(
          `INSERT INTO fs_entries (path, type, mode, size, mtime)
           VALUES (?, 'directory', 493, 0, ?)`,
        ).run(prefixed, Date.now());
      }
    });
  }

  async readdir(dirPath: string): Promise<string[]> {
    const normalized = this.#normalizePath(dirPath);
    const prefixed = this.#prefixPath(normalized);
    const resolved = this.#resolveSymlink(prefixed);

    const entry = this.#stmt('SELECT type FROM fs_entries WHERE path = ?').get(
      resolved,
    ) as Pick<FsEntryRow, 'type'> | undefined;

    if (!entry) {
      throw new Error(`ENOENT: no such file or directory: ${dirPath}`);
    }
    if (entry.type !== 'directory') {
      throw new Error(`ENOTDIR: not a directory: ${dirPath}`);
    }

    // Get direct children (path starts with dir/ but doesn't have another / after)
    const prefix = resolved === '/' ? '/' : resolved + '/';
    const rows = this.#stmt(
      `SELECT path FROM fs_entries
       WHERE path LIKE ? || '%'
         AND path != ?
         AND path NOT LIKE ? || '%/%'`,
    ).all(prefix, resolved, prefix) as { path: string }[];

    return rows.map((row) => path.posix.basename(row.path));
  }

  async readdirWithFileTypes(dirPath: string): Promise<DirentEntry[]> {
    const normalized = this.#normalizePath(dirPath);
    const prefixed = this.#prefixPath(normalized);
    const resolved = this.#resolveSymlink(prefixed);

    const entry = this.#stmt('SELECT type FROM fs_entries WHERE path = ?').get(
      resolved,
    ) as Pick<FsEntryRow, 'type'> | undefined;

    if (!entry) {
      throw new Error(`ENOENT: no such file or directory: ${dirPath}`);
    }
    if (entry.type !== 'directory') {
      throw new Error(`ENOTDIR: not a directory: ${dirPath}`);
    }

    const prefix = resolved === '/' ? '/' : resolved + '/';
    const rows = this.#stmt(
      `SELECT path, type FROM fs_entries
       WHERE path LIKE ? || '%'
         AND path != ?
         AND path NOT LIKE ? || '%/%'`,
    ).all(prefix, resolved, prefix) as Pick<FsEntryRow, 'path' | 'type'>[];

    return rows.map((row) => ({
      name: path.posix.basename(row.path),
      isFile: row.type === 'file',
      isDirectory: row.type === 'directory',
      isSymbolicLink: row.type === 'symlink',
    }));
  }

  async rm(filePath: string, options?: RmOptions): Promise<void> {
    const normalized = this.#normalizePath(filePath);
    const prefixed = this.#prefixPath(normalized);

    const entry = this.#stmt('SELECT type FROM fs_entries WHERE path = ?').get(
      prefixed,
    ) as Pick<FsEntryRow, 'type'> | undefined;

    if (!entry) {
      if (options?.force) {
        return;
      }
      throw new Error(`ENOENT: no such file or directory: ${filePath}`);
    }

    this.#useTransaction(() => {
      if (entry.type === 'directory') {
        const children = this.#stmt(
          `SELECT 1 FROM fs_entries WHERE path LIKE ? || '/%' LIMIT 1`,
        ).get(prefixed);

        if (children && !options?.recursive) {
          throw new Error(`ENOTEMPTY: directory not empty: ${filePath}`);
        }

        // Chunks cascade via FK
        this.#stmt(
          `DELETE FROM fs_entries WHERE path = ? OR path LIKE ? || '/%'`,
        ).run(prefixed, prefixed);
      } else {
        this.#stmt('DELETE FROM fs_entries WHERE path = ?').run(prefixed);
      }
    });
  }

  async cp(src: string, dest: string, options?: CpOptions): Promise<void> {
    const srcNormalized = this.#normalizePath(src);
    const destNormalized = this.#normalizePath(dest);
    const srcPrefixed = this.#prefixPath(srcNormalized);
    const destPrefixed = this.#prefixPath(destNormalized);

    const srcEntry = this.#stmt('SELECT * FROM fs_entries WHERE path = ?').get(
      srcPrefixed,
    ) as FsEntryRow | undefined;

    if (!srcEntry) {
      throw new Error(`ENOENT: no such file or directory: ${src}`);
    }

    if (srcEntry.type === 'directory' && !options?.recursive) {
      throw new Error(`cp: -r not specified; omitting directory: ${src}`);
    }

    this.#useTransaction(() => {
      this.#ensureParentExists(destPrefixed);

      if (srcEntry.type === 'directory') {
        const allEntries = this.#stmt(
          `SELECT * FROM fs_entries WHERE path = ? OR path LIKE ? || '/%'`,
        ).all(srcPrefixed, srcPrefixed) as unknown as FsEntryRow[];

        for (const entry of allEntries) {
          const relativePath = path.posix.relative(srcPrefixed, entry.path);
          const newPath = path.posix.join(destPrefixed, relativePath);

          this.#stmt(
            `INSERT OR REPLACE INTO fs_entries (path, type, mode, size, mtime, symlinkTarget)
             VALUES (?, ?, ?, ?, ?, ?)`,
          ).run(
            newPath,
            entry.type,
            entry.mode,
            entry.size,
            Date.now(),
            entry.symlinkTarget,
          );

          if (entry.type === 'file') {
            const chunks = this.#stmt(
              'SELECT chunkIndex, data FROM fs_chunks WHERE path = ?',
            ).all(entry.path) as { chunkIndex: number; data: Uint8Array }[];

            for (const chunk of chunks) {
              this.#stmt(
                'INSERT INTO fs_chunks (path, chunkIndex, data) VALUES (?, ?, ?)',
              ).run(newPath, chunk.chunkIndex, chunk.data);
            }
          }
        }
      } else {
        this.#stmt(
          `INSERT OR REPLACE INTO fs_entries (path, type, mode, size, mtime, symlinkTarget)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(
          destPrefixed,
          srcEntry.type,
          srcEntry.mode,
          srcEntry.size,
          Date.now(),
          srcEntry.symlinkTarget,
        );

        if (srcEntry.type === 'file') {
          const chunks = this.#stmt(
            'SELECT chunkIndex, data FROM fs_chunks WHERE path = ?',
          ).all(srcPrefixed) as { chunkIndex: number; data: Uint8Array }[];

          this.#stmt('DELETE FROM fs_chunks WHERE path = ?').run(destPrefixed);

          for (const chunk of chunks) {
            this.#stmt(
              'INSERT INTO fs_chunks (path, chunkIndex, data) VALUES (?, ?, ?)',
            ).run(destPrefixed, chunk.chunkIndex, chunk.data);
          }
        }
      }
    });
  }

  async mv(src: string, dest: string): Promise<void> {
    const srcNormalized = this.#normalizePath(src);
    const destNormalized = this.#normalizePath(dest);
    const srcPrefixed = this.#prefixPath(srcNormalized);
    const destPrefixed = this.#prefixPath(destNormalized);

    const srcEntry = this.#stmt('SELECT * FROM fs_entries WHERE path = ?').get(
      srcPrefixed,
    ) as FsEntryRow | undefined;

    if (!srcEntry) {
      throw new Error(`ENOENT: no such file or directory: ${src}`);
    }

    this.#useTransaction(() => {
      this.#ensureParentExists(destPrefixed);

      if (srcEntry.type === 'directory') {
        // Reverse order: children before parents for delete
        const allEntries = this.#stmt(
          `SELECT * FROM fs_entries WHERE path = ? OR path LIKE ? || '/%' ORDER BY path DESC`,
        ).all(srcPrefixed, srcPrefixed) as unknown as FsEntryRow[];

        for (const entry of [...allEntries].reverse()) {
          const relativePath = path.posix.relative(srcPrefixed, entry.path);
          const newPath = path.posix.join(destPrefixed, relativePath);

          this.#stmt(
            `INSERT INTO fs_entries (path, type, mode, size, mtime, symlinkTarget)
             VALUES (?, ?, ?, ?, ?, ?)`,
          ).run(
            newPath,
            entry.type,
            entry.mode,
            entry.size,
            Date.now(),
            entry.symlinkTarget,
          );

          if (entry.type === 'file') {
            const chunks = this.#stmt(
              'SELECT chunkIndex, data FROM fs_chunks WHERE path = ?',
            ).all(entry.path) as unknown as {
              chunkIndex: number;
              data: Uint8Array;
            }[];

            for (const chunk of chunks) {
              this.#stmt(
                'INSERT INTO fs_chunks (path, chunkIndex, data) VALUES (?, ?, ?)',
              ).run(newPath, chunk.chunkIndex, chunk.data);
            }
          }
        }

        // Chunks cascade via FK
        this.#stmt(
          `DELETE FROM fs_entries WHERE path = ? OR path LIKE ? || '/%'`,
        ).run(srcPrefixed, srcPrefixed);
      } else {
        this.#stmt(
          `INSERT INTO fs_entries (path, type, mode, size, mtime, symlinkTarget)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(
          destPrefixed,
          srcEntry.type,
          srcEntry.mode,
          srcEntry.size,
          Date.now(),
          srcEntry.symlinkTarget,
        );

        if (srcEntry.type === 'file') {
          const chunks = this.#stmt(
            'SELECT chunkIndex, data FROM fs_chunks WHERE path = ?',
          ).all(srcPrefixed) as unknown as {
            chunkIndex: number;
            data: Uint8Array;
          }[];

          for (const chunk of chunks) {
            this.#stmt(
              'INSERT INTO fs_chunks (path, chunkIndex, data) VALUES (?, ?, ?)',
            ).run(destPrefixed, chunk.chunkIndex, chunk.data);
          }
        }

        this.#stmt('DELETE FROM fs_entries WHERE path = ?').run(srcPrefixed);
      }
    });
  }

  resolvePath(base: string, relativePath: string): string {
    return path.posix.resolve(base, relativePath);
  }

  getAllPaths(): string[] {
    const rows = this.#stmt(
      'SELECT path FROM fs_entries ORDER BY path',
    ).all() as {
      path: string;
    }[];
    return rows.map((row) => row.path);
  }

  async realpath(filePath: string): Promise<string> {
    const normalized = this.#normalizePath(filePath);
    const prefixed = this.#prefixPath(normalized);
    const resolved = this.#resolveSymlink(prefixed);

    const exists = this.#stmt('SELECT 1 FROM fs_entries WHERE path = ?').get(
      resolved,
    );
    if (!exists) {
      throw new Error(`ENOENT: no such file or directory: ${filePath}`);
    }

    return this.#unprefixPath(resolved);
  }

  async utimes(filePath: string, _atime: Date, mtime: Date): Promise<void> {
    const normalized = this.#normalizePath(filePath);
    const prefixed = this.#prefixPath(normalized);
    const resolved = this.#resolveSymlink(prefixed);

    const result = this.#stmt(
      'UPDATE fs_entries SET mtime = ? WHERE path = ?',
    ).run(mtime.getTime(), resolved);

    if (result.changes === 0) {
      throw new Error(`ENOENT: no such file or directory: ${filePath}`);
    }
  }

  async chmod(filePath: string, mode: number): Promise<void> {
    const normalized = this.#normalizePath(filePath);
    const prefixed = this.#prefixPath(normalized);

    const result = this.#stmt(
      'UPDATE fs_entries SET mode = ? WHERE path = ?',
    ).run(mode, prefixed);

    if (result.changes === 0) {
      throw new Error(`ENOENT: no such file or directory: ${filePath}`);
    }
  }

  async symlink(target: string, linkPath: string): Promise<void> {
    const normalized = this.#normalizePath(linkPath);
    const prefixed = this.#prefixPath(normalized);

    const existing = this.#stmt('SELECT 1 FROM fs_entries WHERE path = ?').get(
      prefixed,
    );
    if (existing) {
      throw new Error(`EEXIST: file already exists: ${linkPath}`);
    }

    this.#useTransaction(() => {
      this.#ensureParentExists(prefixed);

      this.#stmt(
        `INSERT INTO fs_entries (path, type, mode, size, mtime, symlinkTarget)
         VALUES (?, 'symlink', 511, 0, ?, ?)`,
      ).run(prefixed, Date.now(), target);
    });
  }

  async link(existingPath: string, newPath: string): Promise<void> {
    const srcNormalized = this.#normalizePath(existingPath);
    const destNormalized = this.#normalizePath(newPath);
    const srcPrefixed = this.#prefixPath(srcNormalized);
    const destPrefixed = this.#prefixPath(destNormalized);

    const srcEntry = this.#stmt('SELECT * FROM fs_entries WHERE path = ?').get(
      srcPrefixed,
    ) as FsEntryRow | undefined;

    if (!srcEntry) {
      throw new Error(`ENOENT: no such file or directory: ${existingPath}`);
    }

    if (srcEntry.type !== 'file') {
      throw new Error(`link: not supported for directories: ${existingPath}`);
    }

    const existing = this.#stmt('SELECT 1 FROM fs_entries WHERE path = ?').get(
      destPrefixed,
    );
    if (existing) {
      throw new Error(`EEXIST: file already exists: ${newPath}`);
    }

    // Hard link: duplicate the entry and chunks
    this.#useTransaction(() => {
      this.#ensureParentExists(destPrefixed);

      this.#stmt(
        `INSERT INTO fs_entries (path, type, mode, size, mtime)
         VALUES (?, 'file', ?, ?, ?)`,
      ).run(destPrefixed, srcEntry.mode, srcEntry.size, Date.now());

      const chunks = this.#stmt(
        'SELECT chunkIndex, data FROM fs_chunks WHERE path = ?',
      ).all(srcPrefixed) as { chunkIndex: number; data: Uint8Array }[];

      for (const chunk of chunks) {
        this.#stmt(
          'INSERT INTO fs_chunks (path, chunkIndex, data) VALUES (?, ?, ?)',
        ).run(destPrefixed, chunk.chunkIndex, chunk.data);
      }
    });
  }

  async readlink(linkPath: string): Promise<string> {
    const normalized = this.#normalizePath(linkPath);
    const prefixed = this.#prefixPath(normalized);

    const entry = this.#stmt(
      'SELECT type, symlinkTarget FROM fs_entries WHERE path = ?',
    ).get(prefixed) as Pick<FsEntryRow, 'type' | 'symlinkTarget'> | undefined;

    if (!entry) {
      throw new Error(`ENOENT: no such file or directory: ${linkPath}`);
    }

    if (entry.type !== 'symlink') {
      throw new Error(`readlink: not a symbolic link: ${linkPath}`);
    }

    return entry.symlinkTarget!;
  }
}
