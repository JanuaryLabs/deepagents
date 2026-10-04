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

### Database servers

Node test projects declare `test:node` and a `test` target. `nx.json` owns their
common command, reporters, module mocks, timeout, and build dependency. JUnit
reports are written to each project's `test-results.xml`.

Create an engine instance and acquire a disposable database for each test:

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

When a harness returns a resource to its caller, use native
`AsyncDisposableStack`: register dependencies with `use()` or `defer()`, then
transfer ownership with `move()` after initialization succeeds. Its
`disposeAsync()` releases resources in reverse order, even if one cleanup fails.
This avoids keeping an acquisition callback open with deferred promises.

When a test launches a separate `node --test` runner, clear `NODE_TEST_CONTEXT`
in the child's environment. Inheriting that worker marker makes Node treat the
new runner as recursive and skip its files. Assert that child tests actually
ran, as well as checking their exit code.
