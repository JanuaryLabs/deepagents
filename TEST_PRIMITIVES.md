# Test Primitives

Tests target the repository's current Node.js version. Prefer these native
primitives before adding helpers or dependencies.

`@zukhruf/testing` is for domain-free test primitives. Each area has its own
import path, documented in the package README. Repeated fixture data,
product-specific harnesses, and infrastructure compositions stay with their
tests.

| Need                     | Use                                                                 | Important behavior                                                                                                 |
| ------------------------ | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Strict assertions        | `node:assert/strict`                                                | Makes methods such as `equal` and `deepEqual` strict by default.                                                   |
| Delay                    | `setTimeout` from `node:timers/promises`                            | Alias it to `sleep`; it supports `AbortSignal` and avoids hand-written promises.                                   |
| Retry an observation     | `TestContext.waitFor` from `node:test`                              | The callback must throw or reject while waiting. Returning `false` counts as success.                              |
| Measure a deadline       | `performance.now()`                                                 | Monotonic elapsed time; do not use it as a timestamp or compare it across processes.                               |
| Temporary directory      | `new TemporaryFiles().directory(prefix)` from `@zukhruf/testing/fs` | Use with `await using`; cleanup removes the directory and its contents, with retries for a file that is held open. |
| Resource cleanup         | `using` / `await using`                                             | Calls `Symbol.dispose` / `Symbol.asyncDispose` in reverse declaration order, including after errors.               |
| Deferred promise         | `Promise.withResolvers()`                                           | Provides `{ promise, resolve, reject }` without capturing callbacks in a promise constructor.                      |
| Disposable timeout       | `using timer = globalThis.setTimeout(...)`                          | Node timers implement `Symbol.dispose`, which cancels the timer when its scope exits.                              |
| Wait for one event       | `once` from `node:events`                                           | Register before triggering the event; it resolves with the emitted arguments.                                      |
| Current module directory | `import.meta.dirname`                                               | Replaces `fileURLToPath(import.meta.url)` plus `dirname` in Node ESM files.                                        |
| Current Node executable  | `process.execPath`                                                  | Use when spawning another Node process instead of assuming `node` is on `PATH`.                                    |
| Non-mutating sort        | `Array.prototype.toSorted()`                                        | Returns a shallow sorted copy; provide `(a, b) => a - b` for numbers.                                              |
| Bound promise settlement | `settleWithin` from `@zukhruf/testing/async`                        | Rejects if a non-abortable promise does not settle in time; it does not cancel the underlying operation.           |

## Established patterns

Use assertions inside `t.waitFor`; a boolean predicate stops immediately:

```ts
await t.waitFor(() => assert.equal(messages.length, 2), {
  interval: 20,
  timeout: 5_000,
});
```

`t.waitFor` retries every error, also a database error. When a database error
must fail the test immediately, poll with `timebox` from
`@zukhruf/testing/async` and retry only the failed assertion:

```ts
await timebox(async () => assert.equal(await store.status(), 'ready'), {
  minTimeout: 20,
  maxRetryTime: 5_000,
  shouldRetry: ({ error }) => error instanceof assert.AssertionError,
});
```

Declare resources after their disposable parent so reverse-order cleanup closes
handles before deleting the directory:

```ts
await using directory = await new TemporaryFiles().directory('test-');
await using file = await open(join(directory.path, 'data.txt'), 'w');
```

Use `settleWithin` only when the operation cannot accept a cancellation signal:

```ts
await settleWithin(workerFinished, 'worker finishes', 5_000);
```

If an operation accepts a signal, pass `AbortSignal.timeout(ms)` to it so the
operation itself is cancelled. Keep races where timeout means success or
returns a fallback value local because they have different semantics.

## Streams

Use `ReadableStream.from(chunks)` for a fixed sequence, `Array.fromAsync(stream)`
to collect a successful stream, and `text` from `node:stream/consumers` to decode
text. Keep pull-driven sources local when a test observes backpressure or a
custom cancellation hook.

`StreamHarness` provides controlled producers and disposable readers:

```ts
import { StreamHarness } from '@zukhruf/testing/streams';

const streams = new StreamHarness();

it('reads a controlled response', async () => {
  using source = streams.source<string>();
  await using reader = streams.reader(source.stream);
  const first = reader.read();
  source.enqueue('first');
  assert.deepEqual(await first, { done: false, value: 'first' });

  source.enqueue('second');
  source.close();
  assert.deepEqual(await reader.collectUntilError(), {
    status: 'completed',
    chunks: ['second'],
  });
});
```

