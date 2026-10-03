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

## Database servers and Nx

Node test projects declare `test:node` and a `test` target. `nx.json` owns their
common command, reporters, module mocks, timeout, and build dependency. JUnit
reports are written to each project's `test-results.xml`.

Add `test:postgres`, `test:mysql`, `test:sqlserver`, or `test:sqlserver-full` to a
project's tags when its tests use the corresponding `with*Container` helper.
Nx's pre-task hook starts one server for each required engine/image across the
selected test projects. It uses Nx's native task graph, including `run-many`
selection and `affected` exclusions. Builds and projects without database tags
provision no servers. Selection is per project, including when filtering files.

Each helper call creates a fresh database and drops it in `finally`. Test
processes receive server coordinates through the environment; they never start
an implicit fallback container. Missing provisioning or incompatible options
fail explicitly. The post-task hook stops the servers after all tasks finish,
including task failure, SIGINT, and SIGTERM. SIGKILL or a machine crash cannot
run teardown. Separate Nx invocations own separate servers.

Ownership is stored in Docker's `dev.deepagents.test.nx-run` label. Cleanup
does not depend on plugin memory: Nx can unload a plugin worker after one
invocation finishes while another invocation still has running tasks.

Use `nx run <project>:test --args="path/to/file.test.ts"` for a focused test.
Explicit `start*Container()` APIs remain for tests of container startup itself;
the caller owns disposal. The exported `*GlobalSetup` / `globalTeardown` helpers
remain available for a standalone Node runner, with ownership limited to that
runner invocation. Nx projects do not use those per-project setup files.

When a test launches a separate `node --test` runner, clear `NODE_TEST_CONTEXT`
in the child's environment. Inheriting that worker marker makes Node treat the
new runner as recursive and skip its files. Assert that child tests actually
ran, as well as checking their exit code.
