import type {
  BufferEncoding,
  CpOptions,
  FileContent,
  FsStat,
  IFileSystem,
  MkdirOptions,
  RmOptions,
} from 'just-bash';
import type { ConnectionPool, IResult, Transaction, config } from 'mssql';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import z from 'zod';

import { bigintColumn, entryType } from '../columns.ts';
import { mssqlFsDDL } from './ddl.mssql-fs.ts';

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
  /** SQL Server connection pool or configuration. Can be a connection string, config object, or existing ConnectionPool. */
  pool: config | string | ConnectionPool;
  /** Root path prefix for all operations */
  root: string;
  /** Chunk size for large files in bytes (default: 1MB) */
  chunkSize?: number;
  /**
   * SQL Server schema to scope all tables under.
   * Defaults to 'dbo'.
   */
  schema?: string;
}

// Row shapes as mssql returns them for ddl.mssql-fs.ts: INT as a number,
// BIGINT as a string (see bigintColumn), NVARCHAR as a string and VARBINARY as
// a Buffer.

const entryRow = z.object({
  path: z.string(),
  type: entryType,
  mode: z.number(),
  size: bigintColumn,
  mtime: bigintColumn,
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

// SELECT CASE WHEN EXISTS(...) THEN 1 ELSE 0 END
const existsRow = z.object({ exists: z.union([z.literal(0), z.literal(1)]) });

const chunkRow = z.object({
  chunkIndex: z.number(),
  data: z.instanceof(Buffer),
});

const dataRow = chunkRow.pick({ data: true });

function rowsOf<Row extends z.ZodType>(
  row: Row,
  result: IResult<unknown>,
): z.output<Row>[] {
  return z.array(row).parse(result.recordset);
}

export class MssqlFs implements IFileSystem {
  #pool: ConnectionPool;
  #chunkSize: number;
  #root: string;
  #schema: string;
  #ownsPool: boolean;

  private constructor(options: MssqlFsOptions) {
    this.#chunkSize = options.chunkSize ?? 1024 * 1024;
    const schema = options.schema ?? 'dbo';
    if (!/^[a-zA-Z_]\w*$/.test(schema)) {
      throw new Error(`Invalid schema name: "${schema}"`);
    }
    this.#schema = schema;
    const normalizedRoot = this.#normalizeRoot(options.root);
    this.#root = normalizedRoot === '/' ? '' : normalizedRoot;

    const mssql = MssqlFs.#requireMssql();
    if (options.pool instanceof mssql.ConnectionPool) {
      this.#pool = options.pool;
      this.#ownsPool = false;
    } else {
      this.#pool = new mssql.ConnectionPool(options.pool);
      this.#ownsPool = true;
    }
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

  #t(name: string): string {
    return `[${this.#schema}].[${name}]`;
  }

  /** Opens the file system: creates its tables and its root directories. */
  static async create(options: MssqlFsOptions): Promise<MssqlFs> {
    const fs = new MssqlFs(options);
    try {
      await fs.#initialize();
    } catch (error) {
      await fs.close();
      throw error;
    }
    return fs;
  }

  async #initialize(): Promise<void> {
    if (this.#ownsPool) {
      await this.#pool.connect();
    }

    const schemaReq = this.#pool.request();
    schemaReq.input('schema', this.#schema);
    await schemaReq.query(`
      IF NOT EXISTS (SELECT * FROM sys.schemas WHERE name = @schema)
      BEGIN
        DECLARE @sql NVARCHAR(MAX) = N'CREATE SCHEMA ' + QUOTENAME(@schema);
        EXEC sp_executesql @sql;
      END
    `);

    const ddl = mssqlFsDDL(this.#schema);
    const batches = ddl.split(/\bGO\b/i).filter((b) => b.trim());
    for (const batch of batches) {
      if (batch.trim()) {
        await this.#pool.request().batch(batch);
      }
    }

    const rootSlashExists = rowsOf(
      existsRow,
      await this.#query(
        `SELECT CASE WHEN EXISTS(SELECT 1 FROM ${this.#t('fs_entries')} WHERE path = '/') THEN 1 ELSE 0 END as [exists]`,
      ),
    );
    if (rootSlashExists[0].exists === 0) {
      await this.#exec(
        `INSERT INTO ${this.#t('fs_entries')} (path, type, mode, size, mtime) VALUES ('/', 'directory', 493, 0, @p0)`,
        [Date.now()],
      );
    }

    if (this.#root) {
      await this.#createParentDirs(this.#root);

      const rootExists = rowsOf(
        existsRow,
        await this.#query(
          `SELECT CASE WHEN EXISTS(SELECT 1 FROM ${this.#t('fs_entries')} WHERE path = @p0) THEN 1 ELSE 0 END as [exists]`,
          [this.#root],
        ),
      );
      if (rootExists[0].exists === 0) {
        await this.#exec(
          `INSERT INTO ${this.#t('fs_entries')} (path, type, mode, size, mtime) VALUES (@p0, 'directory', 493, 0, @p1)`,
          [this.#root, Date.now()],
        );
      }
    }
  }

  async #createParentDirs(p: string): Promise<void> {
    const segments = p.split('/').filter(Boolean);
    let currentPath = '/';

    for (let i = 0; i < segments.length - 1; i++) {
      currentPath = path.posix.join(currentPath, segments[i]);
      const exists = rowsOf(
        existsRow,
        await this.#query(
          `SELECT CASE WHEN EXISTS(SELECT 1 FROM ${this.#t('fs_entries')} WHERE path = @p0) THEN 1 ELSE 0 END as [exists]`,
          [currentPath],
        ),
      );

      if (exists[0].exists === 0) {
        await this.#exec(
          `INSERT INTO ${this.#t('fs_entries')} (path, type, mode, size, mtime) VALUES (@p0, 'directory', 493, 0, @p1)`,
          [currentPath, Date.now()],
        );
      }
    }
  }

  #query(sql: string, params?: unknown[]): Promise<IResult<unknown>> {
    const request = this.#pool.request();
    params?.forEach((value, index) => {
      request.input(`p${index}`, value);
    });
    return request.query(sql);
  }

  async #exec(sql: string, params?: unknown[]): Promise<number> {
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

  async #ensureParentExists(
    filePath: string,
    transaction: Transaction,
  ): Promise<void> {
    const parent = this.#dirname(filePath);
    const rootPath = this.#root || '/';
    if (parent === rootPath || parent === '/') return;

    const request = transaction.request();
    request.input('p0', parent);
    const [entry] = rowsOf(
      typeRow,
      await request.query(
        `SELECT type FROM ${this.#t('fs_entries')} WHERE path = @p0`,
      ),
    );

    if (!entry) {
      await this.#ensureParentExists(parent, transaction);
      const insertReq = transaction.request();
      insertReq.input('p0', parent);
      insertReq.input('p1', Date.now());
      await insertReq.query(
        `INSERT INTO ${this.#t('fs_entries')} (path, type, mode, size, mtime) VALUES (@p0, 'directory', 493, 0, @p1)`,
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
    await deleteReq.query(
      `DELETE FROM ${this.#t('fs_chunks')} WHERE path = @p0`,
    );

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
        `INSERT INTO ${this.#t('fs_chunks')} (path, chunkIndex, data) VALUES (@p0, @p1, @p2)`,
      );
    }
  }

  async #readChunks(
    filePath: string,
    transaction?: Transaction,
  ): Promise<Uint8Array> {
    const sql = `SELECT data FROM ${this.#t('fs_chunks')} WHERE path = @p0 ORDER BY chunkIndex`;
    const rows = rowsOf(
      dataRow,
      transaction
        ? await transaction.request().input('p0', filePath).query(sql)
        : await this.#query(sql, [filePath]),
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

    const [entry] = rowsOf(
      linkRow,
      await this.#query(
        `SELECT type, symlinkTarget FROM ${this.#t('fs_entries')} WHERE path = @p0`,
        [p],
      ),
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

  async close(): Promise<void> {
    if (this.#ownsPool) {
      await this.#pool.close();
    }
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
    const resolved = await this.#resolveSymlink(prefixed);

    const [entry] = rowsOf(
      typeRow,
      await this.#query(
        `SELECT type FROM ${this.#t('fs_entries')} WHERE path = @p0`,
        [resolved],
      ),
    );

    if (!entry) {
      throw new Error(`ENOENT: no such file or directory: ${filePath}`);
    }
    if (entry.type === 'directory') {
      throw new Error(`EISDIR: illegal operation on a directory: ${filePath}`);
    }

    const content = await this.#readChunks(resolved);
    const encoding =
      typeof options === 'string' ? options : (options?.encoding ?? 'utf8');
    return Buffer.from(content).toString(encoding);
  }

  async readFileBuffer(filePath: string): Promise<Uint8Array> {
    const normalized = this.#normalizePath(filePath);
    const prefixed = this.#prefixPath(normalized);
    const resolved = await this.#resolveSymlink(prefixed);

    const [entry] = rowsOf(
      typeRow,
      await this.#query(
        `SELECT type FROM ${this.#t('fs_entries')} WHERE path = @p0`,
        [resolved],
      ),
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

    await this.#useTransaction(async (transaction) => {
      await this.#ensureParentExists(prefixed, transaction);

      const request = transaction.request();
      request.input('p0', prefixed);
      request.input('p1', data.length);
      request.input('p2', Date.now());

      await request.query(`
        MERGE ${this.#t('fs_entries')} AS target
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
    options?: WriteFileOptions | BufferEncoding,
  ): Promise<void> {
    const normalized = this.#normalizePath(filePath);
    const prefixed = this.#prefixPath(normalized);
    const encoding = typeof options === 'string' ? options : options?.encoding;
    const newData = this.#toUint8Array(content, encoding);

    await this.#useTransaction(async (transaction) => {
      await this.#ensureParentExists(prefixed, transaction);

      const checkReq = transaction.request();
      checkReq.input('p0', prefixed);
      const [entry] = rowsOf(
        typeRow,
        await checkReq.query(
          `SELECT type FROM ${this.#t('fs_entries')} WHERE path = @p0`,
        ),
      );

      if (entry && entry.type !== 'file') {
        throw new Error(`appendFile: not a file: ${filePath}`);
      }

      const existing = entry
        ? await this.#readChunks(prefixed, transaction)
        : new Uint8Array(0);
      const combined = new Uint8Array(existing.length + newData.length);
      combined.set(existing, 0);
      combined.set(newData, existing.length);

      const upsertReq = transaction.request();
      upsertReq.input('p0', prefixed);
      upsertReq.input('p1', combined.length);
      upsertReq.input('p2', Date.now());

      await upsertReq.query(`
        MERGE ${this.#t('fs_entries')} AS target
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
    const rows = rowsOf(
      existsRow,
      await this.#query(
        `SELECT CASE WHEN EXISTS(SELECT 1 FROM ${this.#t('fs_entries')} WHERE path = @p0) THEN 1 ELSE 0 END as [exists]`,
        [prefixed],
      ),
    );
    return rows[0].exists === 1;
  }

  async stat(filePath: string): Promise<FsStat> {
    const normalized = this.#normalizePath(filePath);
    const prefixed = this.#prefixPath(normalized);
    const resolved = await this.#resolveSymlink(prefixed);

    const [entry] = rowsOf(
      entryRow,
      await this.#query(
        `SELECT * FROM ${this.#t('fs_entries')} WHERE path = @p0`,
        [resolved],
      ),
    );

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

    const [entry] = rowsOf(
      entryRow,
      await this.#query(
        `SELECT * FROM ${this.#t('fs_entries')} WHERE path = @p0`,
        [prefixed],
      ),
    );

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

    const [existing] = rowsOf(
      typeRow,
      await this.#query(
        `SELECT type FROM ${this.#t('fs_entries')} WHERE path = @p0`,
        [prefixed],
      ),
    );

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
          const [exists] = rowsOf(
            typeRow,
            await checkReq.query(
              `SELECT type FROM ${this.#t('fs_entries')} WHERE path = @p0`,
            ),
          );

          if (!exists) {
            const insertReq = transaction.request();
            insertReq.input('p0', currentPath);
            insertReq.input('p1', Date.now());
            await insertReq.query(
              `INSERT INTO ${this.#t('fs_entries')} (path, type, mode, size, mtime) VALUES (@p0, 'directory', 493, 0, @p1)`,
            );
          } else if (exists.type !== 'directory') {
            throw new Error(`mkdir: not a directory: ${currentPath}`);
          }
        }
      } else {
        const parent = this.#dirname(prefixed);
        const parentReq = transaction.request();
        parentReq.input('p0', parent);
        const [parentEntry] = rowsOf(
          typeRow,
          await parentReq.query(
            `SELECT type FROM ${this.#t('fs_entries')} WHERE path = @p0`,
          ),
        );

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
          `INSERT INTO ${this.#t('fs_entries')} (path, type, mode, size, mtime) VALUES (@p0, 'directory', 493, 0, @p1)`,
        );
      }
    });
  }

  async readdir(dirPath: string): Promise<string[]> {
    const normalized = this.#normalizePath(dirPath);
    const prefixed = this.#prefixPath(normalized);
    const resolved = await this.#resolveSymlink(prefixed);

    const [entry] = rowsOf(
      typeRow,
      await this.#query(
        `SELECT type FROM ${this.#t('fs_entries')} WHERE path = @p0`,
        [resolved],
      ),
    );

    if (!entry) {
      throw new Error(`ENOENT: no such file or directory: ${dirPath}`);
    }
    if (entry.type !== 'directory') {
      throw new Error(`ENOTDIR: not a directory: ${dirPath}`);
    }

    const prefix = resolved === '/' ? '/' : resolved + '/';
    const rows = rowsOf(
      pathRow,
      await this.#query(
        `SELECT path FROM ${this.#t('fs_entries')}
       WHERE path LIKE @p0 + '%'
         AND path != @p1
         AND path NOT LIKE @p0 + '%/%'`,
        [prefix, resolved],
      ),
    );

    return rows.map((row) => path.posix.basename(row.path));
  }

  async readdirWithFileTypes(dirPath: string): Promise<DirentEntry[]> {
    const normalized = this.#normalizePath(dirPath);
    const prefixed = this.#prefixPath(normalized);
    const resolved = await this.#resolveSymlink(prefixed);

    const [entry] = rowsOf(
      typeRow,
      await this.#query(
        `SELECT type FROM ${this.#t('fs_entries')} WHERE path = @p0`,
        [resolved],
      ),
    );

    if (!entry) {
      throw new Error(`ENOENT: no such file or directory: ${dirPath}`);
    }
    if (entry.type !== 'directory') {
      throw new Error(`ENOTDIR: not a directory: ${dirPath}`);
    }

    const prefix = resolved === '/' ? '/' : resolved + '/';
    const rows = rowsOf(
      pathTypeRow,
      await this.#query(
        `SELECT path, type FROM ${this.#t('fs_entries')}
       WHERE path LIKE @p0 + '%'
         AND path != @p1
         AND path NOT LIKE @p0 + '%/%'`,
        [prefix, resolved],
      ),
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

    const [entry] = rowsOf(
      typeRow,
      await this.#query(
        `SELECT type FROM ${this.#t('fs_entries')} WHERE path = @p0`,
        [prefixed],
      ),
    );

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
        const children = rowsOf(
          existsRow,
          await childrenReq.query(
            `SELECT CASE WHEN EXISTS(SELECT 1 FROM ${this.#t('fs_entries')} WHERE path LIKE @p0 + '/%') THEN 1 ELSE 0 END as [exists]`,
          ),
        );

        if (children[0].exists === 1 && !options?.recursive) {
          throw new Error(`ENOTEMPTY: directory not empty: ${filePath}`);
        }

        const deleteReq = transaction.request();
        deleteReq.input('p0', prefixed);
        await deleteReq.query(
          `DELETE FROM ${this.#t('fs_entries')} WHERE path = @p0 OR path LIKE @p0 + '/%'`,
        );
      } else {
        const deleteReq = transaction.request();
        deleteReq.input('p0', prefixed);
        await deleteReq.query(
          `DELETE FROM ${this.#t('fs_entries')} WHERE path = @p0`,
        );
      }
    });
  }

  async cp(src: string, dest: string, options?: CpOptions): Promise<void> {
    const srcNormalized = this.#normalizePath(src);
    const destNormalized = this.#normalizePath(dest);
    const srcPrefixed = this.#prefixPath(srcNormalized);
    const destPrefixed = this.#prefixPath(destNormalized);

    const [srcEntry] = rowsOf(
      entryRow,
      await this.#query(
        `SELECT * FROM ${this.#t('fs_entries')} WHERE path = @p0`,
        [srcPrefixed],
      ),
    );

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
        const allEntries = rowsOf(
          entryRow,
          await allEntriesReq.query(
            `SELECT * FROM ${this.#t('fs_entries')} WHERE path = @p0 OR path LIKE @p0 + '/%'`,
          ),
        );

        for (const entry of allEntries) {
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
            MERGE ${this.#t('fs_entries')} AS target
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
              `DELETE FROM ${this.#t('fs_chunks')} WHERE path = @p0`,
            );

            const chunksReq = transaction.request();
            chunksReq.input('p0', entry.path);
            const chunks = rowsOf(
              chunkRow,
              await chunksReq.query(
                `SELECT chunkIndex, data FROM ${this.#t('fs_chunks')} WHERE path = @p0`,
              ),
            );

            for (const chunk of chunks) {
              const chunkInsertReq = transaction.request();
              chunkInsertReq.input('p0', newPath);
              chunkInsertReq.input('p1', chunk.chunkIndex);
              chunkInsertReq.input('p2', chunk.data);
              await chunkInsertReq.query(
                `INSERT INTO ${this.#t('fs_chunks')} (path, chunkIndex, data) VALUES (@p0, @p1, @p2)`,
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
          MERGE ${this.#t('fs_entries')} AS target
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
          const chunks = rowsOf(
            chunkRow,
            await chunksReq.query(
              `SELECT chunkIndex, data FROM ${this.#t('fs_chunks')} WHERE path = @p0`,
            ),
          );

          const deleteChunksReq = transaction.request();
          deleteChunksReq.input('p0', destPrefixed);
          await deleteChunksReq.query(
            `DELETE FROM ${this.#t('fs_chunks')} WHERE path = @p0`,
          );

          for (const chunk of chunks) {
            const chunkInsertReq = transaction.request();
            chunkInsertReq.input('p0', destPrefixed);
            chunkInsertReq.input('p1', chunk.chunkIndex);
            chunkInsertReq.input('p2', chunk.data);
            await chunkInsertReq.query(
              `INSERT INTO ${this.#t('fs_chunks')} (path, chunkIndex, data) VALUES (@p0, @p1, @p2)`,
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

    const [srcEntry] = rowsOf(
      entryRow,
      await this.#query(
        `SELECT * FROM ${this.#t('fs_entries')} WHERE path = @p0`,
        [srcPrefixed],
      ),
    );

    if (!srcEntry) {
      throw new Error(`ENOENT: no such file or directory: ${src}`);
    }

    await this.#useTransaction(async (transaction) => {
      await this.#ensureParentExists(destPrefixed, transaction);

      if (srcEntry.type === 'directory') {
        const allEntriesReq = transaction.request();
        allEntriesReq.input('p0', srcPrefixed);
        const allEntries = rowsOf(
          entryRow,
          await allEntriesReq.query(
            `SELECT * FROM ${this.#t('fs_entries')} WHERE path = @p0 OR path LIKE @p0 + '/%' ORDER BY path DESC`,
          ),
        );

        const destDeleteReq = transaction.request();
        destDeleteReq.input('dp0', destPrefixed);
        await destDeleteReq.query(
          `DELETE FROM ${this.#t('fs_entries')} WHERE path = @dp0 OR path LIKE @dp0 + '/%'`,
        );

        for (const entry of [...allEntries].reverse()) {
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
            MERGE ${this.#t('fs_entries')} AS target
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
              `DELETE FROM ${this.#t('fs_chunks')} WHERE path = @p0`,
            );

            const chunksReq = transaction.request();
            chunksReq.input('p0', entry.path);
            const chunks = rowsOf(
              chunkRow,
              await chunksReq.query(
                `SELECT chunkIndex, data FROM ${this.#t('fs_chunks')} WHERE path = @p0`,
              ),
            );

            for (const chunk of chunks) {
              const chunkInsertReq = transaction.request();
              chunkInsertReq.input('p0', newPath);
              chunkInsertReq.input('p1', chunk.chunkIndex);
              chunkInsertReq.input('p2', chunk.data);
              await chunkInsertReq.query(
                `INSERT INTO ${this.#t('fs_chunks')} (path, chunkIndex, data) VALUES (@p0, @p1, @p2)`,
              );
            }
          }
        }

        const deleteReq = transaction.request();
        deleteReq.input('p0', srcPrefixed);
        await deleteReq.query(
          `DELETE FROM ${this.#t('fs_entries')} WHERE path = @p0 OR path LIKE @p0 + '/%'`,
        );
      } else {
        const insertReq = transaction.request();
        insertReq.input('p0', destPrefixed);
        insertReq.input('p1', srcEntry.type);
        insertReq.input('p2', srcEntry.mode);
        insertReq.input('p3', srcEntry.size);
        insertReq.input('p4', Date.now());
        insertReq.input('p5', srcEntry.symlinkTarget);

        await insertReq.query(`
          MERGE ${this.#t('fs_entries')} AS target
          USING (SELECT @p0 AS path) AS source
          ON target.path = source.path
          WHEN MATCHED THEN
            UPDATE SET type = @p1, mode = @p2, size = @p3, mtime = @p4, symlinkTarget = @p5
          WHEN NOT MATCHED THEN
            INSERT (path, type, mode, size, mtime, symlinkTarget)
            VALUES (@p0, @p1, @p2, @p3, @p4, @p5);
        `);

        if (srcEntry.type === 'file') {
          const deleteChunksReq = transaction.request();
          deleteChunksReq.input('p0', destPrefixed);
          await deleteChunksReq.query(
            `DELETE FROM ${this.#t('fs_chunks')} WHERE path = @p0`,
          );

          const chunksReq = transaction.request();
          chunksReq.input('p0', srcPrefixed);
          const chunks = rowsOf(
            chunkRow,
            await chunksReq.query(
              `SELECT chunkIndex, data FROM ${this.#t('fs_chunks')} WHERE path = @p0`,
            ),
          );

          for (const chunk of chunks) {
            const chunkInsertReq = transaction.request();
            chunkInsertReq.input('p0', destPrefixed);
            chunkInsertReq.input('p1', chunk.chunkIndex);
            chunkInsertReq.input('p2', chunk.data);
            await chunkInsertReq.query(
              `INSERT INTO ${this.#t('fs_chunks')} (path, chunkIndex, data) VALUES (@p0, @p1, @p2)`,
            );
          }
        }

        const deleteReq = transaction.request();
        deleteReq.input('p0', srcPrefixed);
        await deleteReq.query(
          `DELETE FROM ${this.#t('fs_entries')} WHERE path = @p0`,
        );
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
    const rows = rowsOf(
      pathRow,
      await this.#query(
        `SELECT path FROM ${this.#t('fs_entries')} ORDER BY path`,
      ),
    );
    return rows.map((row) => row.path);
  }

  async realpath(filePath: string): Promise<string> {
    const normalized = this.#normalizePath(filePath);
    const prefixed = this.#prefixPath(normalized);
    const resolved = await this.#resolveSymlink(prefixed);

    const rows = rowsOf(
      existsRow,
      await this.#query(
        `SELECT CASE WHEN EXISTS(SELECT 1 FROM ${this.#t('fs_entries')} WHERE path = @p0) THEN 1 ELSE 0 END as [exists]`,
        [resolved],
      ),
    );
    if (rows[0].exists !== 1) {
      throw new Error(`ENOENT: no such file or directory: ${filePath}`);
    }

    return this.#unprefixPath(resolved);
  }

  async utimes(filePath: string, _atime: Date, mtime: Date): Promise<void> {
    const normalized = this.#normalizePath(filePath);
    const prefixed = this.#prefixPath(normalized);
    const resolved = await this.#resolveSymlink(prefixed);

    const result = await this.#exec(
      `UPDATE ${this.#t('fs_entries')} SET mtime = @p0 WHERE path = @p1`,
      [mtime.getTime(), resolved],
    );

    if (result === 0) {
      throw new Error(`ENOENT: no such file or directory: ${filePath}`);
    }
  }

  async chmod(filePath: string, mode: number): Promise<void> {
    const normalized = this.#normalizePath(filePath);
    const prefixed = this.#prefixPath(normalized);

    const result = await this.#exec(
      `UPDATE ${this.#t('fs_entries')} SET mode = @p0 WHERE path = @p1`,
      [mode, prefixed],
    );

    if (result === 0) {
      throw new Error(`ENOENT: no such file or directory: ${filePath}`);
    }
  }

  async symlink(target: string, linkPath: string): Promise<void> {
    const normalized = this.#normalizePath(linkPath);
    const prefixed = this.#prefixPath(normalized);

    const existingRows = rowsOf(
      existsRow,
      await this.#query(
        `SELECT CASE WHEN EXISTS(SELECT 1 FROM ${this.#t('fs_entries')} WHERE path = @p0) THEN 1 ELSE 0 END as [exists]`,
        [prefixed],
      ),
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
        `INSERT INTO ${this.#t('fs_entries')} (path, type, mode, size, mtime, symlinkTarget)
         VALUES (@p0, 'symlink', 511, 0, @p1, @p2)`,
      );
    });
  }

  async link(existingPath: string, newPath: string): Promise<void> {
    const srcNormalized = this.#normalizePath(existingPath);
    const destNormalized = this.#normalizePath(newPath);
    const srcPrefixed = this.#prefixPath(srcNormalized);
    const destPrefixed = this.#prefixPath(destNormalized);

    const [srcEntry] = rowsOf(
      entryRow,
      await this.#query(
        `SELECT * FROM ${this.#t('fs_entries')} WHERE path = @p0`,
        [srcPrefixed],
      ),
    );

    if (!srcEntry) {
      throw new Error(`ENOENT: no such file or directory: ${existingPath}`);
    }

    if (srcEntry.type !== 'file') {
      throw new Error(`link: not supported for directories: ${existingPath}`);
    }

    const existingRows = rowsOf(
      existsRow,
      await this.#query(
        `SELECT CASE WHEN EXISTS(SELECT 1 FROM ${this.#t('fs_entries')} WHERE path = @p0) THEN 1 ELSE 0 END as [exists]`,
        [destPrefixed],
      ),
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
        `INSERT INTO ${this.#t('fs_entries')} (path, type, mode, size, mtime)
         VALUES (@p0, 'file', @p1, @p2, @p3)`,
      );

      const chunksReq = transaction.request();
      chunksReq.input('p0', srcPrefixed);
      const chunks = rowsOf(
        chunkRow,
        await chunksReq.query(
          `SELECT chunkIndex, data FROM ${this.#t('fs_chunks')} WHERE path = @p0`,
        ),
      );

      for (const chunk of chunks) {
        const chunkInsertReq = transaction.request();
        chunkInsertReq.input('p0', destPrefixed);
        chunkInsertReq.input('p1', chunk.chunkIndex);
        chunkInsertReq.input('p2', chunk.data);
        await chunkInsertReq.query(
          `INSERT INTO ${this.#t('fs_chunks')} (path, chunkIndex, data) VALUES (@p0, @p1, @p2)`,
        );
      }
    });
  }

  async readlink(linkPath: string): Promise<string> {
    const normalized = this.#normalizePath(linkPath);
    const prefixed = this.#prefixPath(normalized);

    const [entry] = rowsOf(
      linkRow,
      await this.#query(
        `SELECT type, symlinkTarget FROM ${this.#t('fs_entries')} WHERE path = @p0`,
        [prefixed],
      ),
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
