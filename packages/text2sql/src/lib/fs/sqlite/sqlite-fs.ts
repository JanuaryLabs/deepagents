import { Declaration } from '@zukhruf/sqlite-drift';
import { transaction } from '@zukhruf/sqlite-transaction';
import type {
  BufferEncoding,
  CpOptions,
  FileContent,
  FsStat,
  IFileSystem,
  MkdirOptions,
  RmOptions,
} from 'just-bash';
import * as path from 'node:path';
import { DatabaseSync, type SQLTagStore } from 'node:sqlite';
import z from 'zod';

import { entryType } from '../columns.ts';
import { SETUP, statements } from './ddl.sqlite-fs.ts';

const tables = new Declaration(statements, { rows: 'keep' });

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

// Row shapes as node:sqlite returns them for ddl.sqlite-fs.ts: INTEGER as a
// number, TEXT as a string, BLOB as a Uint8Array.

const entryRow = z.object({
  path: z.string(),
  type: entryType,
  mode: z.number(),
  size: z.number(),
  mtime: z.number(),
  symlinkTarget: z.string().nullable(),
});

const typeRow = entryRow.pick({ type: true });

const pathRow = entryRow.pick({ path: true });

const pathTypeRow = entryRow.pick({ path: true, type: true });

// symlink() always stores a target. A file or directory keeps NULL, or the
// target of the symlink it replaced: writeFile and appendFile change the type
// of an existing path without clearing it.
const linkRow = z.discriminatedUnion('type', [
  z.object({ type: z.literal('symlink'), symlinkTarget: z.string() }),
  z.object({
    type: z.enum(['file', 'directory']),
    symlinkTarget: z.string().nullable(),
  }),
]);

const chunkRow = z.object({
  chunkIndex: z.number(),
  data: z.instanceof(Uint8Array),
});

