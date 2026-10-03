# Nx test lifecycle refactor — 2026-10-03

Status: the lifecycle refactor is implemented and verified. All ten changed Node
test targets were executed. The broad run found one unrelated SQLite stream-test
failure; concurrent work fixed it and a focused Nx rerun passed. The full context
suite was not repeated after that test-only change. All test containers were
removed. Docker Desktop remains open as requested. No commits were made.

## Scope and decisions

- Keep our Docker CLI helpers. No Testcontainers dependency or migration.
- Upgrade Nx and the nine existing root `@nx/*` dependencies from 23.1.0 to
  23.2.1. All six official migrations completed without additional source changes.
  The test package declares the matching `@nx/devkit` dependency for public types.
- Centralize the ten custom Node test targets through filtered `targetDefaults`.
  Common options include module mocks, reporters, and a 60-second timeout.
  Compaction/history retain their 10-second bounds. Context, experimental, and
  text2sql retain their existing force-exit option.
- Own shared servers per Nx invocation with `preTasksExecution` and
  `postTasksExecution`. Project tags declare engines; full SQL Server remains a
  separate requirement from platform-default SQL Server on Apple Silicon.
- Keep per-call database creation/drop. Missing provisioning and incompatible
  configurations fail explicitly; there is no implicit startup fallback.

## Removal inventory and proof

| Removal                                                                                            | Radius                                                                                                   | Observed proof                                                                                                                                                                                                                             |
| -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Duplicated Node commands                                                                           | agent, test, context, experimental, evals, text2sql, compaction, devtool/host, devtool/history, elements | All ten resolved targets have the shared Node command, cwd, and build dependency. All ten targets were executed; counts are below. The only failure reproduced with the previous runner, and its concurrent fix passed a focused Nx rerun. |
| `tools/src/run-node-tests.ts` spawn/report-directory wrapper                                       | The ten targets above; three historical command records                                                  | Direct Node reporting produced ten project-local JUnit files. CI now accepts both existing report directories and the new files. Historical records are retained as records of earlier execution.                                          |
| Explicit single-file selection                                                                     | compaction and devtool/history                                                                           | These projects each have one test file. Native discovery passed their 22 and 1 tests respectively.                                                                                                                                         |
| Per-project global setup modules                                                                   | context and experimental; experimental tsconfig include                                                  | Removed from commands and disk. Native hook probe passed across two parallel projects. Real PostgreSQL sharing and teardown passed, including overlapping invocations on one daemon.                                                       |
| Per-process promise maps, ID sets, exit hooks, lazy startup and environment default reconstruction | PostgreSQL, MySQL, SQL Server helpers                                                                    | Old implementation names grep to zero. Public missing-provisioning and explicit-startup-without-Docker assertions passed. Real PostgreSQL and MySQL sharing, isolation, database drop, and container cleanup passed.                       |

Observed checks:

- Baseline test-package test and typecheck passed before edits (typecheck used
  the existing cache). After edits, test-package typecheck executed and passed;
  its lint target and formatting checks passed.
- `nx run-many -t test -p @deepagents/agent,@deepagents/compaction,@deepagents/devtool-history,@deepagents/devtool,@deepagents/elements,@deepagents/evals --parallel=3`:
  160 passed, zero failed; required dependency builds passed.
- `nx run @deepagents/test:test --args='--test-name-pattern=provisioning'`:
  public fail-closed behavior plus real Nx build/untagged/exclusion selection.
- `nx run @deepagents/test:test`: all eight real lifecycle tests passed. Final
  test-package typecheck and lint executed successfully.
- `nx run-many -t test -p @deepagents/context,@deepagents/experimental,@deepagents/text2sql --parallel=1`:
  2,659 passed, one failed, one existing TODO. The sole failure was the unrelated
  stream test described below. All dependency builds completed; no cached test
  results were used. All containers created by the run were removed, including
  its shared PostgreSQL, SQL Edge, and full SQL Server instances.
- All ten other inferred test targets match the pre-refactor task graph exactly.
  Their test runners were not executed.
- An isolated TCP-server fixture proved one pre-hook, shared coordinates in two
  parallel task processes, and post-hook execution on success, task failure,
  SIGINT and SIGTERM. Interruptions were repeated on Nx 23.2.1 and exited 130.
  A separate daemon-enabled native probe also passed; its owned daemon was stopped.
  This proves the native hook lifecycle, not Docker cleanup in the new plugin.

| Executed targets                                 | Passed | Failed | TODO |
| ------------------------------------------------ | -----: | -----: | ---: |
| Six non-database Node targets listed above       |    160 |      0 |    0 |
| test                                             |      8 |      0 |    0 |
| context, initial full suite                      |  1,556 |      1 |    0 |
| experimental                                     |    400 |      0 |    1 |
| text2sql                                         |    703 |      0 |    0 |
| context, focused rerun after concurrent test fix |      1 |      0 |    0 |

Experimental's TODO is the existing pg-boss retention case already tracked in
backlog #682. It is not a new failure introduced by this refactor.

## Net delta

