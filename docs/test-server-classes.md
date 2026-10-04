# Test server class refactor

Status: implemented and verified. The user approved replacing the container function API
with instance classes, migrating every legacy caller, and retaining no backward
compatibility. This builds on the portable Docker lifecycle described in
`portable-test-servers.md`.

The follow-up folder and SQLite migration is recorded at the end of this report.
The original class-refactor counts and verification below describe that earlier
change; SQLite is now included in the package's instance API.

## Scope recorded before implementation

- Replace free Docker availability, discovery, creation, reuse, and handle
  factories with `Docker` and `Container` instances.
- Replace engine startup and callback lifecycle functions with `Postgres`,
  `Mysql`, and `SqlServer` instances. Database handles remain disposable objects.
- Delete callback lifetime plumbing in the two pg-boss harnesses.
- Move engine SQL, readiness, query parsing, and connection formatting into
  private instance methods. Bind SQL Server FTS readiness to its database handle.
- Migrate all 24 external consumer test files (384 callback acquisitions), the
  three package integration files, and repository documentation. Delete the old
  engine module paths and exports.

Retain shared server lifetime until explicit cleanup, independent databases per
acquisition, dedicated ownership for explicit startup, Docker name-based
coordination, readiness polling, and fail-closed behavior without Docker.
Leave unrelated release work and product implementation unchanged.

## Capability discovery and constraints

- `nano-spawn` 2.1.0 publicly exports `spawn` and `SubprocessError` through
  `source/index.js`. Its result and argument APIs already cover command execution
  and failure inspection; no subprocess wrapper or new package is needed.
- Docker CLI `create --name`, `inspect`, `start`, `port`, `exec`, `stop`, and
  `--rm` retain ownership of process coordination and container removal.
- Native `await using` and `Symbol.asyncDispose` own test scope cleanup; remove
  the callback API and the promises that bridge its lifetime.
- `p-retry` already supplies polling through the existing `timebox` primitive.
  Its public options are retained; no retry mechanism is introduced.
- `mssql` publicly exposes `ConnectionPool`; retain its connect/query/close
  lifecycle. No container coordination API exists in these installed packages.
- Searched subprocess/retry exports, runtime, options, and environment/debug
  hooks. No coordination facility or observation hook is needed beyond the
  existing Docker CLI and integration tests.
- Similar container lifecycle classes exist in the context sandbox. Do not
  import that product package into the domain-free test package or copy its
  broader sandbox inheritance hierarchy.
- Commit `ff3b06c59f4ab8543d608fdc9de9ffc0ea0c211f` requires PostgreSQL readiness
  over TCP: the temporary initialization server listens only on a socket.
  Commit `2942565652f0f04f5025526dfdc53b3e5bda5695` requires missing Docker to fail
  explicitly. Both constraints remain.
- Image, credentials, database names, polling budgets, and platform-specific
  SQL Server images are this package's existing configuration policy. Preserve
  them while moving configuration into instances; they are not substitutes for
  missing dependency values. Optional caller settings remain optional inputs.

## Proof planned before implementation

- Docker integration: matching normalized configurations share identity;
  different settings stay separate; label mismatches cannot claim another
  container; incomplete creation is recoverable; owned startup failure cleans up.
- Engine integration: independent processes and instances share one server,
  receive different databases, release on success/error, and recreate after
  explicit removal. Explicit startup honors the requested database and owns
  container disposal. Absence of Docker rejects every acquisition API.
- Consumer integration: run the 24 affected files through their existing Nx test
  targets, including SQL Server FTS, PostgreSQL readiness, queues, scheduling,
  streams, database filesystems, SQL policy, and ClickHouse generic ownership.
- Inspect public exports and grep removed symbols/module paths to zero after
  migration; verify no static methods or compatibility aliases remain.

## Baseline

Package typecheck and lint passed. The first package test attempt passed six of
seven tests; the seventh worker could not import `dist/index.js` while a second
Nx invocation rebuilt that dependency. This was verification interference, not
a lifecycle failure. Subsequent Nx invocations are serialized. The serialized repeat passed all seven package tests. Consumer baselines passed
267 context tests, 105 experimental tests, and 241 text2sql tests. Experimental
required one retry after an Nx project-graph cache error in a dependency build;
no product code was changed to address that transient error.