Each `source<T>()` returns an independent stream with `enqueue`, `close`, `error`,
and a read-only `state`: `open`, `closed`, `errored`, or `cancelled`. `closed`
means the producer requested closure; queued chunks still drain. Native stream
rules apply: enqueue or close after closure throws, and an error discards unread
chunks, including those queued before closure. Disposal closes only an open
source and is safe after cancellation or failure.

`reader(stream)` immediately acquires the native reader lock without reading or
buffering ahead. `read()` preserves native results and errors. `collectUntilError()`
collects only the remaining chunks and returns either `{ status: 'completed', chunks }`
or `{ status: 'errored', chunks, error }`, including when the error is `undefined`.
Disposal cancels unfinished consumption through the locked reader and releases
the lock. It does not rethrow an existing stream failure, but a failing cancellation
hook still rejects disposal. Use `settleWithin` separately when a test needs a
deadline. AI message chunks, transport behavior, and runtime fixtures stay local.

## HTTP servers

Use `HttpServer` for a disposable loopback server with a native request handler:

```ts
import { HttpServer } from '@zukhruf/testing/http';

await using server = await new HttpServer().start((_request, response) => {
  response.end('hello');
});
const response = await fetch(server.origin);
```

Each `start(handler)` binds `127.0.0.1` on an available port and resolves after
listening. The handle exposes `origin`, the native HTTP `server`, and bound
`cleanup()`. Use handle cleanup to stop early; repeated cleanup is safe. Disposal
stops accepting requests, closes active HTTP connections, and awaits shutdown,
including after scope failure. Upgraded connections and work started by handlers
remain caller-owned. Bind and cleanup errors reject. Routes, body parsing, error
responses, request recording, and protocol assertions stay in the tests.

## Databases

All database engines use instance acquisition and disposable handles. SQLite
owns a local file and native connection:

```ts
import { Sqlite } from '@zukhruf/testing/sqlite';

const sqlite = new Sqlite();

it('stores a record', async () => {
  await using database = await sqlite.database();
  database.connection.exec('CREATE TABLE records (id INTEGER)');
  // Product-specific stores can receive database.connection or database.path.
});
```

Each `Sqlite.database()` call creates a fresh file-backed database. Its handle
exposes `path`, a native `DatabaseSync` connection, and bound `cleanup()`.
Disposal closes the connection before removing the temporary directory, including
WAL files, on success or failure. Close any additional connections before that
scope exits. SQLite requires no Docker or global setup and does not share files
across acquisitions. Product stores and schema setup stay in their own tests.

To test contention against an existing SQLite file, acquire a timed write lock:

```ts
await using lock = await sqlite.writeLock(database.path, 200);
// Exercise a caller that must wait for the other writer to finish.
```

`writeLock(path, durationMs)` returns after a separate Node process acquires
`BEGIN IMMEDIATE`. That process releases the lock after the explicit duration,
even when the caller blocks in a synchronous SQLite operation. Disposing the
handle stops and awaits the process early; acquisition failures reject with the
child's error. The process also exits when its parent disconnects. The helper
does not change the caller's busy timeout, schema, or data.

DuckDB owns an in-memory instance and its native connection:

```ts
import { DuckDB } from '@zukhruf/testing/duckdb';

const duckdb = new DuckDB();
await using database = await duckdb.database();
await database.connection.run('CREATE TABLE records (id INTEGER)');
```

Each `DuckDB.database()` call creates an independent database without Docker or
global setup. The handle exposes the native `DuckDBConnection` and bound
`cleanup()`. Disposal closes the connection before the instance, including on
failure. SQL fixtures and product adapter wiring stay in their own tests.

BigQuery owns an isolated dataset in an explicitly selected cloud project:

```ts
import { BigQuery } from '@zukhruf/testing/bigquery';

const bigquery = new BigQuery({ projectId, location });
await using database = await bigquery.dataset();
await database.dataset.query('CREATE TABLE records AS SELECT 1 AS id');
const [rows] = await database.dataset.query('SELECT * FROM records');
```

Each `BigQuery.dataset()` call creates a unique dataset and exposes the native
Google Cloud `Dataset` as `dataset`. Its `query()` and `createQueryJob()` methods
already supply the dataset and location. Bound `cleanup()` and asynchronous
disposal delete the dataset and its contents once, including tables and views.
Acquisition and cleanup errors reject; callers own credentials, project/location
selection, fixtures, adapter wiring, and any skip policy. No Docker is involved.
The primitive's live integration tests require both
`TEXT2SQL_BIGQUERY_PROJECT_ID` and `TEXT2SQL_BIGQUERY_LOCATION`; the SDK resolves
credentials through its normal authentication configuration.

### Database servers