const dataRow = chunkRow.pick({ data: true });

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
  #sql: SQLTagStore;
  #chunkSize: number;
  #root: string;

  constructor(options: SqliteFsOptions) {
    this.#chunkSize = options.chunkSize ?? 1024 * 1024; // 1MB default
    // Normalize root; if user passes '/', treat as empty (root-level storage)
    const normalizedRoot = this.#normalizeRoot(options.root);
    this.#root = normalizedRoot === '/' ? '' : normalizedRoot;
    this.#db = new DatabaseSync(options.dbPath);
    this.#db.exec(SETUP);
    tables.apply(this.#db);
    this.#sql = this.#db.createTagStore();

    // Always ensure '/' exists first (for all instances sharing the DB)
    const rootSlashExists = this.#sql
      .get`SELECT 1 FROM fs_entries WHERE path = '/'`;
    if (!rootSlashExists) {
      this.#sql.run`INSERT INTO fs_entries (path, type, mode, size, mtime)
         VALUES ('/', 'directory', 493, 0, ${Date.now()})`;
    }

    if (this.#root) {
      this.#createParentDirs(this.#root);

      const rootExists = this.#sql
        .get`SELECT 1 FROM fs_entries WHERE path = ${this.#root}`;
      if (!rootExists) {
        this.#sql.run`INSERT INTO fs_entries (path, type, mode, size, mtime)
           VALUES (${this.#root}, 'directory', 493, 0, ${Date.now()})`;
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
      const exists = this.#sql
        .get`SELECT 1 FROM fs_entries WHERE path = ${currentPath}`;

      if (!exists) {
        this.#sql.run`INSERT INTO fs_entries (path, type, mode, size, mtime)
           VALUES (${currentPath}, 'directory', 493, 0, ${Date.now()})`;
      }
    }
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

    const entry = typeRow
      .optional()
      .parse(this.#sql.get`SELECT type FROM fs_entries WHERE path = ${parent}`);

    if (!entry) {
      this.#ensureParentExists(parent);
      this.#sql.run`INSERT INTO fs_entries (path, type, mode, size, mtime)
         VALUES (${parent}, 'directory', 493, 0, ${Date.now()})`;
    } else if (entry.type !== 'directory') {
      throw new Error(`mkdir: parent is not a directory: ${parent}`);
    }
  }

  #writeChunks(filePath: string, content: Uint8Array): void {
    this.#sql.run`DELETE FROM fs_chunks WHERE path = ${filePath}`;

    for (let i = 0; i < content.length; i += this.#chunkSize) {
      const chunk = content.slice(
        i,
        Math.min(i + this.#chunkSize, content.length),
      );
      this.#sql
        .run`INSERT INTO fs_chunks (path, chunkIndex, data) VALUES (${filePath}, ${Math.floor(i / this.#chunkSize)}, ${chunk})`;
    }
  }

  #chunks(filePath: string): z.output<typeof chunkRow>[] {
    return z
      .array(chunkRow)
      .parse(
        this.#sql
          .all`SELECT chunkIndex, data FROM fs_chunks WHERE path = ${filePath}`,
      );
  }

  #readChunks(filePath: string): Uint8Array {
    const rows = z
      .array(dataRow)
      .parse(
        this.#sql
          .all`SELECT data FROM fs_chunks WHERE path = ${filePath} ORDER BY chunkIndex`,
      );

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

    const entry = linkRow
      .optional()
      .parse(
        this.#sql
          .get`SELECT type, symlinkTarget FROM fs_entries WHERE path = ${p}`,
      );

    if (!entry) {
      throw new Error(`ENOENT: no such file or directory: ${p}`);
    }

    if (entry.type !== 'symlink') {
      return p;
    }

    seen.add(p);
    const target = this.#normalizePath(
      path.posix.resolve(this.#dirname(p), entry.symlinkTarget),
    );
    return this.#resolveSymlink(target, seen);
  }

  #toUint8Array(content: FileContent, encoding?: BufferEncoding): Uint8Array {
    if (content instanceof Uint8Array) {
      return content;
    }
    return new Uint8Array(Buffer.from(content, encoding ?? 'utf8'));
  }

  // ============================================================================
  // IFileSystem Implementation
  // ============================================================================

  async readFile(
    filePath: string,
    options?: ReadFileOptions | BufferEncoding,
  ): Promise<string> {
    const normalized = this.#normalizePath(filePath);
    const prefixed = this.#prefixPath(normalized);
    const resolved = this.#resolveSymlink(prefixed);

    const entry = typeRow
      .optional()
      .parse(
        this.#sql.get`SELECT type FROM fs_entries WHERE path = ${resolved}`,
      );

    if (!entry) {
      throw new Error(`ENOENT: no such file or directory: ${filePath}`);
    }
    if (entry.type === 'directory') {
      throw new Error(`EISDIR: illegal operation on a directory: ${filePath}`);
    }

    const content = this.#readChunks(resolved);
    const encoding =
      typeof options === 'string' ? options : (options?.encoding ?? 'utf8');
    return Buffer.from(content).toString(encoding);
  }

  async readFileBuffer(filePath: string): Promise<Uint8Array> {
    const normalized = this.#normalizePath(filePath);
    const prefixed = this.#prefixPath(normalized);
    const resolved = this.#resolveSymlink(prefixed);

    const entry = typeRow
      .optional()
      .parse(
        this.#sql.get`SELECT type FROM fs_entries WHERE path = ${resolved}`,
      );

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
    options?: WriteFileOptions | BufferEncoding,
  ): Promise<void> {
    const normalized = this.#normalizePath(filePath);
    const prefixed = this.#prefixPath(normalized);
    const encoding = typeof options === 'string' ? options : options?.encoding;
    const data = this.#toUint8Array(content, encoding);

    transaction(
      this.#db,
      () => {
        this.#ensureParentExists(prefixed);

        this.#sql.run`INSERT INTO fs_entries (path, type, mode, size, mtime)
         VALUES (${prefixed}, 'file', 420, ${data.length}, ${Date.now()})
         ON CONFLICT(path) DO UPDATE SET
           type = 'file',
           size = excluded.size,
           mtime = excluded.mtime`;

        this.#writeChunks(prefixed, data);
      },
      { mode: 'deferred' },
    );
  }

  async appendFile(
    filePath: string,
    content: FileContent,
    options?: WriteFileOptions | BufferEncoding,
  ): Promise<void> {
    const normalized = this.#normalizePath(filePath);
    const prefixed = this.#prefixPath(normalized);
    const encoding = typeof options === 'string' ? options : options?.encoding;
    const newData = this.#toUint8Array(content, encoding);

    transaction(
      this.#db,
      () => {
        this.#ensureParentExists(prefixed);

        const entry = typeRow
          .optional()
          .parse(
            this.#sql.get`SELECT type FROM fs_entries WHERE path = ${prefixed}`,
          );

        if (entry && entry.type !== 'file') {
          throw new Error(`appendFile: not a file: ${filePath}`);
        }

        const existing = entry ? this.#readChunks(prefixed) : new Uint8Array(0);
        const combined = new Uint8Array(existing.length + newData.length);
        combined.set(existing, 0);
        combined.set(newData, existing.length);

        this.#sql.run`INSERT INTO fs_entries (path, type, mode, size, mtime)
         VALUES (${prefixed}, 'file', 420, ${combined.length}, ${Date.now()})
         ON CONFLICT(path) DO UPDATE SET
           size = excluded.size,
           mtime = excluded.mtime`;

        this.#writeChunks(prefixed, combined);
      },
      { mode: 'deferred' },
    );
  }

  async exists(filePath: string): Promise<boolean> {
    const normalized = this.#normalizePath(filePath);
    const prefixed = this.#prefixPath(normalized);
    const row = this.#sql
      .get`SELECT 1 FROM fs_entries WHERE path = ${prefixed}`;
    return row !== undefined;
  }

  async stat(filePath: string): Promise<FsStat> {
    const normalized = this.#normalizePath(filePath);
    const prefixed = this.#prefixPath(normalized);
    const resolved = this.#resolveSymlink(prefixed);

    const entry = entryRow
      .optional()
      .parse(this.#sql.get`SELECT * FROM fs_entries WHERE path = ${resolved}`);

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

    const entry = entryRow
      .optional()
      .parse(this.#sql.get`SELECT * FROM fs_entries WHERE path = ${prefixed}`);

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

    const existing = typeRow
      .optional()
      .parse(
        this.#sql.get`SELECT type FROM fs_entries WHERE path = ${prefixed}`,
      );

    if (existing) {
      if (options?.recursive) {
        return; // Already exists, ok for recursive
      }
      throw new Error(`EEXIST: file already exists: ${dirPath}`);
    }

    transaction(
      this.#db,
      () => {
        if (options?.recursive) {
          const rootPath = this.#root || '/';
          const relativePath = path.posix.relative(rootPath, prefixed);
          const segments = relativePath.split('/').filter(Boolean);
          let currentPath = rootPath;

          for (const segment of segments) {
            currentPath = path.posix.join(currentPath, segment);
            const exists = typeRow
              .optional()
              .parse(
                this.#sql
                  .get`SELECT type FROM fs_entries WHERE path = ${currentPath}`,
              );

            if (!exists) {
              this.#sql
                .run`INSERT INTO fs_entries (path, type, mode, size, mtime)
               VALUES (${currentPath}, 'directory', 493, 0, ${Date.now()})`;
            } else if (exists.type !== 'directory') {
              throw new Error(`mkdir: not a directory: ${currentPath}`);
            }
          }
        } else {
          // Non-recursive: parent must exist
          const parent = this.#dirname(prefixed);
          const parentEntry = typeRow
            .optional()
            .parse(
              this.#sql.get`SELECT type FROM fs_entries WHERE path = ${parent}`,
            );

          if (!parentEntry) {
            throw new Error(`mkdir: parent does not exist: ${parent}`);
          }
          if (parentEntry.type !== 'directory') {
            throw new Error(`mkdir: parent is not a directory: ${parent}`);
          }

          this.#sql.run`INSERT INTO fs_entries (path, type, mode, size, mtime)
           VALUES (${prefixed}, 'directory', 493, 0, ${Date.now()})`;
        }
      },
      { mode: 'deferred' },
    );
  }

  async readdir(dirPath: string): Promise<string[]> {
    const normalized = this.#normalizePath(dirPath);
    const prefixed = this.#prefixPath(normalized);
    const resolved = this.#resolveSymlink(prefixed);

    const entry = typeRow
      .optional()
      .parse(
        this.#sql.get`SELECT type FROM fs_entries WHERE path = ${resolved}`,
      );

    if (!entry) {
      throw new Error(`ENOENT: no such file or directory: ${dirPath}`);
    }
    if (entry.type !== 'directory') {
      throw new Error(`ENOTDIR: not a directory: ${dirPath}`);
    }

    // Get direct children (path starts with dir/ but doesn't have another / after)
    const prefix = resolved === '/' ? '/' : resolved + '/';
    const rows = z.array(pathRow).parse(
      this.#sql.all`SELECT path FROM fs_entries
       WHERE path LIKE ${prefix} || '%'
         AND path != ${resolved}
         AND path NOT LIKE ${prefix} || '%/%'`,
    );

    return rows.map((row) => path.posix.basename(row.path));
  }

  async readdirWithFileTypes(dirPath: string): Promise<DirentEntry[]> {
    const normalized = this.#normalizePath(dirPath);
    const prefixed = this.#prefixPath(normalized);
    const resolved = this.#resolveSymlink(prefixed);

    const entry = typeRow
      .optional()
      .parse(
        this.#sql.get`SELECT type FROM fs_entries WHERE path = ${resolved}`,
      );

    if (!entry) {
      throw new Error(`ENOENT: no such file or directory: ${dirPath}`);
    }
    if (entry.type !== 'directory') {
      throw new Error(`ENOTDIR: not a directory: ${dirPath}`);
    }

    const prefix = resolved === '/' ? '/' : resolved + '/';
    const rows = z.array(pathTypeRow).parse(
      this.#sql.all`SELECT path, type FROM fs_entries
       WHERE path LIKE ${prefix} || '%'
         AND path != ${resolved}
         AND path NOT LIKE ${prefix} || '%/%'`,
    );

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

    const entry = typeRow
      .optional()
      .parse(
        this.#sql.get`SELECT type FROM fs_entries WHERE path = ${prefixed}`,
      );

    if (!entry) {
      if (options?.force) {
        return;
      }
      throw new Error(`ENOENT: no such file or directory: ${filePath}`);
    }

    transaction(
      this.#db,
      () => {
        if (entry.type === 'directory') {
          const children = this.#sql
            .get`SELECT 1 FROM fs_entries WHERE path LIKE ${prefixed} || '/%' LIMIT 1`;

          if (children && !options?.recursive) {
            throw new Error(`ENOTEMPTY: directory not empty: ${filePath}`);
          }

          // Chunks cascade via FK
          this.#sql
            .run`DELETE FROM fs_entries WHERE path = ${prefixed} OR path LIKE ${prefixed} || '/%'`;
        } else {
          this.#sql.run`DELETE FROM fs_entries WHERE path = ${prefixed}`;
        }
      },
      { mode: 'deferred' },
    );
  }

  async cp(src: string, dest: string, options?: CpOptions): Promise<void> {
    const srcNormalized = this.#normalizePath(src);
    const destNormalized = this.#normalizePath(dest);
    const srcPrefixed = this.#prefixPath(srcNormalized);
    const destPrefixed = this.#prefixPath(destNormalized);

    const srcEntry = entryRow
      .optional()
      .parse(
        this.#sql.get`SELECT * FROM fs_entries WHERE path = ${srcPrefixed}`,
      );

    if (!srcEntry) {
      throw new Error(`ENOENT: no such file or directory: ${src}`);
    }

    if (srcEntry.type === 'directory' && !options?.recursive) {
      throw new Error(`cp: -r not specified; omitting directory: ${src}`);
    }

    transaction(
      this.#db,
      () => {
        this.#ensureParentExists(destPrefixed);

        if (srcEntry.type === 'directory') {
          const allEntries = z
            .array(entryRow)
            .parse(
              this.#sql
                .all`SELECT * FROM fs_entries WHERE path = ${srcPrefixed} OR path LIKE ${srcPrefixed} || '/%'`,
            );

          for (const entry of allEntries) {
            const relativePath = path.posix.relative(srcPrefixed, entry.path);
            const newPath = path.posix.join(destPrefixed, relativePath);

            this.#sql
              .run`INSERT OR REPLACE INTO fs_entries (path, type, mode, size, mtime, symlinkTarget)
             VALUES (${newPath}, ${entry.type}, ${entry.mode}, ${entry.size}, ${Date.now()}, ${entry.symlinkTarget})`;

            if (entry.type === 'file') {
              const chunks = this.#chunks(entry.path);

              for (const chunk of chunks) {
                this.#sql
                  .run`INSERT INTO fs_chunks (path, chunkIndex, data) VALUES (${newPath}, ${chunk.chunkIndex}, ${chunk.data})`;
              }
            }
          }
        } else {
          this.#sql
            .run`INSERT OR REPLACE INTO fs_entries (path, type, mode, size, mtime, symlinkTarget)
           VALUES (${destPrefixed}, ${srcEntry.type}, ${srcEntry.mode}, ${srcEntry.size}, ${Date.now()}, ${srcEntry.symlinkTarget})`;

          if (srcEntry.type === 'file') {
            const chunks = this.#chunks(srcPrefixed);

            this.#sql.run`DELETE FROM fs_chunks WHERE path = ${destPrefixed}`;

            for (const chunk of chunks) {
              this.#sql
                .run`INSERT INTO fs_chunks (path, chunkIndex, data) VALUES (${destPrefixed}, ${chunk.chunkIndex}, ${chunk.data})`;
            }
          }
        }
      },
      { mode: 'deferred' },
    );
  }

  async mv(src: string, dest: string): Promise<void> {
    const srcNormalized = this.#normalizePath(src);
    const destNormalized = this.#normalizePath(dest);
    const srcPrefixed = this.#prefixPath(srcNormalized);
    const destPrefixed = this.#prefixPath(destNormalized);

    const srcEntry = entryRow
      .optional()
      .parse(
        this.#sql.get`SELECT * FROM fs_entries WHERE path = ${srcPrefixed}`,
      );

    if (!srcEntry) {
      throw new Error(`ENOENT: no such file or directory: ${src}`);
    }

    transaction(
      this.#db,
      () => {
        this.#ensureParentExists(destPrefixed);

        if (srcEntry.type === 'directory') {
          // Reverse order: children before parents for delete
          const allEntries = z
            .array(entryRow)
            .parse(
              this.#sql
                .all`SELECT * FROM fs_entries WHERE path = ${srcPrefixed} OR path LIKE ${srcPrefixed} || '/%' ORDER BY path DESC`,
            );

          for (const entry of [...allEntries].reverse()) {
            const relativePath = path.posix.relative(srcPrefixed, entry.path);
            const newPath = path.posix.join(destPrefixed, relativePath);

            this.#sql
              .run`INSERT INTO fs_entries (path, type, mode, size, mtime, symlinkTarget)
             VALUES (${newPath}, ${entry.type}, ${entry.mode}, ${entry.size}, ${Date.now()}, ${entry.symlinkTarget})`;

            if (entry.type === 'file') {
              const chunks = this.#chunks(entry.path);

              for (const chunk of chunks) {
                this.#sql
                  .run`INSERT INTO fs_chunks (path, chunkIndex, data) VALUES (${newPath}, ${chunk.chunkIndex}, ${chunk.data})`;
              }
            }
          }

          // Chunks cascade via FK
          this.#sql
            .run`DELETE FROM fs_entries WHERE path = ${srcPrefixed} OR path LIKE ${srcPrefixed} || '/%'`;
        } else {
          this.#sql
            .run`INSERT INTO fs_entries (path, type, mode, size, mtime, symlinkTarget)
           VALUES (${destPrefixed}, ${srcEntry.type}, ${srcEntry.mode}, ${srcEntry.size}, ${Date.now()}, ${srcEntry.symlinkTarget})`;

          if (srcEntry.type === 'file') {
            const chunks = this.#chunks(srcPrefixed);

            for (const chunk of chunks) {
              this.#sql
                .run`INSERT INTO fs_chunks (path, chunkIndex, data) VALUES (${destPrefixed}, ${chunk.chunkIndex}, ${chunk.data})`;
            }
          }

          this.#sql.run`DELETE FROM fs_entries WHERE path = ${srcPrefixed}`;
        }
      },
      { mode: 'deferred' },
    );
  }

  resolvePath(base: string, relativePath: string): string {
    return path.posix.resolve(base, relativePath);
  }

  getAllPaths(): string[] {
    const rows = z
      .array(pathRow)
      .parse(this.#sql.all`SELECT path FROM fs_entries ORDER BY path`);
    return rows.map((row) => row.path);
  }

  async realpath(filePath: string): Promise<string> {
    const normalized = this.#normalizePath(filePath);
    const prefixed = this.#prefixPath(normalized);
    const resolved = this.#resolveSymlink(prefixed);

    const exists = this.#sql
      .get`SELECT 1 FROM fs_entries WHERE path = ${resolved}`;
    if (!exists) {
      throw new Error(`ENOENT: no such file or directory: ${filePath}`);
    }

    return this.#unprefixPath(resolved);
  }

  async utimes(filePath: string, _atime: Date, mtime: Date): Promise<void> {
    const normalized = this.#normalizePath(filePath);
    const prefixed = this.#prefixPath(normalized);
    const resolved = this.#resolveSymlink(prefixed);

    const result = this.#sql
      .run`UPDATE fs_entries SET mtime = ${mtime.getTime()} WHERE path = ${resolved}`;

    if (result.changes === 0) {
      throw new Error(`ENOENT: no such file or directory: ${filePath}`);
    }
  }

  async chmod(filePath: string, mode: number): Promise<void> {
    const normalized = this.#normalizePath(filePath);
    const prefixed = this.#prefixPath(normalized);

    const result = this.#sql
      .run`UPDATE fs_entries SET mode = ${mode} WHERE path = ${prefixed}`;

    if (result.changes === 0) {
      throw new Error(`ENOENT: no such file or directory: ${filePath}`);
    }
  }

  async symlink(target: string, linkPath: string): Promise<void> {
    const normalized = this.#normalizePath(linkPath);
    const prefixed = this.#prefixPath(normalized);

    const existing = this.#sql
      .get`SELECT 1 FROM fs_entries WHERE path = ${prefixed}`;
    if (existing) {
      throw new Error(`EEXIST: file already exists: ${linkPath}`);
    }

    transaction(
      this.#db,
      () => {
        this.#ensureParentExists(prefixed);

        this.#sql
          .run`INSERT INTO fs_entries (path, type, mode, size, mtime, symlinkTarget)
         VALUES (${prefixed}, 'symlink', 511, 0, ${Date.now()}, ${target})`;
      },
      { mode: 'deferred' },
    );
  }

  async link(existingPath: string, newPath: string): Promise<void> {
    const srcNormalized = this.#normalizePath(existingPath);
    const destNormalized = this.#normalizePath(newPath);
    const srcPrefixed = this.#prefixPath(srcNormalized);
    const destPrefixed = this.#prefixPath(destNormalized);

    const srcEntry = entryRow
      .optional()
      .parse(
        this.#sql.get`SELECT * FROM fs_entries WHERE path = ${srcPrefixed}`,
      );

    if (!srcEntry) {
      throw new Error(`ENOENT: no such file or directory: ${existingPath}`);
    }

    if (srcEntry.type !== 'file') {
      throw new Error(`link: not supported for directories: ${existingPath}`);
    }

    const existing = this.#sql
      .get`SELECT 1 FROM fs_entries WHERE path = ${destPrefixed}`;
    if (existing) {
      throw new Error(`EEXIST: file already exists: ${newPath}`);
    }

    // Hard link: duplicate the entry and chunks
    transaction(
      this.#db,
      () => {
        this.#ensureParentExists(destPrefixed);

        this.#sql.run`INSERT INTO fs_entries (path, type, mode, size, mtime)
         VALUES (${destPrefixed}, 'file', ${srcEntry.mode}, ${srcEntry.size}, ${Date.now()})`;

        const chunks = this.#chunks(srcPrefixed);

        for (const chunk of chunks) {
          this.#sql
            .run`INSERT INTO fs_chunks (path, chunkIndex, data) VALUES (${destPrefixed}, ${chunk.chunkIndex}, ${chunk.data})`;
        }
      },
      { mode: 'deferred' },
    );
  }

  async readlink(linkPath: string): Promise<string> {
    const normalized = this.#normalizePath(linkPath);
    const prefixed = this.#prefixPath(normalized);

    const entry = linkRow
      .optional()
      .parse(
        this.#sql
          .get`SELECT type, symlinkTarget FROM fs_entries WHERE path = ${prefixed}`,
      );

    if (!entry) {
      throw new Error(`ENOENT: no such file or directory: ${linkPath}`);
    }

    if (entry.type !== 'symlink') {
      throw new Error(`readlink: not a symbolic link: ${linkPath}`);
    }

    return entry.symlinkTarget;
  }
}
