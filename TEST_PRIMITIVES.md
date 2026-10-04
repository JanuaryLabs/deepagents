# Test Primitives

Tests target the repository's current Node.js version. Prefer these native
primitives before adding helpers or dependencies.

`@deepagents/test` is for domain-free test primitives. Repeated fixture data,
product-specific harnesses, and infrastructure compositions stay with their
tests.

| Need                     | Use                                         | Important behavior                                                                                       |
| ------------------------ | ------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Strict assertions        | `node:assert/strict`                        | Makes methods such as `equal` and `deepEqual` strict by default.                                         |
| Delay                    | `setTimeout` from `node:timers/promises`    | Alias it to `sleep`; it supports `AbortSignal` and avoids hand-written promises.                         |
| Retry an observation     | `TestContext.waitFor` from `node:test`      | The callback must throw or reject while waiting. Returning `false` counts as success.                    |
| Measure a deadline       | `performance.now()`                         | Monotonic elapsed time; do not use it as a timestamp or compare it across processes.                     |
| Temporary directory      | `mkdtempDisposable` from `node:fs/promises` | Use with `await using`; cleanup recursively removes the directory.                                       |
| Resource cleanup         | `using` / `await using`                     | Calls `Symbol.dispose` / `Symbol.asyncDispose` in reverse declaration order, including after errors.     |
| Deferred promise         | `Promise.withResolvers()`                   | Provides `{ promise, resolve, reject }` without capturing callbacks in a promise constructor.            |
| Disposable timeout       | `using timer = globalThis.setTimeout(...)`  | Node timers implement `Symbol.dispose`, which cancels the timer when its scope exits.                    |
| Wait for one event       | `once` from `node:events`                   | Register before triggering the event; it resolves with the emitted arguments.                            |
| Current module directory | `import.meta.dirname`                       | Replaces `fileURLToPath(import.meta.url)` plus `dirname` in Node ESM files.                              |
| Current Node executable  | `process.execPath`                          | Use when spawning another Node process instead of assuming `node` is on `PATH`.                          |
| Non-mutating sort        | `Array.prototype.toSorted()`                | Returns a shallow sorted copy; provide `(a, b) => a - b` for numbers.                                    |
| Bound promise settlement | `settleWithin` from `@deepagents/test`      | Rejects if a non-abortable promise does not settle in time; it does not cancel the underlying operation. |

## Established patterns

Use assertions inside `t.waitFor`; a boolean predicate stops immediately:

```ts
await t.waitFor(() => assert.equal(messages.length, 2), {
  interval: 20,
  timeout: 5_000,
});
```

Keep database polling explicit when a database error must fail immediately:

```ts
const deadline = performance.now() + 5_000;
while (performance.now() < deadline) {
  if ((await store.status()) === 'ready') break;
  await sleep(20);
}
```

Declare resources after their disposable parent so reverse-order cleanup closes
handles before deleting the directory:

```ts
await using directory = await mkdtempDisposable(join(tmpdir(), 'test-'));
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
import { StreamHarness } from '@deepagents/test';

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

## Databases

All database engines use instance acquisition and disposable handles. SQLite
owns a local file and native connection:

```ts
import { Sqlite } from '@deepagents/test';

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

DuckDB owns an in-memory instance and its native connection:

```ts
import { DuckDB } from '@deepagents/test';

const duckdb = new DuckDB();
await using database = await duckdb.database();
await database.connection.run('CREATE TABLE records (id INTEGER)');
```

Each `DuckDB.database()` call creates an independent database without Docker or
global setup. The handle exposes the native `DuckDBConnection` and bound
`cleanup()`. Disposal closes the connection before the instance, including on
failure. SQL fixtures and product adapter wiring stay in their own tests.

### Database servers

Node test projects declare `test:node` and a `test` target. `nx.json` owns their
common command, reporters, module mocks, timeout, and build dependency. JUnit
reports are written to each project's `test-results.xml`.

For PostgreSQL, MySQL, and SQL Server, create an engine instance and acquire a
disposable database for each test:

