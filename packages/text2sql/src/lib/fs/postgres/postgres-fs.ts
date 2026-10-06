import type {
  BufferEncoding,
  CpOptions,
  FileContent,
  FsStat,
  IFileSystem,
  MkdirOptions,
  RmOptions,
} from 'just-bash';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import type { Pool, PoolClient, PoolConfig, QueryResult } from 'pg';
import z from 'zod';

import { bigintColumn, entryType } from '../columns.ts';
import { postgresFsDDL } from './ddl.postgres-fs.ts';

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

export interface PostgresFsOptions {
  pool: Pool | PoolConfig | string;
  root: string;
  chunkSize?: number;
  schema?: string;
}

// Row shapes as pg returns them for ddl.postgres-fs.ts: INTEGER as a number,
// BIGINT as a string (see bigintColumn), BYTEA as a Buffer and EXISTS() as a
// boolean.

const entryRow = z.object({
  path: z.string(),
  type: entryType,
  mode: z.number(),
  size: bigintColumn,
  mtime: bigintColumn,
  symlink_target: z.string().nullable(),
});

const typeRow = entryRow.pick({ type: true });

const pathRow = entryRow.pick({ path: true });

const pathTypeRow = entryRow.pick({ path: true, type: true });

// symlink() always stores a target. A file or directory keeps NULL, or the
// target of the symlink it replaced: writeFile and appendFile change the type
// of an existing path without clearing it.
const linkRow = z.discriminatedUnion('type', [
  z.object({ type: z.literal('symlink'), symlink_target: z.string() }),
  z.object({
    type: z.enum(['file', 'directory']),
    symlink_target: z.string().nullable(),
  }),
]);

const existsRow = z.object({ exists: z.boolean() });

const chunkRow = z.object({
  chunk_index: z.number(),
  data: z.instanceof(Buffer),
});

const dataRow = chunkRow.pick({ data: true });

function rowsOf<Row extends z.ZodType>(
  row: Row,
  result: QueryResult,
): z.output<Row>[] {
  return z.array(row).parse(result.rows);
}

export class PostgresFs implements IFileSystem {
  #pool: Pool;
  #chunkSize: number;
  #root: string;
  #schema: string;
  #ownsPool: boolean;
  #isInitialized = false;

  constructor(options: PostgresFsOptions) {
    this.#chunkSize = options.chunkSize ?? 1024 * 1024;
    const schema = options.schema ?? 'public';
    if (!/^[a-zA-Z_]\w*$/.test(schema)) {
      throw new Error(`Invalid schema name: "${schema}"`);
    }
    this.#schema = schema;
    const normalizedRoot = this.#normalizeRoot(options.root);
    this.#root = normalizedRoot === '/' ? '' : normalizedRoot;

    const pg = PostgresFs.#requirePg();
    if (options.pool instanceof pg.Pool) {
      this.#pool = options.pool;
      this.#ownsPool = false;
    } else {
      this.#pool =
        typeof options.pool === 'string'
          ? new pg.Pool({ connectionString: options.pool })
          : new pg.Pool(options.pool);
      this.#ownsPool = true;
    }
  }

