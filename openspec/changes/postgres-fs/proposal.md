## Why

The virtual filesystem layer (`packages/text2sql/src/lib/fs/`) currently has SQLite and SQL Server backends. PostgreSQL is already a dependency (`pg: ^8.17.2`) and has database adapters elsewhere in the project (text2sql postgres adapter, context postgres store), but there is no `PostgresFs` implementation. Users deploying on PostgreSQL-based infrastructure cannot use the virtual filesystem without running a separate SQLite or SQL Server instance.

## What Changes

- New `PostgresFs` class implementing `IFileSystem` (from `just-bash`), following the same two-table schema pattern (`fs_entries` + `fs_chunks`) used by `SqliteFs` and `MssqlFs`
- New DDL file for PostgreSQL-specific table creation (using `BYTEA` for chunk data, `ON CONFLICT` for upserts)
- Async API surface matching `MssqlFs` (connection pool lifecycle, explicit `initialize()`, `getAllPathsAsync()`)
- Integration tests using the existing `withPostgresContainer` test helper from `@deepagents/test`
- Export from `packages/text2sql/src/lib/fs/index.ts`

## Capabilities

### New Capabilities

- `postgres-fs`: PostgreSQL-backed virtual filesystem implementing `IFileSystem` — pool injection, schema scoping, root path isolation, chunked file storage, symlink resolution, and transactional writes

### Modified Capabilities

_(none)_

## Impact

- **Code**: New files in `packages/text2sql/src/lib/fs/postgres/` (implementation + DDL), new test file in `packages/text2sql/test/fs/`
- **Dependencies**: Uses existing `pg` dependency — no new packages required
- **APIs**: New `PostgresFs` class export; no changes to existing APIs
- **Composability**: Works with existing `ScopedFs` and `TrackedFs` decorators unchanged