```ts
import { Postgres } from '@deepagents/test';

const postgres = new Postgres();

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
docker ps -a --filter label=dev.deepagents.test.shared=1
docker stop <container-id> [<container-id> ...]
```

These containers use Docker's `--rm` option, so stopping also removes them.
Do not clean up a server while other tests are using it. The next acquisition
creates a replacement. Image tags are part of the configuration; explicitly
clean up to pick up a newer image behind the same tag.

Use `nx run <project>:test --args="path/to/file.test.ts"` for a focused test.
`await using server = await postgres.start()` creates a dedicated container;
disposing that handle stops its container. For other services, use a `Docker`
instance's `start(options)` or `reuse(options)` methods. Both return a
`Container` with bound `exec()` and `cleanup()` operations. Explicit disposal of
a reused container stops it for every caller. Engine `database()` handles only
drop their isolated database. MySQL handles provide `query()`; SQL Server handles
provide `waitForFtsReady()` for context-store catalogs.

ClickHouse uses a dedicated server so tests can create server-wide users, roles,
and functions without sharing them with another suite. Select the image explicitly:

```ts
import { ClickHouse } from '@deepagents/test';

const clickhouse = new ClickHouse({
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

The same tests use the Docker CLI's selected endpoint. For example:

```sh
DOCKER_CONTEXT=limerence-dokploy nx run @deepagents/context:test
# Keep project execution serial on a shared remote server:
DOCKER_CONTEXT=limerence-dokploy nx run-many -t test --projects=@deepagents/test,@deepagents/context,@deepagents/text2sql,@deepagents/experimental --parallel=1
```

Projects tagged `test:docker` use `tools/src/run-docker-tests.ts`. It pins the
endpoint for the run and disables Nx test caching. SSH endpoints default to one
test file at a time; an explicit `--test-concurrency` overrides that limit.
Other Node projects keep the standard Node test command.

`Docker`, `Postgres`, `Mysql`, and `SqlServer` support local Unix sockets and SSH
endpoints. Published test ports bind to the engine host's loopback interface.
For SSH, each handle exposes a local loopback port forwarded with OpenSSH.
Use `handle.host`, `handle.port`, or `handle.connectionString`; do not construct
`localhost` URLs from a port returned by `docker port`. Forwarded ports belong
to the acquiring process and expire when its handle is disposed. SSH uses the
normal SSH configuration, agent, jump hosts, and host-key checks. It needs both
remote Docker access and permission to forward TCP connections.

`await using fixture = await new Docker().directory()` creates a fixture on the
Docker host. Pass `fixture.path` to a bind mount, then use `mkdir`, `writeFile`,
`readFile`, `chmod`, and `symlink` on the fixture. Build contexts, Dockerfiles,
and seccomp files read by the Docker CLI remain local. SQL Server image choices
and architecture-specific tests use `Docker.info().architecture`.

Container helpers default to one CPU and 1 GiB RAM, SQL Server to 3 GiB, and
ClickHouse tests to 2 GiB. Database containers use private IPC. When testing
another container API, pass `new Docker().defaults` directly to that API. It
provides `resources` and the current run's ownership `labels`. Spread these
defaults before explicit options; merge nested `resources` or `labels` when
overriding individual settings. Sandbox tests import their public APIs directly.

Normal disposal closes SSH connections and removes owned resources. The Nx
supervisor also cleans labeled disposable containers, labeled volumes, and
recorded directories after failures, timeouts, and interruption. Managed Docker
sandbox volumes inherit the sandbox labels. Shared database servers remain
running under the existing explicit-cleanup contract; images and build caches
also remain. If the host is unreachable, cleanup reports the ownership record
under `.nx/docker-test-runs/`. The next run on that endpoint retries cleanup
once the recorded processes have exited. Never delete those records to hide a
cleanup failure. A forcibly killed supervisor may require the surviving test
process to exit before recovery can run.

GitHub CI explicitly uses the runner's Unix socket. It requires no personal
server or Hetzner secrets.
