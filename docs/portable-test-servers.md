# Portable shared test servers — 2026-10-03

Historical implementation report. The persistent lifecycle below is retained;
the function API has since been replaced by instance classes. See
[the class refactor report](./test-server-classes.md) and
[Test Primitives](../TEST_PRIMITIVES.md) for the current API.

The test package acquires persistent shared Docker servers itself. The
user approved keeping servers alive until explicit cleanup. Per-call database
creation/drop remains the isolation boundary; no Testcontainers migration is
involved. Cleanup instructions are in [Test Primitives](../TEST_PRIMITIVES.md).

## Removed and proof

| Removed surface                                                           | Consumers measured before editing                                                                       | Behavioral observation                                                                                                                                                     |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Nx pre/post task plugin and its invocation-owned teardown                 | One registration in `nx.json`; `packages/test/src/nx-plugin.ts`; its integration test file              | Independent Node processes acquire the same server without Nx or setup. Servers survive process exit and explicit stop allows recreation.                                  |
| Database requirement tags                                                 | `packages/context/project.json`, `packages/experimental/project.json`, `packages/text2sql/project.json` | Representative database suites executed in all three projects with no provisioning plugin.                                                                                 |
| Global setup, environment registry, publishing APIs and override branches | Three database helper callers, one barrel export, and the setup-only MySQL test                         | All three helpers previously failed on malformed legacy registry data; after removal, the integration suite runs with that same malformed value inherited by every worker. |
| Test package dependency on `@nx/devkit`                                   | `packages/test/package.json` and its workspace entry in `package-lock.json`                             | Package build, typecheck, lint and tests run without the plugin import. Root Nx dependencies remain for the workspace.                                                     |
| Provisioning-only assertions and current lifecycle instructions           | `container.integration.test.ts`, `AGENTS.md`, `TEST_PRIMITIVES.md`                                      | Unavailable Docker still fails explicitly. Historical Nx report is marked superseded rather than rewritten.                                                                |

Searches for the removed plugin, database tags, strict `requireServer` lookup,
and Nx ownership label return no matches in active source/configuration/docs.
The historical report retains its original evidence. There are 21 consuming
test files outside the test package; six representative files were executed.
The built public API was also checked: all seven obsolete setup/publishing
exports are absent. Source and generated output contain no registry references.

## Net delta

Final scoped line counts: 823 added, 768 deleted (55 net), including new files.
Generic persistent acquisition replaces Nx orchestration and the complete
global-setup path. The public start APIs still create explicitly owned containers;
they cannot inject a second lifecycle into the shared database helpers.
Runtime source shrinks by 155 lines; the overall count includes tests and docs.

## Native capabilities and retained surface

Docker `create --name` reserves a unique name; concurrent losers inspect and
attach to the winner. Docker `start` handles a container reserved by a creator
that exited before starting it. `inspect`, `port`, labels, `--rm`, and explicit
`stop` provide discovery, coordinates, identification, and cleanup. No lock
library, coordinator process, lease timer, or reference count was added.

The similar named-container acquisition in
`packages/context/src/lib/sandbox/container-sandbox.ts` informed discovery.
Its sandbox-specific disposal is unsuitable for shared test-server lifetime.
The installed `nano-spawn` public export supplies `SubprocessError`; only an
actual missing-container error means absence, and only a name conflict triggers
attachment after failed creation. Other Docker errors propagate. No relevant
native automatic reuse option or debug hook was found in the subprocess API.

Retained deliberately:

- The three `with*Container` APIs, engine configuration, isolated databases,
  callback cleanup, and their source files. Docker readiness is still required.
- TCP PostgreSQL readiness from commit `ff3b06c5`: the image's temporary Unix
  socket server must never count as ready. Explicit database selection also
  permits a configured PostgreSQL user whose name is not a database name.
- Public `start*Container`: callers can explicitly own a container and dispose
  it. The database helpers always acquire their shared server directly.
- Shared Nx Node test defaults, build ordering, reporters, timeout overrides,
  module mocks, and the Nx upgrade. Only database ownership moved out of Nx.
