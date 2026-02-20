## 1. DDL and Schema

- [x] 1.1 Create `packages/text2sql/src/lib/fs/postgres/ddl.postgres-fs.ts` exporting `postgresFsDDL(schema: string): string` — `fs_entries` table (`TEXT` path PK, `TEXT` type, `INT` mode, `BIGINT` size, `BIGINT` mtime, `TEXT` symlinkTarget), `fs_chunks` table (`TEXT` path, `INT` chunkIndex, `BYTEA` data, composite PK, FK cascade), index on type. Use `CREATE TABLE IF NOT EXISTS` and `CREATE SCHEMA IF NOT EXISTS`. Fully-qualified `"schema"."table"` names.

## 2. Core Implementation

- [x] 2.1 Create `packages/text2sql/src/lib/fs/postgres/postgres-fs.ts` with `PostgresFs` class implementing `IFileSystem`. Constructor accepts `PostgresFsOptions` (`pool: Pool | PoolConfig | string`, `root: string`, `chunkSize?: number`, `schema?: string` defaulting to `'public'`). Lazy-require `pg` via `createRequire`. Pool ownership detection via `instanceof pg.Pool`. Schema name validation with `/^[a-zA-Z_]\w*$/`.
- [x] 2.2 Implement `initialize()` — connect owned pool, create schema, execute DDL, ensure root `/` entry exists, create parent dirs for configured root. Set `#isInitialized` flag. `#ensureInitialized()` guard on all operations.
- [x] 2.3 Implement helper methods: `#query<T>(sql, params)`, `#exec(sql, params)`, `#useTransaction<T>(fn)` (acquire client, BEGIN/COMMIT/ROLLBACK, release), `#normalizePath`, `#prefixPath`, `#unprefixPath`, `#dirname`, `#ensureParentExists`, `#resolveSymlink` (with circular detection via `Set`), `#toUint8Array`.
- [x] 2.4 Implement `#writeChunks(path, content, client)` and `#readChunks(path)` — delete existing chunks then insert in loop (parameterized `$1, $2, $3`), read with `ORDER BY chunkIndex`.
- [x] 2.5 Implement file operations: `readFile`, `readFileBuffer`, `writeFile` (upsert via `ON CONFLICT`), `appendFile` (read-concat-write), `exists`.
- [x] 2.6 Implement directory operations: `mkdir` (recursive and non-recursive), `readdir`, `readdirWithFileTypes` — use `LIKE prefix || '%'` for direct children filtering.
- [x] 2.7 Implement `stat`, `lstat`, `chmod`, `utimes` — stat follows symlinks, lstat does not.
- [x] 2.8 Implement `rm` (file, directory recursive, force), `cp` (file and directory recursive), `mv` (file and directory).
- [x] 2.9 Implement `symlink`, `link`, `readlink`.
- [x] 2.10 Implement `resolvePath`, `getAllPaths` (throw with message directing to async), `getAllPathsAsync`, `realpath`, `close`.

## 3. Export

- [x] 3.1 Add `export * from './postgres/postgres-fs.ts'` to `packages/text2sql/src/lib/fs/index.ts`.

## 4. Integration Tests

- [x] 4.1 Create `packages/text2sql/test/fs/postgres-fs.integration.test.ts` using `withPostgresContainer` from `@deepagents/test`. Import `PostgresFs` from `@deepagents/text2sql`.
- [x] 4.2 Test file operations: write/read string, write/read binary, overwrite, append, read non-existent throws ENOENT, auto-create parent dirs.
- [x] 4.3 Test chunking: file larger than chunk size writes and reads correctly.
- [x] 4.4 Test directory operations: mkdir, mkdir recursive, readdir, readdirWithFileTypes.
- [x] 4.5 Test remove operations: rm file, rm directory recursive, force remove non-existent.
- [x] 4.6 Test copy and move: cp file, cp directory recursive, mv file.
- [x] 4.7 Test stat operations: file stats, directory stats, chmod.
- [x] 4.8 Test symlink operations: create/read symlink, stat vs lstat.
- [x] 4.9 Test root isolation: path prefixing, root dir auto-creation, two instances with different roots.
- [x] 4.10 Test pool injection: accept existing Pool, don't close external pool on close().
- [x] 4.11 Test schema support: custom schema creates tables there, idempotent initialization.

## 5. Build Verification

- [x] 5.1 Run `nx run text2sql:build` and verify `PostgresFs` is included in the dist output.
- [x] 5.2 Run integration tests with `node --test packages/text2sql/test/fs/postgres-fs.integration.test.ts` and verify all pass.