The `@zukhruf/nx/test` plugin gives each project with `node:test` files its `test`
target: the command, reporters and timeout. `nx.json` adds module mocks and the
build dependency. JUnit reports are written to each project's `test-results.xml`.

For PostgreSQL, MySQL, and SQL Server, create an engine instance and acquire a
disposable database for each test:

```ts
import { Docker, TestRun } from '@zukhruf/testing/docker';
import { Postgres } from '@zukhruf/testing/postgres';

const docker = new Docker({ testRun: TestRun.fromEnvironment(process.env) });
const postgres = new Postgres({ docker });

it('stores a record', async () => {
  await using database = await postgres.database();
  // Use database.connectionString. Close application clients before scope exit.
});
```

`Postgres`, `Mysql`, and `SqlServer` use instance methods only. Constructors store
configuration without starting anything. Each `database()` call finds or creates
a shared server and returns a fresh database. `await using` drops that database
on normal scope exit and on failure. Concurrent calls on the same instance are
independent. These classes work with Nx, plain `node --test`, or another runner;
no setup file or database project tags are required.

Docker reserves a deterministic name derived from the image and configuration.
Concurrent processes attach to the same container and wait for readiness;
Docker labels alone do not enforce uniqueness. Servers are shared on the same
Docker daemon across files, projects, process restarts, and test runs. Different
images, passwords, or labels select separate servers. Supply a unique label when
a verification suite must own a separate server. The constructor's `database`
option is used by `start()`; `database()` always creates a unique name.

Shared servers remain running until explicit cleanup. A readiness failure also
leaves the shared server available for diagnosis; one caller must not stop a
server another caller may be using. Abruptly killed tests can leave their database
behind until the container is removed. There is no idle timer or exit hook.

List the shared containers and, after their tests finish, stop the selected IDs:

```sh
docker ps -a --filter label=dev.zukhruf.testing.shared=1
docker stop <container-id> [<container-id> ...]
```

These containers use Docker's `--rm` option, so stopping also removes them.
Do not clean up a server while other tests are using it. The next acquisition
creates a replacement. Image tags are part of the configuration; explicitly
clean up to pick up a newer image behind the same tag.

Use `nx run <project>:test --args="path/to/file.test.ts"` for a focused test.
`await using server = await postgres.start()` creates a dedicated container;
disposing that handle stops its container. For other services, use a `Docker`
instance's `serve(options)` (a dedicated server) or `reuse(options)` (a shared
one); both return a `ServiceContainer` with `host`, `port`, bound `exec()` and
`cleanup()`. `start(options)` starts a container without a published port.
Explicit disposal of a reused container stops it for every caller. Engine
`database()` handles only drop their isolated database. MySQL handles provide
`query()`. Context's SQL Server tests wait for the context store's full-text
catalogs with `waitForFtsReady(connectionString)` from
`packages/context/test/sqlserver/wait-for-fts-ready.ts`.

ClickHouse uses a dedicated server so tests can create server-wide users, roles,
and functions without sharing them with another suite. Select the image explicitly:

```ts
import { ClickHouse } from '@zukhruf/testing/clickhouse';

const clickhouse = new ClickHouse({
  docker,
  image: 'clickhouse/clickhouse-server:25.8.28.1',
});
await using server = await clickhouse.start();
await server.exec(['clickhouse-client', '--query', 'SELECT 1']);
```

`start()` waits for a successful query and returns the existing `Container` handle
with `host`, `port`, `exec()` and disposal. It retains the 2 GiB memory limit.
Database schemas, users, grants and read-only settings belong to each test suite.

When a harness returns a resource to its caller, use native
`AsyncDisposableStack`: register dependencies with `use()` or `defer()`, then
transfer ownership with `move()` after initialization succeeds. Its
`disposeAsync()` releases resources in reverse order, even if one cleanup fails.
This avoids keeping an acquisition callback open with deferred promises.

When a test launches a separate `node --test` runner, clear `NODE_TEST_CONTEXT`
in the child's environment. Inheriting that worker marker makes Node treat the
new runner as recursive and skip its files. Assert that child tests actually
ran, as well as checking their exit code.

### Local and remote Docker tests

Nx Docker tests default to the `limerence-dokploy` context (Hetzner) when
`DOCKER_CONTEXT` is not set. Each Docker test project sets this default in its
`.env.test`, which Nx loads for the `test` target. A `DOCKER_CONTEXT` that is set
takes precedence. An empty `DOCKER_CONTEXT` does not: Nx fills an empty value from
`.env.test`. To use the endpoint in `DOCKER_HOST`, set `DOCKER_CONTEXT=default`, as
CI does. `DOCKER_HOST` takes precedence over the context. The default applies only
to these test targets; it does not change the Docker CLI's globally selected
context.