- Best-effort idempotent disposal, engine defaults, image selection, FTS helper,
  and the Docker availability memo. None coordinates automatic server sharing.
- The new integration tests and this report retain the behavioral evidence.
  No throwaway probe script is retained.

REJECTED: Testcontainers (outside the user's chosen direction); filesystem locks,
leader-election services, and a dedicated broker (Docker already reserves the
name); idle shutdown and automatic last-user cleanup (contradict the approved
persistent lifetime); keeping global setup as an optional compatibility path
(contradicts the user's requested removal).

## Verification

- Baseline: existing provisioning-focused Nx tests passed, then the new portable
  PostgreSQL test failed at the mandatory registry lookup before production edits.
- Test package: **7 passed**, plus Nx typecheck and lint. Includes PostgreSQL, MySQL, Azure SQL
  Edge and full SQL Server. Checks cover concurrent independent processes, unique
  databases, callback failure, later process reuse, and recreation after stop.
- Generic acquisition: dictionary key order, credential separation, readiness
  failure without shared-server teardown, unrelated name collision, recovery from
  created-but-not-started state, and owned-startup failure cleanup.
- One rerun exposed a cleanup assertion that expected immediate Docker removal.
  [Docker stop waits for exit](https://github.com/moby/moby/blob/master/daemon/stop.go),
  while [automatic removal follows the exit-state update](https://github.com/moby/moby/blob/master/daemon/monitor.go).
  Cleanup assertions now use native `TestContext.waitFor` with a five-second
  limit; no production retry or compatibility branch was added.
- Explicit ownership: SQL Server startup with a requested database and async
  disposal. The setup-only MySQL test was deleted with its obsolete API.
- Earlier consumer verification, before the final registry deletion:
  Context PostgreSQL and SQL Server delete-chat suites plus SQL Server FTS:
  **50 passed**.
- Experimental PostgreSQL/PGlite queue contract and scheduler regressions:
  **39 passed**.
- Text-to-SQL: PostgreSQL and SQL Server filesystem integration suites:
  **120 passed**.
- Direct `node --test --no-warnings --test-timeout=300000 --test-name-pattern=^postgres packages/test/src/shared-servers.integration.test.ts`:
  **1 passed**, including concurrent child processes with a custom PostgreSQL user.

Final package check uses the same Nx targets with a malformed legacy registry
value in the environment. Before deletion, each helper threw a JSON parse error;
after deletion the value has no consumer.
Consumer checks used these Nx targets (each with `--skip-nx-cache`):

```sh
nx run @deepagents/context:test --args='test/postgres/delete-chat.test.ts test/sqlserver/delete-chat.test.ts test/sqlserver/fts.test.ts'
nx run @deepagents/experimental:test --args='src/zukhruf/queue/pg-boss.turn-queue.contract.test.ts'
nx run @deepagents/text2sql:test --args='test/fs/postgres-fs.integration.test.ts test/fs/mssql-fs.integration.test.ts'
```

The consumer suites were not repeated after deleting the registry; the complete
test-package suite was rerun. No monorepo-wide passing claim is made.

## Self-audit and limits

Optional environment, labels, name, mounts, and readiness already belong to the
public options contract. Empty collections normalize absent caller inputs for
identity; they do not replace missing Docker response fields. A generated name
is required when a caller supplies none. The entire registry and its fallback
branches are gone. No compatibility shim or suppression remains for global setup.

Unproven: the other 15 consumer test files, the complete monorepo suite, and
non-macOS Docker hosts were not executed in this pass. Daemon/machine crashes and
cleanup racing active tests are not coordinated. Abrupt termination may leave
an isolated database behind until explicit server cleanup. Mutable image tags
require cleanup before an existing shared server picks up a new image.

Unresolved decisions: none. Persistent lifetime was approved before editing.

All verification containers were explicitly removed after the tests. The two
pre-existing Docker services were preserved, and no owned test runner remains.
Changes are uncommitted; unrelated release work was preserved.