## Consumer inventory

The following 24 external test files were measured before editing. Every callback
site was parsed before migration: 318 expression-bodied test callbacks, 62 awaited
statements, two returning helpers, and two returning pg-boss harnesses. The first
382 migrate to lexical resource scopes; the two harnesses transfer ownership with
native `AsyncDisposableStack.use/defer/move`. Their callers retain disposal.

- `packages/text2sql/test/postgres-readiness.integration.test.ts`
- `packages/text2sql/src/lib/adapters/sql-policy.integration.test.ts`
- `packages/text2sql/src/lib/adapters/clickhouse/clickhouse.integration.test.ts`
- `packages/text2sql/src/lib/adapters/postgres/column-values.postgres.grounding.test.ts`
- `packages/text2sql/test/fs/postgres-fs.integration.test.ts`
- `packages/text2sql/test/fs/mssql-fs.integration.test.ts`
- `packages/context/test/postgres/postgres-context-store.integration.test.ts`
- `packages/context/test/postgres/stream-store.integration.test.ts`
- `packages/context/test/postgres/user-chats.test.ts`
- `packages/context/test/postgres/branching.test.ts`
- `packages/context/test/postgres/fts.test.ts`
- `packages/context/test/postgres/delete-chat.test.ts`
- `packages/context/test/postgres/stream-notify.integration.test.ts`
- `packages/context/test/sqlserver/sqlserver-context-store.integration.test.ts`
- `packages/context/test/sqlserver/user-chats.test.ts`
- `packages/context/test/sqlserver/branching.test.ts`
- `packages/context/test/sqlserver/fts.test.ts`
- `packages/context/test/sqlserver/delete-chat.test.ts`
- `packages/experimental/src/zukhruf/queue/pg-boss.turn-queue.contract.test.ts`
- `packages/experimental/src/zukhruf/queue/crash-recovery.integration.test.ts`
- `packages/experimental/src/zukhruf/runtime/conversation-status/pg-boss-change-source.contract.test.ts`
- `packages/experimental/src/zukhruf/plugins/conversation-scheduling/scheduling.integration.test.ts`
- `packages/experimental/src/zukhruf/plugins/conversation-scheduling/pg-boss.wake-scheduler.contract.test.ts`
- `packages/experimental/src/zukhruf/plugins/schedules/scheduled-tasks.integration.test.ts`

## Self-audit

- Exactly five runtime classes; no static methods, class inheritance, compatibility
  exports, deprecated aliases, callback APIs, or module forwarding files.
- The three engine handle interfaces collapse into a common `Database` contract
  with MySQL query and SQL Server FTS extensions. Engine handles retain their
  actual per-call resource; no instance has a mutable current database.
- `Container.exec` returns the subprocess package's own result instead of
  wrapping and filtering stdout/stderr. Bound instance operations preserve
  destructuring in readiness probes and cleanup transfer to database handles.
- Configuration fingerprints retain the existing normalized JSON representation,
  so existing servers are discoverable without any migration registry.
- Defaults are limited to the existing public engine configuration and polling
  policy. Empty env/label/tmpfs values normalize optional caller input for Docker
  identity and arguments. No dependency result is replaced with a fallback.
- Retain `undefined` for an absent inspected container and the lazy availability
  promise; retain SQL NULL/missing-cell interpretation in MySQL batch output.
  These represent real absence. Two obsolete `Promise<T | undefined>` helper
  return annotations were narrowed to `Promise<T>`.
- No suppression directives or new dependencies. Standalone polling and deadline
  primitives remain functions because they own no container or engine state.

## Final verification and removal report

Verdict: all requested API removals are implemented. All 27 affected test files
passed: 9 package tests, 267 context tests, 105 experimental tests, and 241
text2sql tests (622 total). The test package and all three consumer projects
passed Nx typecheck; package lint also passed. The three shared verification
servers were reused across the baseline and migrated runs with identical IDs.
Cleanup verification is recorded below.

### Removed

- Eleven exported container functions, their private factories, and old engine
  module paths. The public-export assertion and zero-match source/generated-output
  searches prove there is one class API with no forwarding or compatibility path.
- Callback-based acquisition at all 384 consumer sites. Native scope disposal is
  observed on success and error in all four engine variants, with database deletion
  verified against the server after child process exit.