Excluding the lockfile and unrelated concurrent work: 892 lines added,
497 deleted. New files are included. The lockfile also contains concurrent AI SDK
release updates, so its combined delta is not attributed to this task.
Source/configuration/tests/documentation are net additive because the new
black-box lifecycle tests and this verification record exceed the production
code reduction. No new runtime container framework was added.

## Retained constraints and surfaces

- `start*Container`, `publish*Env`, standalone `*GlobalSetup`/`globalTeardown`,
  readiness checks, and full-text polling remain deliberately provided APIs.
  Tests calling explicit startup still own separate containers and disposal.
- PostgreSQL TCP readiness preserves the temporary-initialization-server fix in
  `ff3b06c5`. The sharing/per-database isolation constraint from `528cafa7` remains.
  Explicit startup still fails closed without Docker (`29425656`).
- Docker labels retain the invocation ID across Nx plugin-worker restarts. No
  in-memory ownership Map remains. A real concurrent-daemon test exposed that
  Nx unloads the worker after one post-hook, even while another invocation is
  running; label-based cleanup passed that same test.
- Original helper files and `global-setup.ts` remain. This report and
  `TEST_PRIMITIVES.md` describe the current contract. Temporary probe scripts are
  removed after recording their results.
- Unrelated release documentation, dependency updates, and the concurrent stream
  test fix were left intact and excluded from this task's line counts.

## Official APIs and rejected approaches

- Adopted Nx `targetDefaults.filter.projects`, public devkit hook/context types,
  hook environment propagation, and native CLI `--graph=<file>`.
- Pre-task context exposes argv but no task graph. Native `run`, `run-many`, and
  `affected` graph branches return before task execution/hooks. The plugin uses
  that official graph output instead of owning project-selection parsing.
- REJECTED stdout graph parsing: another plugin prints MDX messages before the
  JSON. Native file output needs no log stripping.
- REJECTED custom CLI selection parsing and Nx internal imports: native graph
  generation already handles selection and exclusions.
- REJECTED leader election, a file mutex, and a service process: native hooks
  already establish one owner per invocation.
- REJECTED deleting explicit startup/standalone setup exports for lack of local
  callers: they are deliberate APIs. No compatibility aliases were added.

## Self-audit

No new compatibility branch or suppressed diagnostic was introduced. Config
fields remain optional because callers request partial matching. Nx project
tags are optional in its public schema; projects without tags need no servers.
An absent registry is accepted only by the explicit publisher initializing a
standalone setup; consumers throw. The hook publishes a fresh complete registry
for every invocation, including an empty array for runs without databases.
Repeated standalone publication replaces matching engine/image/user/password
coordinates. Explicit startup's established defaults and probes were not changed.

## Database verification

The full test-package target passed 8/8 tests against real Docker:

- PostgreSQL: one server across two projects, four distinct databases, all
  databases dropped, configuration mismatch rejected, and container removal on
  success, task failure, SIGINT and SIGTERM.
- MySQL: standalone setup shared one server, supplied empty databases, dropped
  both databases, rejected a configuration mismatch, and removed the container.
- Concurrent daemon runs: finishing one invocation leaves the other's server
  alive; both are removed by their respective post-hooks.
- Builds and excluded/untagged test projects provision no server.

The first live run exposed inherited `NODE_TEST_CONTEXT` skipping child tests.
The fixture now clears that marker and checks an execution artifact, preventing
exit-code-only false positives. The test package now separates library and test
compilation like `packages/agent`, so integration tests import its public barrel.

## Concurrent failure and verification

Context's PostgreSQL and SQL Server suites passed, including the separate full
SQL Server image for full-text tests. Experimental and text2sql completed with
zero failures.

Context's SQLite stream cancellation test at
`packages/context/test/sqlite/stream-chunks.test.ts:1909` failed because
`source.close()` runs after cancellation has closed the reader. Its source and
the stream manager were unchanged from HEAD when the failure was reproduced. The
same focused test failed with the previous `tools/src/run-node-tests.ts` copied
from HEAD, independently of Nx hooks and shared database provisioning.

Concurrent work then replaced the invalid close with an assertion of source
cancellation and an explicit late completed-status attempt. A focused
`nx run @deepagents/context:test --excludeTaskDependencies` rerun passed (1/1).
The captured defect/internal backlog #2189 is now complete. This task did not
edit that test or the stream implementation; the complete context suite was not
repeated after the concurrent fix.

## Unproven and unresolved

Startup-failure cleanup is protected by an AsyncDisposableStack but has not been
fault-injected. Interruption proof covers running tasks, not the pre-hook startup
window. SIGKILL and machine failure cannot execute post-hooks.

No unanswered implementation decisions remain. Other inferred runners were
compared to the baseline graph but not executed. The full context report records
the original failure; the later focused passing result is recorded here.

## Docker and temporary resources

Opened Docker Desktop with user authorization. Removed unused Docker volumes
(5.698 GB reported), unused build cache (510.7 MB reported), a stopped Firebase
container and its image, and five unused sandbox images to recover disk space.
Existing running service containers were preserved. All test containers and
owned test runners exited; temporary fixtures and probe scripts were removed.