  static #requirePg(): typeof import('pg') {
    try {
      const require = createRequire(import.meta.url);
      return require('pg');
    } catch {
      throw new Error(
        'PostgresFs requires the "pg" package. Install it with: npm install pg',
      );
    }
  }

  #t(name: string): string {
    return `"${this.#schema}"."${name}"`;
  }

  async initialize(): Promise<void> {
    const ddl = postgresFsDDL(this.#schema);
    await this.#pool.query(ddl);

    const rootSlashExists = rowsOf(
      existsRow,
      await this.#rawQuery(
        `SELECT EXISTS(SELECT 1 FROM ${this.#t('fs_entries')} WHERE path = '/') AS exists`,
      ),
    );
    if (!rootSlashExists[0].exists) {
      await this.#rawExec(
        `INSERT INTO ${this.#t('fs_entries')} (path, type, mode, size, mtime) VALUES ('/', 'directory', 493, 0, $1)`,
        [Date.now()],
      );
    }

    if (this.#root) {
      await this.#createParentDirs(this.#root);

      const rootExists = rowsOf(
        existsRow,
        await this.#rawQuery(
          `SELECT EXISTS(SELECT 1 FROM ${this.#t('fs_entries')} WHERE path = $1) AS exists`,
          [this.#root],
        ),
      );
      if (!rootExists[0].exists) {
        await this.#rawExec(
          `INSERT INTO ${this.#t('fs_entries')} (path, type, mode, size, mtime) VALUES ($1, 'directory', 493, 0, $2)`,
          [this.#root, Date.now()],
        );
      }
    }

    this.#isInitialized = true;
  }

  #ensureInitialized(): void {
    if (!this.#isInitialized) {
      throw new Error(
        'PostgresFs not initialized. Call await fs.initialize() after construction.',
      );
    }
  }

  async #createParentDirs(p: string): Promise<void> {
    const segments = p.split('/').filter(Boolean);
    let currentPath = '/';

    for (let i = 0; i < segments.length - 1; i++) {
      currentPath = path.posix.join(currentPath, segments[i]);
      const exists = rowsOf(
        existsRow,
        await this.#rawQuery(
          `SELECT EXISTS(SELECT 1 FROM ${this.#t('fs_entries')} WHERE path = $1) AS exists`,
          [currentPath],
        ),
      );

      if (!exists[0].exists) {
        await this.#rawExec(
          `INSERT INTO ${this.#t('fs_entries')} (path, type, mode, size, mtime) VALUES ($1, 'directory', 493, 0, $2)`,
          [currentPath, Date.now()],
        );
      }
    }
  }

  #rawQuery(sql: string, params?: unknown[]): Promise<QueryResult> {
    return this.#pool.query(sql, params);
  }

  async #rawExec(sql: string, params?: unknown[]): Promise<number> {
    const result = await this.#pool.query(sql, params);
    return result.rowCount ?? 0;
  }

  async #query(sql: string, params?: unknown[]): Promise<QueryResult> {
    this.#ensureInitialized();
    return this.#rawQuery(sql, params);
  }

  async #exec(sql: string, params?: unknown[]): Promise<number> {
    this.#ensureInitialized();
    return this.#rawExec(sql, params);
  }

  async #useTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    this.#ensureInitialized();
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
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
    client: PoolClient,
  ): Promise<void> {
    const parent = this.#dirname(filePath);
    const rootPath = this.#root || '/';
    if (parent === rootPath || parent === '/') return;

    const [entry] = rowsOf(
      typeRow,
      await client.query(
        `SELECT type FROM ${this.#t('fs_entries')} WHERE path = $1`,
        [parent],
      ),
    );

    if (!entry) {
      await this.#ensureParentExists(parent, client);
      await client.query(
        `INSERT INTO ${this.#t('fs_entries')} (path, type, mode, size, mtime) VALUES ($1, 'directory', 493, 0, $2)`,
        [parent, Date.now()],
      );
    } else if (entry.type !== 'directory') {
      throw new Error(`mkdir: parent is not a directory: ${parent}`);
    }
  }

  async #writeChunks(
    filePath: string,
    content: Uint8Array,
    client: PoolClient,
  ): Promise<void> {
    await client.query(`DELETE FROM ${this.#t('fs_chunks')} WHERE path = $1`, [
      filePath,
    ]);

    for (let i = 0; i < content.length; i += this.#chunkSize) {
      const chunk = content.slice(
        i,
        Math.min(i + this.#chunkSize, content.length),
      );
      await client.query(
        `INSERT INTO ${this.#t('fs_chunks')} (path, chunk_index, data) VALUES ($1, $2, $3)`,
        [filePath, Math.floor(i / this.#chunkSize), Buffer.from(chunk)],
      );
    }
  }

  async #readChunks(
    filePath: string,
    client?: PoolClient,
  ): Promise<Uint8Array> {
    const sql = `SELECT data FROM ${this.#t('fs_chunks')} WHERE path = $1 ORDER BY chunk_index`;
    const rows = rowsOf(
      dataRow,
      client
        ? await client.query(sql, [filePath])
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
        `SELECT type, symlink_target FROM ${this.#t('fs_entries')} WHERE path = $1`,
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
      path.posix.resolve(this.#dirname(p), entry.symlink_target),
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
      await this.#pool.end();
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
        `SELECT type FROM ${this.#t('fs_entries')} WHERE path = $1`,
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
        `SELECT type FROM ${this.#t('fs_entries')} WHERE path = $1`,
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

    await this.#useTransaction(async (client) => {
      await this.#ensureParentExists(prefixed, client);

      await client.query(
        `INSERT INTO ${this.#t('fs_entries')} (path, type, mode, size, mtime)
         VALUES ($1, 'file', 420, $2, $3)
         ON CONFLICT (path) DO UPDATE SET type = 'file', size = EXCLUDED.size, mtime = EXCLUDED.mtime`,
        [prefixed, data.length, Date.now()],
      );

      await this.#writeChunks(prefixed, data, client);
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

    await this.#useTransaction(async (client) => {
      await this.#ensureParentExists(prefixed, client);

      const [entry] = rowsOf(
        typeRow,
        await client.query(
          `SELECT type FROM ${this.#t('fs_entries')} WHERE path = $1`,
          [prefixed],
        ),
      );

      if (entry && entry.type !== 'file') {
        throw new Error(`appendFile: not a file: ${filePath}`);
      }

      const existing = entry
        ? await this.#readChunks(prefixed, client)
        : new Uint8Array(0);
      const combined = new Uint8Array(existing.length + newData.length);
      combined.set(existing, 0);
      combined.set(newData, existing.length);

      await client.query(
        `INSERT INTO ${this.#t('fs_entries')} (path, type, mode, size, mtime)
         VALUES ($1, 'file', 420, $2, $3)
         ON CONFLICT (path) DO UPDATE SET size = EXCLUDED.size, mtime = EXCLUDED.mtime`,
        [prefixed, combined.length, Date.now()],
      );

      await this.#writeChunks(prefixed, combined, client);
    });
  }

  async exists(filePath: string): Promise<boolean> {
    const normalized = this.#normalizePath(filePath);
    const prefixed = this.#prefixPath(normalized);
    const rows = rowsOf(
      existsRow,
      await this.#query(
        `SELECT EXISTS(SELECT 1 FROM ${this.#t('fs_entries')} WHERE path = $1) AS exists`,
        [prefixed],
      ),
    );
    return rows[0].exists;
  }

  async stat(filePath: string): Promise<FsStat> {
    const normalized = this.#normalizePath(filePath);
    const prefixed = this.#prefixPath(normalized);
    const resolved = await this.#resolveSymlink(prefixed);

    const [entry] = rowsOf(
      entryRow,
      await this.#query(
        `SELECT * FROM ${this.#t('fs_entries')} WHERE path = $1`,
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
        `SELECT * FROM ${this.#t('fs_entries')} WHERE path = $1`,
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
        `SELECT type FROM ${this.#t('fs_entries')} WHERE path = $1`,
        [prefixed],
      ),
    );

    if (existing) {
      if (options?.recursive) {
        return;
      }
      throw new Error(`EEXIST: file already exists: ${dirPath}`);
    }

    await this.#useTransaction(async (client) => {
      if (options?.recursive) {
        const rootPath = this.#root || '/';
        const relativePath = path.posix.relative(rootPath, prefixed);
        const segments = relativePath.split('/').filter(Boolean);
        let currentPath = rootPath;

        for (const segment of segments) {
          currentPath = path.posix.join(currentPath, segment);
          const [exists] = rowsOf(
            typeRow,
            await client.query(
              `SELECT type FROM ${this.#t('fs_entries')} WHERE path = $1`,
              [currentPath],
            ),
          );

          if (!exists) {
            await client.query(
              `INSERT INTO ${this.#t('fs_entries')} (path, type, mode, size, mtime) VALUES ($1, 'directory', 493, 0, $2)`,
              [currentPath, Date.now()],
            );
          } else if (exists.type !== 'directory') {
            throw new Error(`mkdir: not a directory: ${currentPath}`);
          }
        }
      } else {
        const parent = this.#dirname(prefixed);
        const [parentEntry] = rowsOf(
          typeRow,
          await client.query(
            `SELECT type FROM ${this.#t('fs_entries')} WHERE path = $1`,
            [parent],
          ),
        );

        if (!parentEntry) {
          throw new Error(`mkdir: parent does not exist: ${parent}`);
        }
        if (parentEntry.type !== 'directory') {
          throw new Error(`mkdir: parent is not a directory: ${parent}`);
        }

        await client.query(
          `INSERT INTO ${this.#t('fs_entries')} (path, type, mode, size, mtime) VALUES ($1, 'directory', 493, 0, $2)`,
          [prefixed, Date.now()],
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
        `SELECT type FROM ${this.#t('fs_entries')} WHERE path = $1`,
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
       WHERE path LIKE $1 || '%'
         AND path != $2
         AND path NOT LIKE $1 || '%/%'`,
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
        `SELECT type FROM ${this.#t('fs_entries')} WHERE path = $1`,
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
       WHERE path LIKE $1 || '%'
         AND path != $2
         AND path NOT LIKE $1 || '%/%'`,
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
        `SELECT type FROM ${this.#t('fs_entries')} WHERE path = $1`,
        [prefixed],
      ),
    );

    if (!entry) {
      if (options?.force) {
        return;
      }
      throw new Error(`ENOENT: no such file or directory: ${filePath}`);
    }

    await this.#useTransaction(async (client) => {
      if (entry.type === 'directory') {
        const children = rowsOf(
          existsRow,
          await client.query(
            `SELECT EXISTS(SELECT 1 FROM ${this.#t('fs_entries')} WHERE path LIKE $1 || '/%') AS exists`,
            [prefixed],
          ),
        );

        if (children[0].exists && !options?.recursive) {
          throw new Error(`ENOTEMPTY: directory not empty: ${filePath}`);
        }

        await client.query(
          `DELETE FROM ${this.#t('fs_entries')} WHERE path = $1 OR path LIKE $1 || '/%'`,
          [prefixed],
        );
      } else {
        await client.query(
          `DELETE FROM ${this.#t('fs_entries')} WHERE path = $1`,
          [prefixed],
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
        `SELECT * FROM ${this.#t('fs_entries')} WHERE path = $1`,
        [srcPrefixed],
      ),
    );

    if (!srcEntry) {
      throw new Error(`ENOENT: no such file or directory: ${src}`);
    }

    if (srcEntry.type === 'directory' && !options?.recursive) {
      throw new Error(`cp: -r not specified; omitting directory: ${src}`);
    }

    await this.#useTransaction(async (client) => {
      await this.#ensureParentExists(destPrefixed, client);

      if (srcEntry.type === 'directory') {
        const allEntries = rowsOf(
          entryRow,
          await client.query(
            `SELECT * FROM ${this.#t('fs_entries')} WHERE path = $1 OR path LIKE $1 || '/%'`,
            [srcPrefixed],
          ),
        );

        for (const entry of allEntries) {
          const relativePath = path.posix.relative(srcPrefixed, entry.path);
          const newPath = path.posix.join(destPrefixed, relativePath);

          await client.query(
            `INSERT INTO ${this.#t('fs_entries')} (path, type, mode, size, mtime, symlink_target)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (path) DO UPDATE SET type = EXCLUDED.type, mode = EXCLUDED.mode, size = EXCLUDED.size, mtime = EXCLUDED.mtime, symlink_target = EXCLUDED.symlink_target`,
            [
              newPath,
              entry.type,
              entry.mode,
              entry.size,
              Date.now(),
              entry.symlink_target,
            ],
          );

          if (entry.type === 'file') {
            await client.query(
              `DELETE FROM ${this.#t('fs_chunks')} WHERE path = $1`,
              [newPath],
            );

            const chunks = rowsOf(
              chunkRow,
              await client.query(
                `SELECT chunk_index, data FROM ${this.#t('fs_chunks')} WHERE path = $1`,
                [entry.path],
              ),
            );

            for (const chunk of chunks) {
              await client.query(
                `INSERT INTO ${this.#t('fs_chunks')} (path, chunk_index, data) VALUES ($1, $2, $3)`,
                [newPath, chunk.chunk_index, chunk.data],
              );
            }
          }
        }
      } else {
        await client.query(
          `INSERT INTO ${this.#t('fs_entries')} (path, type, mode, size, mtime, symlink_target)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (path) DO UPDATE SET type = EXCLUDED.type, mode = EXCLUDED.mode, size = EXCLUDED.size, mtime = EXCLUDED.mtime, symlink_target = EXCLUDED.symlink_target`,
          [
            destPrefixed,
            srcEntry.type,
            srcEntry.mode,
            srcEntry.size,
            Date.now(),
            srcEntry.symlink_target,
          ],
        );

        if (srcEntry.type === 'file') {
          const chunks = rowsOf(
            chunkRow,
            await client.query(
              `SELECT chunk_index, data FROM ${this.#t('fs_chunks')} WHERE path = $1`,
              [srcPrefixed],
            ),
          );

          await client.query(
            `DELETE FROM ${this.#t('fs_chunks')} WHERE path = $1`,
            [destPrefixed],
          );

          for (const chunk of chunks) {
            await client.query(
              `INSERT INTO ${this.#t('fs_chunks')} (path, chunk_index, data) VALUES ($1, $2, $3)`,
              [destPrefixed, chunk.chunk_index, chunk.data],
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
        `SELECT * FROM ${this.#t('fs_entries')} WHERE path = $1`,
        [srcPrefixed],
      ),
    );

    if (!srcEntry) {
      throw new Error(`ENOENT: no such file or directory: ${src}`);
    }

    await this.#useTransaction(async (client) => {
      await this.#ensureParentExists(destPrefixed, client);

      if (srcEntry.type === 'directory') {
        const allEntries = rowsOf(
          entryRow,
          await client.query(
            `SELECT * FROM ${this.#t('fs_entries')} WHERE path = $1 OR path LIKE $1 || '/%' ORDER BY path DESC`,
            [srcPrefixed],
          ),
        );

        await client.query(
          `DELETE FROM ${this.#t('fs_entries')} WHERE path = $1 OR path LIKE $1 || '/%'`,
          [destPrefixed],
        );

        for (const entry of [...allEntries].reverse()) {
          const relativePath = path.posix.relative(srcPrefixed, entry.path);
          const newPath = path.posix.join(destPrefixed, relativePath);

          await client.query(
            `INSERT INTO ${this.#t('fs_entries')} (path, type, mode, size, mtime, symlink_target)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (path) DO UPDATE SET type = EXCLUDED.type, mode = EXCLUDED.mode, size = EXCLUDED.size, mtime = EXCLUDED.mtime, symlink_target = EXCLUDED.symlink_target`,
            [
              newPath,
              entry.type,
              entry.mode,
              entry.size,
              Date.now(),
              entry.symlink_target,
            ],
          );

          if (entry.type === 'file') {
            await client.query(
              `DELETE FROM ${this.#t('fs_chunks')} WHERE path = $1`,
              [newPath],
            );

            const chunks = rowsOf(
              chunkRow,
              await client.query(
                `SELECT chunk_index, data FROM ${this.#t('fs_chunks')} WHERE path = $1`,
                [entry.path],
              ),
            );

            for (const chunk of chunks) {
              await client.query(
                `INSERT INTO ${this.#t('fs_chunks')} (path, chunk_index, data) VALUES ($1, $2, $3)`,
                [newPath, chunk.chunk_index, chunk.data],
              );
            }
          }
        }

        await client.query(
          `DELETE FROM ${this.#t('fs_entries')} WHERE path = $1 OR path LIKE $1 || '/%'`,
          [srcPrefixed],
        );
      } else {
        await client.query(
          `INSERT INTO ${this.#t('fs_entries')} (path, type, mode, size, mtime, symlink_target)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (path) DO UPDATE SET type = EXCLUDED.type, mode = EXCLUDED.mode, size = EXCLUDED.size, mtime = EXCLUDED.mtime, symlink_target = EXCLUDED.symlink_target`,
          [
            destPrefixed,
            srcEntry.type,
            srcEntry.mode,
            srcEntry.size,
            Date.now(),
            srcEntry.symlink_target,
          ],
        );

        if (srcEntry.type === 'file') {
          await client.query(
            `DELETE FROM ${this.#t('fs_chunks')} WHERE path = $1`,
            [destPrefixed],
          );

          const chunks = rowsOf(
            chunkRow,
            await client.query(
              `SELECT chunk_index, data FROM ${this.#t('fs_chunks')} WHERE path = $1`,
              [srcPrefixed],
            ),
          );

          for (const chunk of chunks) {
            await client.query(
              `INSERT INTO ${this.#t('fs_chunks')} (path, chunk_index, data) VALUES ($1, $2, $3)`,
              [destPrefixed, chunk.chunk_index, chunk.data],
            );
          }
        }

        await client.query(
          `DELETE FROM ${this.#t('fs_entries')} WHERE path = $1`,
          [srcPrefixed],
        );
      }
    });
  }

  resolvePath(base: string, relativePath: string): string {
    return path.posix.resolve(base, relativePath);
  }

  getAllPaths(): string[] {
    throw new Error(
      'getAllPaths() is not supported in PostgresFs - use getAllPathsAsync() instead',
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
        `SELECT EXISTS(SELECT 1 FROM ${this.#t('fs_entries')} WHERE path = $1) AS exists`,
        [resolved],
      ),
    );
    if (!rows[0].exists) {
      throw new Error(`ENOENT: no such file or directory: ${filePath}`);
    }

    return this.#unprefixPath(resolved);
  }

  async utimes(filePath: string, _atime: Date, mtime: Date): Promise<void> {
    const normalized = this.#normalizePath(filePath);
    const prefixed = this.#prefixPath(normalized);
    const resolved = await this.#resolveSymlink(prefixed);

    const result = await this.#exec(
      `UPDATE ${this.#t('fs_entries')} SET mtime = $1 WHERE path = $2`,
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
      `UPDATE ${this.#t('fs_entries')} SET mode = $1 WHERE path = $2`,
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
        `SELECT EXISTS(SELECT 1 FROM ${this.#t('fs_entries')} WHERE path = $1) AS exists`,
        [prefixed],
      ),
    );
    if (existingRows[0].exists) {
      throw new Error(`EEXIST: file already exists: ${linkPath}`);
    }

    await this.#useTransaction(async (client) => {
      await this.#ensureParentExists(prefixed, client);

      await client.query(
        `INSERT INTO ${this.#t('fs_entries')} (path, type, mode, size, mtime, symlink_target)
         VALUES ($1, 'symlink', 511, 0, $2, $3)`,
        [prefixed, Date.now(), target],
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
        `SELECT * FROM ${this.#t('fs_entries')} WHERE path = $1`,
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
        `SELECT EXISTS(SELECT 1 FROM ${this.#t('fs_entries')} WHERE path = $1) AS exists`,
        [destPrefixed],
      ),
    );
    if (existingRows[0].exists) {
      throw new Error(`EEXIST: file already exists: ${newPath}`);
    }

    await this.#useTransaction(async (client) => {
      await this.#ensureParentExists(destPrefixed, client);

      await client.query(
        `INSERT INTO ${this.#t('fs_entries')} (path, type, mode, size, mtime)
         VALUES ($1, 'file', $2, $3, $4)`,
        [destPrefixed, srcEntry.mode, srcEntry.size, Date.now()],
      );

      const chunks = rowsOf(
        chunkRow,
        await client.query(
          `SELECT chunk_index, data FROM ${this.#t('fs_chunks')} WHERE path = $1`,
          [srcPrefixed],
        ),
      );

      for (const chunk of chunks) {
        await client.query(
          `INSERT INTO ${this.#t('fs_chunks')} (path, chunk_index, data) VALUES ($1, $2, $3)`,
          [destPrefixed, chunk.chunk_index, chunk.data],
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
        `SELECT type, symlink_target FROM ${this.#t('fs_entries')} WHERE path = $1`,
        [prefixed],
      ),
    );

    if (!entry) {
      throw new Error(`ENOENT: no such file or directory: ${linkPath}`);
    }

    if (entry.type !== 'symlink') {
      throw new Error(`readlink: not a symbolic link: ${linkPath}`);
    }

    return entry.symlink_target;
  }
}
