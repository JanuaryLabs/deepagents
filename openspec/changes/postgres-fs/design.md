## Context

The virtual filesystem layer in `packages/text2sql/src/lib/fs/` provides two database-backed `IFileSystem` implementations:

- **`SqliteFs`** — synchronous, uses `node:sqlite` `DatabaseSync`, prepared statement caching
- **`MssqlFs`** — async, uses `mssql` npm package, lazy-required via `createRequire`, explicit `initialize()`

Both share the same two-table schema (`fs_entries` for metadata, `fs_chunks` for 1MB-chunked file content) and the same POSIX-like path semantics (root prefix, symlink resolution, parent auto-creation).

PostgreSQL is already used elsewhere in the project (`PostgresContextStore` in `packages/context`, Postgres adapter in `packages/text2sql`). The `pg` package is already a dependency. A `PostgresFs` implementation completes database coverage for teams deploying on PostgreSQL infrastructure.

## Goals / Non-Goals

**Goals:**

- Implement `PostgresFs` class that fully implements `IFileSystem` from `just-bash`
- Match `MssqlFs` API surface: async operations, explicit `initialize()`, pool injection, `close()` semantics, `getAllPathsAsync()`
- Support PostgreSQL schema scoping (equivalent to MSSQL's `[schema].[table]` pattern)
- Support root path isolation and composability with `ScopedFs`/`TrackedFs` decorators
- Integration tests using `withPostgresContainer` from `@deepagents/test`

**Non-Goals:**

- Connection string parsing or custom connection managers — rely on `pg.Pool` entirely
- Streaming reads/writes for large files — chunking is sufficient (matches existing implementations)
- Support for PostgreSQL versions below 9.5 (`ON CONFLICT` clause required)
- Postgres-specific features (LISTEN/NOTIFY, advisory locks) — keep parity with existing implementations

## Decisions

### 1. Lazy-require `pg` via `createRequire`

**Choice:** Dynamic `require('pg')` at construction, not a top-level import.

**Why:** Matches `MssqlFs` and `PostgresContextStore` patterns. Keeps `pg` as an optional peer dependency — users who only use `SqliteFs` don't need `pg` installed. The `createRequire(import.meta.url)` pattern works in ESM contexts.

**Alternative considered:** Top-level `import('pg')` — rejected because it would make the module fail to load even when `PostgresFs` isn't used.

### 2. Pool injection with ownership semantics

**Choice:** Accept `Pool | PoolConfig | string` in options. If given a config/string, create and own the pool (close it on `close()`). If given an existing `Pool`, don't close it.

**Why:** Exact same pattern as `MssqlFs`. Enables both simple usage (pass connection string) and shared pool scenarios (multiple `PostgresFs` instances sharing one pool).

**Detection:** Use `instanceof pg.Pool` check, same as `MssqlFs` uses `instanceof mssql.ConnectionPool`.

### 3. Explicit `initialize()` (not constructor-based)

**Choice:** Require `await fs.initialize()` after construction.

**Why:** `pg.Pool` is async (unlike `node:sqlite` `DatabaseSync`). Constructor can't be async, and auto-initializing in the background (like `PostgresContextStore` does with `#initialized = this.#initialize()`) adds complexity for a filesystem where every operation depends on DDL being ready. Explicit init is simpler and matches `MssqlFs`.

### 4. DDL as a TypeScript function (not .sql file)

**Choice:** `ddl.postgres-fs.ts` exporting a function `postgresFsDDL(schema: string): string`.

**Why:** Schema name must be interpolated into DDL. Matches `MssqlFs` pattern (`ddl.mssql-fs.ts`). `SqliteFs` uses a `.sql` file because it doesn't support schema scoping.

DDL uses:

- `TEXT` for path (no length limit, unlike MSSQL's `NVARCHAR(900)`)
- `BYTEA` for chunk data
- `BIGINT` for size/mtime
- `ON CONFLICT DO NOTHING` for idempotent table creation via `CREATE TABLE IF NOT EXISTS`
- `ON DELETE CASCADE ON UPDATE CASCADE` on foreign key (matching SQLite/MSSQL)

### 5. Parameterized queries with `$1, $2, ...` syntax

**Choice:** Use `pg`'s native parameterized query syntax (`$1`, `$2`, etc.) everywhere.

**Why:** Prevents SQL injection. `pg` uses `$N` positional parameters (vs MSSQL's `@pN` named params). The helper methods `#query` and `#exec` will take a `params` array and map to positional parameters.

### 6. Transaction management via `Pool.connect()` + client

**Choice:** `#useTransaction` acquires a client from the pool, runs `BEGIN`/`COMMIT`/`ROLLBACK`, then releases.

**Why:** Standard `pg` transaction pattern. Matches `PostgresContextStore.#useTransaction`. Each transaction gets a dedicated client from the pool — no serialization bottleneck.

### 7. Schema scoping via `search_path` or qualified names

**Choice:** Use fully-qualified table names `"${schema}"."fs_entries"` (double-quoted identifiers).

**Why:** More explicit than `SET search_path`. Matches how `MssqlFs` uses `[schema].[table]`. Avoids session-level side effects from changing `search_path`. Schema is created via `CREATE SCHEMA IF NOT EXISTS`.

**Validation:** Reject schema names that don't match `/^[a-zA-Z_]\w*$/` (same regex as `MssqlFs`).

## Risks / Trade-offs

**`LIKE` with `||` for directory listing may be slow on large datasets** → Same risk exists in `SqliteFs`/`MssqlFs`. Mitigated by index on `path`. For the virtual FS use case (agent artifacts, not millions of files), this is acceptable.

**No prepared statement caching** → `pg.Pool` doesn't expose a synchronous `prepare()` like `node:sqlite`. Using `pool.query(text, params)` relies on PG's built-in prepared statement caching at the protocol level. For the expected query volume, this is fine.

**`getAllPaths()` throws synchronously (same as `MssqlFs`)** → The `IFileSystem` interface defines `getAllPaths(): string[]` as sync. Since `pg` is async, we throw and provide `getAllPathsAsync()`. Callers needing all paths must use the async variant. This is a known limitation of the interface for async backends.
