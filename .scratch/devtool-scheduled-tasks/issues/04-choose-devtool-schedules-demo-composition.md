# Choose the DevTool schedules demo composition

Type: grilling
Status: resolved
Blocked by: 02

## Question

What is the smallest public-boundary composition for the schedules demo that
installs the existing `schedules()` definition, its capabilities, the schedules
HTTP projection, the generic DevTool host, and a UI-managed task while proving
that DevTool remains usable and hides Scheduled navigation when the capability
is absent, without taking ownership of file-managed schedules?

## Answer

Status: resolved.

`demo/zukhruf-schedules` follows the same three-file shape as
[`demo/zukhruf-simple`](../../../demo/zukhruf-simple) and
[`demo/zukhruf-research-bot`](../../../demo/zukhruf-research-bot), the two
existing DevTool-hosted demos. There is exactly one composition; nothing is
duplicated between entry points.

- **`agent.ts`** — the declaration plus `export const scheduled = schedules(...)`,
  mirroring how research-bot exports `traceTelemetry` for its server to project.
- **`run.ts`** — runtime composition only: PGlite, pg-boss, stores, capability
  bindings, `resources.use(await runtime.work())`, then `export const resources`
  and `export default runtime`. No listener and no CLI modes.
- **`server.ts`** — `await using runtimeResources = resources`, the authenticated
  `userId` middleware, `http(runtime, schedulesHttp(scheduled))`, `devtool()`,
  the single listener, and the SIGINT wait.
- **`package.json`** — `"start": "node server.ts"`, matching every other demo.

`runtime.work()` calls `initialize()` itself, so the composition never calls it
separately.

**No `scheduleFiles()` source is installed, and `agent/schedules/` was removed.**
This is not stylistic. `syncScheduleFiles()` reasserts file authority on every
start: it `update()`s a task back to its file whenever any definition field
differs, `resume()`s a task the user paused, and throws
`Schedule declaration <file> is archived` so the process refuses to boot after a
browser archive. Because `server.ts` imports the one composition, keeping the
source would put those behaviours directly behind the management UI — silently
reverted edits and a demo that will not restart — which is exactly the
file-managed lifecycle policy this map puts out of scope. `scheduleFiles()`
keeps its coverage in
`packages/experimental/src/zukhruf/runtime/runtime.integration.test.ts`, and
`packages/experimental/README.md` now describes this demo as DevTool-managed.

Capability absence is proved by the same binary: `node server.ts --no-schedules`
mounts `http(runtime)` without the projection. Discovery then returns
`["history","chat"]`, `GET /zukhruf/v1/schedules/tasks` answers `404`, the
DevTool sidebar renders only `New Chat` and `History`, and the rest of the
DevTool stays usable.