- Promise-based lifetime bridges in the two pg-boss harnesses and their obsolete
  unavailable-result branch. Both contract suites passed inside the 105 executed
  experimental tests; cleanup ownership now transfers through a native stack.
- Repeated engine metadata interfaces, SQL Server connection-string formatting,
  MySQL query factories, and the standalone SQL Server FTS function. Public handle
  behavior is exercised by SQL policy, FTS, filesystem, and explicit-startup tests.
- Old API examples and obsolete return unions in two PostgreSQL test harnesses.
  All affected consumer files were executed, and the current examples use the
  same package imports and resource-scope syntax.

### Net delta

Measured against the workspace snapshot taken at the start of this class
refactor, including newly created files and excluding earlier lifecycle/release
changes: 12,650 lines added, 12,490 deleted, +160 net. Runtime source in the test
package is 682 added and 1,021 deleted: **339 fewer lines**. The overall increase
is documentation and new verification coverage; the large changed-line count
also reflects removing callback indentation throughout the consumer suites.

### Retained

- `container.ts` now implements the actual container handle. The Docker and engine
  classes and common database types have their own modules; no old module aliases.
- Existing image/credential policy, platform image selection, TCP readiness,
  per-engine polling budgets, Docker identity labels and conflict checks, missing
  Docker failure, best-effort cleanup, and persistent shared-server lifetime.
- Explicit `cleanup()` and native disposal: both are deliberate resource APIs,
  used by existing owners and native resource scopes, rather than compatibility
  wrappers around the removed acquisition API.
- Public image constants, MySQL querying, and SQL Server FTS catalog behavior.
  FTS now belongs to its returned database handle.
- The two independent test primitives, local product/store harnesses, and SQLite
  fixtures. These do not implement the removed Docker API.
- Integration tests, this report, updated usage/design documents, and clearly
  marked historical lifecycle reports retain the evidence and current contract.
  Unrelated release work, Nx targets, dependencies, and Git staging are preserved.

### Rejected

- REJECTED: keeping old exports, aliases, forwarding files, or callback adapters;
  the user explicitly required no backward compatibility.
- REJECTED: a shared engine superclass, strategy registry, or new coordinator
  dependency. Composition with Docker covers the current three engines.
- REJECTED: static factories, async constructors, or a mutable current-database
  field. Async instance methods return ready, independently disposable resources.
- REJECTED: moving generic polling or deadline helpers into an unrelated class.
  They own no engine state and their existing public contracts remain useful.

### Unproven

Other operating systems and the rest of the monorepo were not executed. All 24
changed external test files and all three package integration files were executed
on the current macOS/Docker environment. No changed runtime path is being accepted
on compiler or source-reading evidence alone.

### Unresolved

None. This is the user-approved breaking API migration; no pending API decision or
compatibility exception remains.

## Commands and cleanup

- `NX_DAEMON=false npx nx run-many --targets=typecheck,lint,test --projects=@deepagents/test --parallel=1 --skip-nx-cache`
- Each consumer project: `NX_DAEMON=false npx nx run @deepagents/<project>:test --skip-nx-cache --args="--test-concurrency=2 <the affected files listed above>"`
- `NX_DAEMON=false npx nx run-many --targets=typecheck --projects=@deepagents/context,@deepagents/experimental,@deepagents/text2sql --parallel=1 --skip-nx-cache`
- Source and generated-output searches found no removed container API symbols or
  old module paths. The five runtime classes contain no static methods. Public
  export assertions passed. `git diff --check` passed.

Cleanup verified: the three shared servers created by these runs were stopped
and confirmed absent. Verification-scoped containers were removed by their
tests. The pre-existing application containers were preserved. No owned test
runner remains. Changes are uncommitted and unstaged. Temporary migration scripts,
drafts, and measurement files were deleted after recording their results here.

## Folder structure and SQLite follow-up

Scope: move the flat source files into `docker/`, `databases/`, and `async/`,
retain the root public barrel, and rename the public-surface test to
`api.integration.test.ts`. Add `databases/sqlite.ts` with an instance-only
`Sqlite.database()` API. Remove the context-local SQLite callback helper and
migrate its 92 calls: branching (23), delete-chat (23), FTS (6), user-chats (40).

