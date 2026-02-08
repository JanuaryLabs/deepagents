import type {
  CpOptions,
  FileContent,
  FsStat,
  IFileSystem,
  MkdirOptions,
  RmOptions,
} from 'just-bash';
import type { ConnectionPool, Transaction, config } from 'mssql';
import { createRequire } from 'node:module';
import * as path from 'node:path';

import MSSQL_FS_DDL from './ddl.mssql-fs.sql';

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

export interface MssqlFsOptions {
  /** SQL Server connection pool configuration. Can be a connection string or config object. */
  pool: config | string;
  /** Root path prefix for all operations */
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
  [key: string]: unknown;
}

interface ChunkRow {
  data: Buffer;
  [key: string]: unknown;
}

export class MssqlFs implements IFileSystem {
  #pool: ConnectionPool;
  #chunkSize: number;
  #root: string;
  #initialized: Promise<void>;

  constructor(options: MssqlFsOptions) {
    this.#chunkSize = options.chunkSize ?? 1024 * 1024;
    const normalizedRoot = this.#normalizeRoot(options.root);
    this.#root = normalizedRoot === '/' ? '' : normalizedRoot;

    const mssql = MssqlFs.#requireMssql();
    this.#pool = new mssql.ConnectionPool(options.pool);

    this.#initialized = this.#initialize();
  }