```sh
nx run @deepagents/context:test
# Use Docker Desktop for a run:
DOCKER_CONTEXT=desktop-linux nx run @deepagents/context:test
# Docker test projects run one at a time within this Nx invocation:
nx run-many -t test --projects=@deepagents/context,@deepagents/text2sql,@deepagents/experimental
```

For projects tagged `test:docker`, the `@zukhruf/nx/test` plugin adds
`--test-global-setup` with `@zukhruf/testing/docker-global-setup`, and
`--test-force-exit`. Setup resolves the selected Docker
context once, pins its Unix or SSH endpoint for the test processes, and
recovers resources left by exited runs on that endpoint.

These targets set `parallelism: false` and disable Nx test caching, so Nx runs
them exclusively within each invocation, locally and in CI. Other targets keep
their parallelism when no Docker test target runs. Within a project, Node runs
test files in parallel at its default concurrency, on a local engine and on an SSH
engine. On `limerence-dokploy` on 2026-10-30, the context tests passed in parallel
(1568 of 1568, 1 skipped) in 19.6 minutes, with no SSH error and at most 34 SSH
processes. With `--test-concurrency=1`, the same tests took more than 73 minutes.
To give a run other flags, pass them with the test selection in `--args`, and
start the value with a flag: `--args='--test-concurrency=2 "src/**/*.test.ts"
"test/**/*.test.ts"'`. Nx removes the first and the last quote of a value that
starts with a quote, so `--args='"src/**/*.test.ts" "test/**/*.test.ts"'` runs
no tests. Cases within a file run sequentially unless a test enables concurrency. These settings limit test scheduling; a single case
can still start multiple containers, and separate Nx invocations can overlap.
Other Node.js projects keep the standard Node.js test command.

`Docker`, `Postgres`, `Mysql`, and `SqlServer` support local Unix sockets and SSH
endpoints. Published test ports bind to the engine host's loopback interface.
For SSH, each handle exposes a local loopback port forwarded with OpenSSH.
Acquisition waits for SSH authentication and a private Unix-socket listener;
client streams share that connection instead of starting an SSH login per query
connection. The handle owns the SSH process and its temporary socket directory.
Use `handle.host`, `handle.port`, or `handle.connectionString`; do not construct
`localhost` URLs from a port returned by `docker port`. Forwarded ports belong
to the acquiring process and expire when its handle is disposed. SSH uses the
normal SSH configuration, agent, jump hosts, and host-key checks. It needs both
remote Docker access and permission to forward TCP connections.

`await using fixture = await docker.directory()` creates a fixture on the
Docker host. Pass `fixture.path` to a bind mount, then use `mkdir`, `writeFile`,
`readFile`, `chmod`, and `symlink` on the fixture. Build contexts, Dockerfiles,
and seccomp files read by the Docker CLI remain local. SQL Server image choices
and architecture-specific tests use `docker.info().architecture`.

Container helpers default to one CPU and 1 GiB RAM, SQL Server to 3 GiB, and
ClickHouse tests to 2 GiB. Database containers use private IPC. When testing
another container API, pass `docker.defaults` directly to that API. It
provides `resources` and the current run's ownership `labels`, so construct
`Docker` with `TestRun.fromEnvironment(process.env)`: without it, the labels are
empty and global teardown cannot identify resources left by a killed run.
Spread these defaults before explicit options; merge nested `resources` or
`labels` when overriding individual settings. Sandbox tests import their public
APIs directly.

Normal disposal closes SSH connections and removes owned containers with their
anonymous volumes. A killed test process does not dispose its handles. Global
teardown synchronously removes labeled disposable containers and their
anonymous volumes, labeled volumes, and recorded paths, including local SSH
sockets. Managed Docker sandbox volumes inherit the sandbox labels. Shared
database servers remain running until explicitly cleaned up. Images and build
caches also remain.

Each test process and each Docker or SSH command it starts has a process record.
A run keeps its records until every recorded process has exited. If cleanup
fails, for example because the host is unreachable, global teardown reports
the error, sets exit code 1, and retains the records under
`$XDG_STATE_HOME/zukhruf-testing/docker-runs/` (`~/.local/state` when unset).
The next run on that endpoint, from any project run by the same user, retries
cleanup once the previous runner and all recorded processes have exited.
Never delete these records to hide a cleanup failure.

An SSH forward closes when the process that opened it exits or is killed. The
forward runs `cat` in a remote shell, so the SSH user needs shell access on the
host.

GitHub CI explicitly uses the runner's Unix socket. It requires no personal
server or Hetzner secrets.
