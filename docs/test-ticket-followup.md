# Test fixture follow-up: 2204 and 2205

Both requested fixes are verified. Ticket 2189 remains fixed. The scope and
baseline were recorded before source edits, starting from commit `00fd4739`.

## Removed

- **2204:** five SQLite callback helpers and 105 callback acquisitions across
  four files under `packages/context/test/sqlite`: `benchmark.test.ts` (5),
  `stream-chunks.test.ts` (84), `concurrent-chat-metadata.integration.test.ts`
  (3), and `sqlite-context-engine.integration.test.ts` (13). Removed their
  temporary-directory/connection cleanup code and optional `close` casts.
  Tests now acquire the public `Sqlite.database()` handle with `await using`;
  additional native connections use `using`. Product setup stays local.
- **2205:** the assumption that a conflicting Docker name is immediately
  inspectable, and the consequent missing-container branch in the configuration
  guard. The existing `timebox` API now waits only for missing inspections;
  ownership and fingerprint validation remain outside that wait.

Evidence for each removal:

- SQLite baseline: 112 passed, one disk-image case skipped by the sandbox.
  After migration: the same 112 passed. The disk-full case passed separately
  with native macOS access, as did the simplified explicit-close regression.
  Thus all 113 distinct tests in the four files executed successfully.
  The cancellation/completion regression from **2189** passed before and after.
- An AST comparison preserved all 113 test names and all 295 assertion calls.
  Apart from formatting, the corruption assertion's callback only changed
  connection ownership. The explicit-close assertion still verifies the
  method exists and calls it twice. Separate-connection metadata updates,
  stream transitions/tailing, empty-file reopening, and corruption all passed.
- The old helper names are absent from package, tool, and CI source. The shared
  primitive's existing tests also passed, proving independent disposal,
  connection closure, and SQLite/WAL file cleanup on errors.
- A live 12-caller probe on Docker **29.8.0** reproduced the race in round one:
  name conflict at 45 ms, inspect 404 at 50 ms, successful creation at 748 ms.
  All 11 losing callers saw the gap. Moby's
  [create path](https://raw.githubusercontent.com/moby/moby/master/daemon/create.go)
  reserves identity through `newContainer` before registration in the
  inspectable store, consistent with the live observation.
- The original package suite passed 9/11: concurrent PostgreSQL acquisition
  and MySQL process sharing failed at the missing/configuration guard.
  The new public-API regression also failed before the fix and passed after.
  The complete package suite then passed **12/12**, including four server
  variants, process restarts, database isolation, configuration/ownership
  rejection, recovery after unfinished creation, and cleanup.
- Both `nx run @deepagents/test:typecheck` and
  `nx run @deepagents/context:typecheck` passed. Formatting and diff checks
  passed. Changed Docker files, benchmark, and metadata tests pass ESLint.

Verification logs: `sqlite-baseline`, `engine-baseline`, `sqlite-after`,
`test-baseline`, `acquisition-red`, `acquisition-green`,
`acquisition-final`, `test-after`, `special-cases`, `test-typecheck`, and
`context-typecheck`, each prefixed `/tmp/deepagents-ticket-` and suffixed `.log`.

## Net delta

Including the regression and this report: **2,459 added / 2,369 deleted**
(**+90 lines**). Production and test code alone is **20 lines smaller**; the net
addition is this evidence report. Reindentation accounts for most churn.

## Retained

- All four consumer files, product assertions, specialized disk-image helper,
  direct in-memory cases, and independent native connections. These express
  live test behavior. The disk-image helper is not generic database setup.
- The `Docker` class, public exports, naming/fingerprint rules, readiness probes,
  and ownership/configuration guards. Commit `00fd4739` explicitly requires
  cross-process sharing until explicit cleanup and isolated disposable databases.
- The new acquisition regression uses Node's official `mock.module`/`mock.fn`
  APIs to replay the real missing-inspection error around a real create
  conflict. Creation, startup, ports, execution, and disposal remain real.
  It also proves a different inspection error propagates after one attempt.
- Installed `nano-spawn` 2.1.0 exposes `SubprocessError` and subprocess options,
  but no coordination/retry or relevant environment/debug hook. Installed
  `p-retry` 8.0.0 exposes `shouldRetry` and `maxRetryTime`; its runtime preserves
  Error identity. The existing `timebox` supplies polling defaults, so this
  fix introduces none. Node's `DatabaseSync` and disposable APIs supply SQLite
  lifecycle ownership without new dependencies.
- Existing design documents and ticket history remain. This report preserves
  the findings; the spent scratch race script was deleted.
- Task containers and runners were cleaned up. Docker Desktop remains running:
  automatic approval review rejected stopping it because unrelated services use it.

## Rejected

- **REJECTED:** retrying arbitrary Docker errors or mismatched labels. Only
  the missing-inspection sentinel is retried; real failures stay visible.
- **REJECTED:** creating before every lookup, which changes reuse/image-pull
  behavior. Discovery still comes first.
- **REJECTED:** new dependencies, file locks, global caches, setup hooks,
  compatibility wrappers, or a custom retry loop. Existing public APIs suffice.
- **REJECTED:** changing product assertions, collapsing independent connections,
  or replacing disk-backed corruption/full-disk tests with in-memory fixtures.

## Unproven

No changed behavior remains unverified. Verification covers the test package
and the four affected context files, not the entire monorepo.

## Unresolved

No scoped implementation remains. Context ESLint still reports its existing
`require-yield` error in `AlwaysFailingChangeSource.subscribe`, tracked by
**1914** (also 496), plus existing warnings. Running ESLint on the original
HEAD file confirmed the same error. No suppression or unrelated fix was added.

Self-audit: no new dependency, API, fallback default, optional escape hatch,
static method, compatibility path, or lint suppression. The transient wait
uses the existing bounded polling defaults and retries only the observed gap.