  static #requireMssql(): typeof import('mssql') {
    try {
      const require = createRequire(import.meta.url);
      return require('mssql');
    } catch {
      throw new Error(
        'MssqlFs requires the "mssql" package. Install it with: npm install mssql',
      );
    }
  }

  async #initialize(): Promise<void> {
    await this.#pool.connect();

    const batches = MSSQL_FS_DDL.split(/\bGO\b/i).filter((b) => b.trim());
    for (const batch of batches) {
      if (batch.trim()) {
        await this.#pool.request().batch(batch);
      }
    }

    const rootSlashExists = await this.#query<{ exists: number }>(
      "SELECT CASE WHEN EXISTS(SELECT 1 FROM fs_entries WHERE path = '/') THEN 1 ELSE 0 END as [exists]",
    );
    if (rootSlashExists[0].exists === 0) {
      await this.#exec(
        `INSERT INTO fs_entries (path, type, mode, size, mtime) VALUES ('/', 'directory', 493, 0, @p0)`,
        [Date.now()],
      );
    }

    if (this.#root) {
      await this.#createParentDirs(this.#root);

      const rootExists = await this.#query<{ exists: number }>(
        `SELECT CASE WHEN EXISTS(SELECT 1 FROM fs_entries WHERE path = @p0) THEN 1 ELSE 0 END as [exists]`,
        [this.#root],
      );
      if (rootExists[0].exists === 0) {
        await this.#exec(
          `INSERT INTO fs_entries (path, type, mode, size, mtime) VALUES (@p0, 'directory', 493, 0, @p1)`,
          [this.#root, Date.now()],
        );
      }
    }
  }

  async #ensureInitialized(): Promise<void> {
    await this.#initialized;
  }

  async #createParentDirs(p: string): Promise<void> {
    const segments = p.split('/').filter(Boolean);
    let currentPath = '/';

    for (let i = 0; i < segments.length - 1; i++) {
      currentPath = path.posix.join(currentPath, segments[i]);
      const exists = await this.#query<{ exists: number }>(
        `SELECT CASE WHEN EXISTS(SELECT 1 FROM fs_entries WHERE path = @p0) THEN 1 ELSE 0 END as [exists]`,
        [currentPath],
      );

      if (exists[0].exists === 0) {
        await this.#exec(
          `INSERT INTO fs_entries (path, type, mode, size, mtime) VALUES (@p0, 'directory', 493, 0, @p1)`,
          [currentPath, Date.now()],
        );
      }
    }
  }

  async #query<T extends Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<T[]> {
    await this.#ensureInitialized();
    const request = this.#pool.request();
    params?.forEach((value, index) => {
      request.input(`p${index}`, value);
    });
    const result = await request.query(sql);
    return result.recordset as T[];
  }

  async #exec(sql: string, params?: unknown[]): Promise<number> {
    await this.#ensureInitialized();
    const request = this.#pool.request();
    params?.forEach((value, index) => {
      request.input(`p${index}`, value);
    });
    const result = await request.query(sql);
    return result.rowsAffected[0] ?? 0;
  }

  async #useTransaction<T>(
    fn: (transaction: Transaction) => Promise<T>,
  ): Promise<T> {
    await this.#ensureInitialized();
    const mssql = MssqlFs.#requireMssql();
    const transaction = new mssql.Transaction(this.#pool);
    try {
      await transaction.begin();
      const result = await fn(transaction);
      await transaction.commit();
      return result;
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }

  #normalizeRoot(root: string): string {
    return path.posix.resolve('/', root.trim());
  }

  #prefixPath(p: string): string {
    if (!this.#root) {
      return p;
    }
    if (p === '/') {
      return this.#root;
    }
    return path.posix.join(this.#root, p);
  }

  #normalizePath(p: string): string {
    return path.posix.resolve('/', p);
  }

  #dirname(p: string): string {
    const dir = path.posix.dirname(p);
    return dir === '' ? '/' : dir;
  }

  async #ensureParentExists(
    filePath: string,
    transaction: Transaction,
  ): Promise<void> {
    const parent = this.#dirname(filePath);
    const rootPath = this.#root || '/';
    if (parent === rootPath || parent === '/') return;

    const request = transaction.request();
    request.input('p0', parent);
    const result = await request.query<{ type: string }>(
      'SELECT type FROM fs_entries WHERE path = @p0',
    );
    const entry = result.recordset[0];

    if (!entry) {
      await this.#ensureParentExists(parent, transaction);
      const insertReq = transaction.request();
      insertReq.input('p0', parent);
      insertReq.input('p1', Date.now());
      await insertReq.query(
        `INSERT INTO fs_entries (path, type, mode, size, mtime) VALUES (@p0, 'directory', 493, 0, @p1)`,
      );
    } else if (entry.type !== 'directory') {
      throw new Error(`mkdir: parent is not a directory: ${parent}`);
    }
  }

  async #writeChunks(
    filePath: string,
    content: Uint8Array,
    transaction: Transaction,
  ): Promise<void> {
    const deleteReq = transaction.request();
    deleteReq.input('p0', filePath);
    await deleteReq.query('DELETE FROM fs_chunks WHERE path = @p0');

    for (let i = 0; i < content.length; i += this.#chunkSize) {
      const chunk = content.slice(
        i,
        Math.min(i + this.#chunkSize, content.length),
      );
      const insertReq = transaction.request();
      insertReq.input('p0', filePath);
      insertReq.input('p1', Math.floor(i / this.#chunkSize));
      insertReq.input('p2', Buffer.from(chunk));
      await insertReq.query(
        'INSERT INTO fs_chunks (path, chunkIndex, data) VALUES (@p0, @p1, @p2)',
      );
    }
  }

  async #readChunks(filePath: string): Promise<Uint8Array> {
    const rows = await this.#query<ChunkRow>(
      'SELECT data FROM fs_chunks WHERE path = @p0 ORDER BY chunkIndex',
      [filePath],
    );

    if (rows.length === 0) {
      return new Uint8Array(0);
    }

    const totalSize = rows.reduce((sum, row) => sum + row.data.length, 0);
    const result = new Uint8Array(totalSize);
    let offset = 0;

    for (const row of rows) {
      result.set(new Uint8Array(row.data), offset);
      offset += row.data.length;
    }

    return result;
  }

  async #resolveSymlink(p: string, seen = new Set<string>()): Promise<string> {
    if (seen.has(p)) {
      throw new Error(`readFile: circular symlink: ${p}`);
    }

    const rows = await this.#query<Pick<FsEntryRow, 'type' | 'symlinkTarget'>>(
      'SELECT type, symlinkTarget FROM fs_entries WHERE path = @p0',
      [p],
    );
    const entry = rows[0];

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

  async close(): Promise<void> {
    try {
      await this.#initialized;
    } catch {
      // Ignore initialization errors when closing
    }
    await this.#pool.close();
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
    const resolved = await this.#resolveSymlink(prefixed);

    const rows = await this.#query<Pick<FsEntryRow, 'type'>>(
      'SELECT type FROM fs_entries WHERE path = @p0',
      [resolved],
    );
    const entry = rows[0];

    if (!entry) {
      throw new Error(`ENOENT: no such file or directory: ${filePath}`);
    }
    if (entry.type === 'directory') {
      throw new Error(`EISDIR: illegal operation on a directory: ${filePath}`);
    }

    const content = await this.#readChunks(resolved);
    const encoding =
      typeof options === 'string' ? options : (options?.encoding ?? 'utf8');
    return Buffer.from(content).toString(encoding as BufferEncoding);
  }

  async readFileBuffer(filePath: string): Promise<Uint8Array> {
    const normalized = this.#normalizePath(filePath);
    const prefixed = this.#prefixPath(normalized);
    const resolved = await this.#resolveSymlink(prefixed);

    const rows = await this.#query<Pick<FsEntryRow, 'type'>>(
      'SELECT type FROM fs_entries WHERE path = @p0',
      [resolved],
    );
    const entry = rows[0];

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

    await this.#useTransaction(async (transaction) => {
      await this.#ensureParentExists(prefixed, transaction);

      const request = transaction.request();
      request.input('p0', prefixed);
      request.input('p1', data.length);
      request.input('p2', Date.now());

      await request.query(`
        MERGE fs_entries AS target
        USING (SELECT @p0 AS path) AS source
        ON target.path = source.path
        WHEN MATCHED THEN
          UPDATE SET type = 'file', size = @p1, mtime = @p2
        WHEN NOT MATCHED THEN
          INSERT (path, type, mode, size, mtime)
          VALUES (@p0, 'file', 420, @p1, @p2);
      `);

      await this.#writeChunks(prefixed, data, transaction);
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

    await this.#useTransaction(async (transaction) => {
      await this.#ensureParentExists(prefixed, transaction);

      const checkReq = transaction.request();
      checkReq.input('p0', prefixed);
      const result = await checkReq.query<Pick<FsEntryRow, 'type'>>(
        'SELECT type FROM fs_entries WHERE path = @p0',
      );
      const entry = result.recordset[0];

      if (entry && entry.type !== 'file') {
        throw new Error(`appendFile: not a file: ${filePath}`);
      }

      const existing = entry
        ? await this.#readChunks(prefixed)
        : new Uint8Array(0);
      const combined = new Uint8Array(existing.length + newData.length);
      combined.set(existing, 0);
      combined.set(newData, existing.length);

      const upsertReq = transaction.request();
      upsertReq.input('p0', prefixed);
      upsertReq.input('p1', combined.length);
      upsertReq.input('p2', Date.now());

      await upsertReq.query(`
        MERGE fs_entries AS target
        USING (SELECT @p0 AS path) AS source
        ON target.path = source.path
        WHEN MATCHED THEN
          UPDATE SET size = @p1, mtime = @p2
        WHEN NOT MATCHED THEN
          INSERT (path, type, mode, size, mtime)
          VALUES (@p0, 'file', 420, @p1, @p2);
      `);

      await this.#writeChunks(prefixed, combined, transaction);
    });
  }

  async exists(filePath: string): Promise<boolean> {
    const normalized = this.#normalizePath(filePath);
    const prefixed = this.#prefixPath(normalized);
    const rows = await this.#query<{ exists: number }>(
      'SELECT CASE WHEN EXISTS(SELECT 1 FROM fs_entries WHERE path = @p0) THEN 1 ELSE 0 END as [exists]',
      [prefixed],
    );
    return rows[0].exists === 1;
  }

  async stat(filePath: string): Promise<FsStat> {
    const normalized = this.#normalizePath(filePath);
    const prefixed = this.#prefixPath(normalized);
    const resolved = await this.#resolveSymlink(prefixed);

    const rows = await this.#query<FsEntryRow>(
      'SELECT * FROM fs_entries WHERE path = @p0',
      [resolved],
    );
    const entry = rows[0];

    if (!entry) {
      throw new Error(`ENOENT: no such file or directory: ${filePath}`);
    }

    return {
      isFile: entry.type === 'file',
      isDirectory: entry.type === 'directory',
      isSymbolicLink: false,
      mode: entry.mode,
      size: entry.size,
      mtime: new Date(entry.mtime),
    };
  }

  async lstat(filePath: string): Promise<FsStat> {
    const normalized = this.#normalizePath(filePath);
    const prefixed = this.#prefixPath(normalized);

    const rows = await this.#query<FsEntryRow>(
      'SELECT * FROM fs_entries WHERE path = @p0',
      [prefixed],
    );
    const entry = rows[0];

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

    const existingRows = await this.#query<Pick<FsEntryRow, 'type'>>(
      'SELECT type FROM fs_entries WHERE path = @p0',
      [prefixed],
    );
    const existing = existingRows[0];

    if (existing) {
      if (options?.recursive) {
        return;
      }
      throw new Error(`EEXIST: file already exists: ${dirPath}`);
    }

    await this.#useTransaction(async (transaction) => {
      if (options?.recursive) {
        const rootPath = this.#root || '/';
        const relativePath = path.posix.relative(rootPath, prefixed);
        const segments = relativePath.split('/').filter(Boolean);
        let currentPath = rootPath;

        for (const segment of segments) {
          currentPath = path.posix.join(currentPath, segment);
          const checkReq = transaction.request();
          checkReq.input('p0', currentPath);
          const result = await checkReq.query<Pick<FsEntryRow, 'type'>>(
            'SELECT type FROM fs_entries WHERE path = @p0',
          );
          const exists = result.recordset[0];

          if (!exists) {
            const insertReq = transaction.request();
            insertReq.input('p0', currentPath);
            insertReq.input('p1', Date.now());
            await insertReq.query(
              `INSERT INTO fs_entries (path, type, mode, size, mtime) VALUES (@p0, 'directory', 493, 0, @p1)`,
            );
          } else if (exists.type !== 'directory') {
            throw new Error(`mkdir: not a directory: ${currentPath}`);
          }
        }
      } else {
        const parent = this.#dirname(prefixed);
        const parentReq = transaction.request();
        parentReq.input('p0', parent);
        const parentResult = await parentReq.query<Pick<FsEntryRow, 'type'>>(
          'SELECT type FROM fs_entries WHERE path = @p0',
        );
        const parentEntry = parentResult.recordset[0];

        if (!parentEntry) {
          throw new Error(`mkdir: parent does not exist: ${parent}`);
        }
        if (parentEntry.type !== 'directory') {
          throw new Error(`mkdir: parent is not a directory: ${parent}`);
        }

        const insertReq = transaction.request();
        insertReq.input('p0', prefixed);
        insertReq.input('p1', Date.now());
        await insertReq.query(
          `INSERT INTO fs_entries (path, type, mode, size, mtime) VALUES (@p0, 'directory', 493, 0, @p1)`,
        );
      }
    });
  }

  async readdir(dirPath: string): Promise<string[]> {
    const normalized = this.#normalizePath(dirPath);
    const prefixed = this.#prefixPath(normalized);
    const resolved = await this.#resolveSymlink(prefixed);

    const entryRows = await this.#query<Pick<FsEntryRow, 'type'>>(
      'SELECT type FROM fs_entries WHERE path = @p0',
      [resolved],
    );
    const entry = entryRows[0];

    if (!entry) {
      throw new Error(`ENOENT: no such file or directory: ${dirPath}`);
    }
    if (entry.type !== 'directory') {
      throw new Error(`ENOTDIR: not a directory: ${dirPath}`);
    }

    const prefix = resolved === '/' ? '/' : resolved + '/';
    const rows = await this.#query<{ path: string }>(
      `SELECT path FROM fs_entries
       WHERE path LIKE @p0 + '%'
         AND path != @p1
         AND path NOT LIKE @p0 + '%/%'`,
      [prefix, resolved],
    );

    return rows.map((row) => path.posix.basename(row.path));
  }

  async readdirWithFileTypes(dirPath: string): Promise<DirentEntry[]> {
    const normalized = this.#normalizePath(dirPath);
    const prefixed = this.#prefixPath(normalized);
    const resolved = await this.#resolveSymlink(prefixed);

    const entryRows = await this.#query<Pick<FsEntryRow, 'type'>>(
      'SELECT type FROM fs_entries WHERE path = @p0',
      [resolved],
    );
    const entry = entryRows[0];

    if (!entry) {
      throw new Error(`ENOENT: no such file or directory: ${dirPath}`);
    }
    if (entry.type !== 'directory') {
      throw new Error(`ENOTDIR: not a directory: ${dirPath}`);
    }

    const prefix = resolved === '/' ? '/' : resolved + '/';
    const rows = await this.#query<Pick<FsEntryRow, 'path' | 'type'>>(
      `SELECT path, type FROM fs_entries
       WHERE path LIKE @p0 + '%'
         AND path != @p1
         AND path NOT LIKE @p0 + '%/%'`,
      [prefix, resolved],
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

    const rows = await this.#query<Pick<FsEntryRow, 'type'>>(
      'SELECT type FROM fs_entries WHERE path = @p0',
      [prefixed],
    );
    const entry = rows[0];

    if (!entry) {
      if (options?.force) {
        return;
      }
      throw new Error(`ENOENT: no such file or directory: ${filePath}`);
    }

    await this.#useTransaction(async (transaction) => {
      if (entry.type === 'directory') {
        const childrenReq = transaction.request();
        childrenReq.input('p0', prefixed);
        const childrenResult = await childrenReq.query<{ exists: number }>(
          `SELECT CASE WHEN EXISTS(SELECT 1 FROM fs_entries WHERE path LIKE @p0 + '/%') THEN 1 ELSE 0 END as [exists]`,
        );

        if (childrenResult.recordset[0].exists === 1 && !options?.recursive) {
          throw new Error(`ENOTEMPTY: directory not empty: ${filePath}`);
        }

        const deleteReq = transaction.request();
        deleteReq.input('p0', prefixed);
        await deleteReq.query(
          `DELETE FROM fs_entries WHERE path = @p0 OR path LIKE @p0 + '/%'`,
        );
      } else {
        const deleteReq = transaction.request();
        deleteReq.input('p0', prefixed);
        await deleteReq.query('DELETE FROM fs_entries WHERE path = @p0');
      }
    });
  }

  async cp(src: string, dest: string, options?: CpOptions): Promise<void> {
    const srcNormalized = this.#normalizePath(src);
    const destNormalized = this.#normalizePath(dest);
    const srcPrefixed = this.#prefixPath(srcNormalized);
    const destPrefixed = this.#prefixPath(destNormalized);

    const srcRows = await this.#query<FsEntryRow>(
      'SELECT * FROM fs_entries WHERE path = @p0',
      [srcPrefixed],
    );
    const srcEntry = srcRows[0];

    if (!srcEntry) {
      throw new Error(`ENOENT: no such file or directory: ${src}`);
    }

    if (srcEntry.type === 'directory' && !options?.recursive) {
      throw new Error(`cp: -r not specified; omitting directory: ${src}`);
    }

    await this.#useTransaction(async (transaction) => {
      await this.#ensureParentExists(destPrefixed, transaction);

      if (srcEntry.type === 'directory') {
        const allEntriesReq = transaction.request();
        allEntriesReq.input('p0', srcPrefixed);
        const allEntriesResult = await allEntriesReq.query<FsEntryRow>(
          `SELECT * FROM fs_entries WHERE path = @p0 OR path LIKE @p0 + '/%'`,
        );

        for (const entry of allEntriesResult.recordset) {
          const relativePath = path.posix.relative(srcPrefixed, entry.path);
          const newPath = path.posix.join(destPrefixed, relativePath);

          const insertReq = transaction.request();
          insertReq.input('p0', newPath);
          insertReq.input('p1', entry.type);
          insertReq.input('p2', entry.mode);
          insertReq.input('p3', entry.size);
          insertReq.input('p4', Date.now());
          insertReq.input('p5', entry.symlinkTarget);

          await insertReq.query(`
            MERGE fs_entries AS target
            USING (SELECT @p0 AS path) AS source
            ON target.path = source.path
            WHEN MATCHED THEN
              UPDATE SET type = @p1, mode = @p2, size = @p3, mtime = @p4, symlinkTarget = @p5
            WHEN NOT MATCHED THEN
              INSERT (path, type, mode, size, mtime, symlinkTarget)
              VALUES (@p0, @p1, @p2, @p3, @p4, @p5);
          `);

          if (entry.type === 'file') {
            const deleteChunksReq = transaction.request();
            deleteChunksReq.input('p0', newPath);
            await deleteChunksReq.query(
              'DELETE FROM fs_chunks WHERE path = @p0',
            );

            const chunksReq = transaction.request();
            chunksReq.input('p0', entry.path);
            const chunksResult = await chunksReq.query<{
              chunkIndex: number;
              data: Buffer;
            }>('SELECT chunkIndex, data FROM fs_chunks WHERE path = @p0');

            for (const chunk of chunksResult.recordset) {
              const chunkInsertReq = transaction.request();
              chunkInsertReq.input('p0', newPath);
              chunkInsertReq.input('p1', chunk.chunkIndex);
              chunkInsertReq.input('p2', chunk.data);
              await chunkInsertReq.query(
                'INSERT INTO fs_chunks (path, chunkIndex, data) VALUES (@p0, @p1, @p2)',
              );
            }
          }
        }
      } else {
        const insertReq = transaction.request();
        insertReq.input('p0', destPrefixed);
        insertReq.input('p1', srcEntry.type);
        insertReq.input('p2', srcEntry.mode);
        insertReq.input('p3', srcEntry.size);
        insertReq.input('p4', Date.now());
        insertReq.input('p5', srcEntry.symlinkTarget);

        await insertReq.query(`
          MERGE fs_entries AS target
          USING (SELECT @p0 AS path) AS source
          ON target.path = source.path
          WHEN MATCHED THEN
            UPDATE SET type = @p1, mode = @p2, size = @p3, mtime = @p4, symlinkTarget = @p5
          WHEN NOT MATCHED THEN
            INSERT (path, type, mode, size, mtime, symlinkTarget)
            VALUES (@p0, @p1, @p2, @p3, @p4, @p5);
        `);

        if (srcEntry.type === 'file') {
          const chunksReq = transaction.request();
          chunksReq.input('p0', srcPrefixed);
          const chunksResult = await chunksReq.query<{
            chunkIndex: number;
            data: Buffer;
          }>('SELECT chunkIndex, data FROM fs_chunks WHERE path = @p0');

          const deleteChunksReq = transaction.request();
          deleteChunksReq.input('p0', destPrefixed);
          await deleteChunksReq.query('DELETE FROM fs_chunks WHERE path = @p0');

          for (const chunk of chunksResult.recordset) {
            const chunkInsertReq = transaction.request();
            chunkInsertReq.input('p0', destPrefixed);
            chunkInsertReq.input('p1', chunk.chunkIndex);
            chunkInsertReq.input('p2', chunk.data);
            await chunkInsertReq.query(
              'INSERT INTO fs_chunks (path, chunkIndex, data) VALUES (@p0, @p1, @p2)',
            );
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

    const srcRows = await this.#query<FsEntryRow>(
      'SELECT * FROM fs_entries WHERE path = @p0',
      [srcPrefixed],
    );
    const srcEntry = srcRows[0];

    if (!srcEntry) {
      throw new Error(`ENOENT: no such file or directory: ${src}`);
    }

    await this.#useTransaction(async (transaction) => {
      await this.#ensureParentExists(destPrefixed, transaction);

      if (srcEntry.type === 'directory') {
        const allEntriesReq = transaction.request();
        allEntriesReq.input('p0', srcPrefixed);
        const allEntriesResult = await allEntriesReq.query<FsEntryRow>(
          `SELECT * FROM fs_entries WHERE path = @p0 OR path LIKE @p0 + '/%' ORDER BY path DESC`,
        );

        for (const entry of [...allEntriesResult.recordset].reverse()) {
          const relativePath = path.posix.relative(srcPrefixed, entry.path);
          const newPath = path.posix.join(destPrefixed, relativePath);

          const insertReq = transaction.request();
          insertReq.input('p0', newPath);
          insertReq.input('p1', entry.type);
          insertReq.input('p2', entry.mode);
          insertReq.input('p3', entry.size);
          insertReq.input('p4', Date.now());
          insertReq.input('p5', entry.symlinkTarget);

          await insertReq.query(
            `INSERT INTO fs_entries (path, type, mode, size, mtime, symlinkTarget)
             VALUES (@p0, @p1, @p2, @p3, @p4, @p5)`,
          );

          if (entry.type === 'file') {
            const chunksReq = transaction.request();
            chunksReq.input('p0', entry.path);
            const chunksResult = await chunksReq.query<{
              chunkIndex: number;
              data: Buffer;
            }>('SELECT chunkIndex, data FROM fs_chunks WHERE path = @p0');

            for (const chunk of chunksResult.recordset) {
              const chunkInsertReq = transaction.request();
              chunkInsertReq.input('p0', newPath);
              chunkInsertReq.input('p1', chunk.chunkIndex);
              chunkInsertReq.input('p2', chunk.data);
              await chunkInsertReq.query(
                'INSERT INTO fs_chunks (path, chunkIndex, data) VALUES (@p0, @p1, @p2)',
              );
            }
          }
        }

        const deleteReq = transaction.request();
        deleteReq.input('p0', srcPrefixed);
        await deleteReq.query(
          `DELETE FROM fs_entries WHERE path = @p0 OR path LIKE @p0 + '/%'`,
        );
      } else {
        const insertReq = transaction.request();
        insertReq.input('p0', destPrefixed);
        insertReq.input('p1', srcEntry.type);
        insertReq.input('p2', srcEntry.mode);
        insertReq.input('p3', srcEntry.size);
        insertReq.input('p4', Date.now());
        insertReq.input('p5', srcEntry.symlinkTarget);

        await insertReq.query(
          `INSERT INTO fs_entries (path, type, mode, size, mtime, symlinkTarget)
           VALUES (@p0, @p1, @p2, @p3, @p4, @p5)`,
        );

        if (srcEntry.type === 'file') {
          const chunksReq = transaction.request();
          chunksReq.input('p0', srcPrefixed);
          const chunksResult = await chunksReq.query<{
            chunkIndex: number;
            data: Buffer;
          }>('SELECT chunkIndex, data FROM fs_chunks WHERE path = @p0');

          for (const chunk of chunksResult.recordset) {
            const chunkInsertReq = transaction.request();
            chunkInsertReq.input('p0', destPrefixed);
            chunkInsertReq.input('p1', chunk.chunkIndex);
            chunkInsertReq.input('p2', chunk.data);
            await chunkInsertReq.query(
              'INSERT INTO fs_chunks (path, chunkIndex, data) VALUES (@p0, @p1, @p2)',
            );
          }
        }

        const deleteReq = transaction.request();
        deleteReq.input('p0', srcPrefixed);
        await deleteReq.query('DELETE FROM fs_entries WHERE path = @p0');
      }
    });
  }

  resolvePath(base: string, relativePath: string): string {
    return path.posix.resolve(base, relativePath);
  }

  getAllPaths(): string[] {
    throw new Error(
      'getAllPaths() is not supported in MssqlFs - use getAllPathsAsync() instead',
    );
  }

  async getAllPathsAsync(): Promise<string[]> {
    const rows = await this.#query<{ path: string; [key: string]: unknown }>(
      'SELECT path FROM fs_entries ORDER BY path',
    );
    return rows.map((row) => row.path);
  }

  async chmod(filePath: string, mode: number): Promise<void> {
    const normalized = this.#normalizePath(filePath);
    const prefixed = this.#prefixPath(normalized);

    const result = await this.#exec(
      'UPDATE fs_entries SET mode = @p0 WHERE path = @p1',
      [mode, prefixed],
    );

    if (result === 0) {
      throw new Error(`ENOENT: no such file or directory: ${filePath}`);
    }
  }

  async symlink(target: string, linkPath: string): Promise<void> {
    const normalized = this.#normalizePath(linkPath);
    const prefixed = this.#prefixPath(normalized);

    const existingRows = await this.#query<{ exists: number }>(
      'SELECT CASE WHEN EXISTS(SELECT 1 FROM fs_entries WHERE path = @p0) THEN 1 ELSE 0 END as [exists]',
      [prefixed],
    );
    if (existingRows[0].exists === 1) {
      throw new Error(`EEXIST: file already exists: ${linkPath}`);
    }

    await this.#useTransaction(async (transaction) => {
      await this.#ensureParentExists(prefixed, transaction);

      const insertReq = transaction.request();
      insertReq.input('p0', prefixed);
      insertReq.input('p1', Date.now());
      insertReq.input('p2', target);
      await insertReq.query(
        `INSERT INTO fs_entries (path, type, mode, size, mtime, symlinkTarget)
         VALUES (@p0, 'symlink', 511, 0, @p1, @p2)`,
      );
    });
  }

  async link(existingPath: string, newPath: string): Promise<void> {
    const srcNormalized = this.#normalizePath(existingPath);
    const destNormalized = this.#normalizePath(newPath);
    const srcPrefixed = this.#prefixPath(srcNormalized);
    const destPrefixed = this.#prefixPath(destNormalized);

    const srcRows = await this.#query<FsEntryRow>(
      'SELECT * FROM fs_entries WHERE path = @p0',
      [srcPrefixed],
    );
    const srcEntry = srcRows[0];

    if (!srcEntry) {
      throw new Error(`ENOENT: no such file or directory: ${existingPath}`);
    }

    if (srcEntry.type !== 'file') {
      throw new Error(`link: not supported for directories: ${existingPath}`);
    }

    const existingRows = await this.#query<{ exists: number }>(
      'SELECT CASE WHEN EXISTS(SELECT 1 FROM fs_entries WHERE path = @p0) THEN 1 ELSE 0 END as [exists]',
      [destPrefixed],
    );
    if (existingRows[0].exists === 1) {
      throw new Error(`EEXIST: file already exists: ${newPath}`);
    }

    await this.#useTransaction(async (transaction) => {
      await this.#ensureParentExists(destPrefixed, transaction);

      const insertReq = transaction.request();
      insertReq.input('p0', destPrefixed);
      insertReq.input('p1', srcEntry.mode);
      insertReq.input('p2', srcEntry.size);
      insertReq.input('p3', Date.now());
      await insertReq.query(
        `INSERT INTO fs_entries (path, type, mode, size, mtime)
         VALUES (@p0, 'file', @p1, @p2, @p3)`,
      );

      const chunksReq = transaction.request();
      chunksReq.input('p0', srcPrefixed);
      const chunksResult = await chunksReq.query<{
        chunkIndex: number;
        data: Buffer;
      }>('SELECT chunkIndex, data FROM fs_chunks WHERE path = @p0');

      for (const chunk of chunksResult.recordset) {
        const chunkInsertReq = transaction.request();
        chunkInsertReq.input('p0', destPrefixed);
        chunkInsertReq.input('p1', chunk.chunkIndex);
        chunkInsertReq.input('p2', chunk.data);
        await chunkInsertReq.query(
          'INSERT INTO fs_chunks (path, chunkIndex, data) VALUES (@p0, @p1, @p2)',
        );
      }
    });
  }

  async readlink(linkPath: string): Promise<string> {
    const normalized = this.#normalizePath(linkPath);
    const prefixed = this.#prefixPath(normalized);

    const rows = await this.#query<Pick<FsEntryRow, 'type' | 'symlinkTarget'>>(
      'SELECT type, symlinkTarget FROM fs_entries WHERE path = @p0',
      [prefixed],
    );
    const entry = rows[0];

    if (!entry) {
      throw new Error(`ENOENT: no such file or directory: ${linkPath}`);
    }

    if (entry.type !== 'symlink') {
      throw new Error(`readlink: not a symbolic link: ${linkPath}`);
    }

    return entry.symlinkTarget!;
  }
}