Capability discovery: Node 26.8.1 publicly provides `mkdtempDisposable`,
`DatabaseSync[Symbol.dispose]`, and `AsyncDisposableStack.use/move/disposeAsync`.
A live native-API probe created and queried a file-backed database, then observed
the closed connection and removed directory after disposal. The context store
already accepts a public `DatabaseSync` instance. No product dependency, new
package, fake Docker metadata, or SQLite container is needed.

The original helper from commit `2ef9bdbd` guarantees fresh temporary files and
cleanup after the callback. Preserve filesystem-backed isolation while closing
the connection explicitly before removal. The new primitive composes native
resources in a disposable stack, including cleanup on partial initialization.

Baseline: all 92 context tests passed. The package's two API tests passed; seven
Docker tests could not acquire servers because the sandbox denied access to
`~/.docker/run/docker.sock`. Nx plugin-worker sockets were also denied; the
documented `NX_ISOLATE_PLUGINS=false` mode allowed Nx itself to run. No Nx or
sandbox configuration files were changed.

Proof: run all migrated context tests and package integration tests; assert
concurrent acquisition isolation, file-backed visibility through a second
connection, independent/idempotent cleanup, fresh reacquisition, and cleanup of
connections and WAL files after failure. Check public imports, generated
declarations, obsolete helper references, and the moved import paths.

Retained: existing Docker behavior, engine options, public imports, independent
async helpers, and product-specific store construction. REJECTED: moving
`SqliteContextStore` into the test package, keeping a callback compatibility
wrapper, inventing SQLite server metadata, or adding static factories. The
native-only caller recipe was replaced by the user's explicitly requested
shared `Sqlite` class. Separate benchmark/stream/concurrent-store fixtures are
recorded as follow-up backlog item 2204 rather than added to this migration.

Final verification: all 92 migrated context tests passed, and the final full
test-package run passed all 11 tests (103 total). Both `@deepagents/test` and
`@deepagents/context` passed Nx typecheck. Package lint passed; scoped consumer
lint had no errors and 15 existing warnings in unchanged assertions. The first
context test attempt encountered Nx's missing cached ProjectGraph error before
tests started; its retry passed without code changes.

The first Docker-enabled full run passed 10/11 tests: a PostgreSQL worker failed
shared-container identity validation during concurrent acquisition. A focused
retry failed the same way. One run against the saved pre-change public source
passed, and the final full run also passed. The Docker implementation itself is
byte-identical across the move. The cause remains unproven; follow-up defect 2205
records the observations without claiming it predates this refactor.

Removed: the old SQLite callback helper, all 92 callback acquisitions, and the
old flat source paths. Syntax-tree comparison verified every migrated test body
retains its original statements. Six moved files are byte-identical; the three
server engine implementations differ only in imports. Source searches found no
remaining callback-helper references, compatibility modules, or static methods.
The public API test and emitted declarations confirm the new `Sqlite` export.

Net delta: 2,257 lines added, 2,081 deleted, +176 net, relative to
the pre-turn workspace snapshot with moved files matched. This is net-additive
because of the new integration coverage and documentation. The new SQLite runtime
is 27 lines and replaces the 34-line local helper.

Self-audit: SQLite composes native disposables with no dependency additions,
custom cleanup state, fallback values, optional configuration, or static
factories. The only product-store construction remains in context tests. The
native stack handles reverse-order cleanup and repeated disposal. Integration
tests observed concurrent file isolation, a second connection reading persisted
data, independent cleanup, fresh reacquisition, and connection/WAL cleanup after
an exception. No temporary SQLite directories remained after verification.

Unproven: other operating systems, the rest of the monorepo, and the root cause
of the intermittent PostgreSQL identity failure. Unresolved: defect 2205 and
separate fixture migration 2204 are tracked; no API choice is pending.

Commands used `NX_DAEMON=false NX_ISOLATE_PLUGINS=false` without changing repo
configuration. Context tests selected the four migrated files through
`nx run @deepagents/context:test --args="..."`; package tests used
`nx run @deepagents/test:test`. Typechecks used the two projects' Nx targets.
The pre-change reproduction used a disposable temporary package and an explicit
Node test timeout. Changes remain unstaged and uncommitted.

Cleanup verified: only the two pre-existing application containers remain.
All test command sessions exited, and the temporary reproduction package and
SQLite directories were removed. Verification logs are retained under `/tmp`.
