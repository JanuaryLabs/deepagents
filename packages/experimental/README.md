# @deepagents/experimental

A home for unstable, in-progress building blocks that are not yet part of the
stable `@deepagents/*` surface. APIs here may change without notice.

## `@deepagents/experimental/coding-agent-reminders`

`coding-agent-reminders` is an experimental event-aware reminder and guard
framework for coding agents. It provides Claude Code hook types, predicates,
context normalization, command I/O, and rule evaluation without prescribing a
reminder catalog. See
[`src/coding-agent-reminders/README.md`](./src/coding-agent-reminders/README.md)
for the public API and lifecycle mapping.

## `@deepagents/experimental/zukhruf`

Zukhruf is an internal DSL for **declaring** an agent, plus a **runtime** that
executes that declaration as a **durable background agent** — built on
`@deepagents/context` primitives (`agent()`, `ContextEngine`, `AgentSandbox`,
fragments, the stream subsystem).

```ts
import {
  AgentRuntime,
  PgBossTurnQueue,
  defineAgent,
  renderTurn,
} from '@deepagents/experimental/zukhruf';
```

The public experimental surface contains the pure declaration layer
(`defineAgent` / `defineInstructions` / `defineTool` / `defineSandbox`),
`AgentRuntime`, typed runtime plugins, the domain values, and the store/queue
ports and adapters. The optional Hono transport plugin is a separate
`@deepagents/experimental/zukhruf/http` entry point.
Declarations have a types-only dependency on `@deepagents/context`.
`AgentRuntime` exposes enqueue, host mailbox delivery, observation, approval,
denial, worker lifecycle, and model-facing collaboration for declared
subagents. Its control plane, executor, status projector, mailbox coordinator,
and injected collaboration-tool implementations are internal wiring. See
[`src/zukhruf/DESIGN.md`](./src/zukhruf/DESIGN.md) for the decided semantics,
[`TODO.md`](./src/zukhruf/TODO.md) for the convergence plan, and
[`BUGS.md`](./src/zukhruf/BUGS.md) for known residue.

Zukhruf discovers immediate `skills/<name>/SKILL.md` children from each
configured sandbox once per conversation. It persists only the ordered catalog
(`name`, `description`, and model-visible `path`) in chat metadata so later turns
and process restarts reconstruct the same prompt fragment without rediscovery.
Skill bodies, scripts, references, and assets remain in the sandbox. Providers
may preinstall or mount them, or opt into the existing `uploadDirectory` support
when creating the sandbox.

`http(runtime, ...projections)` returns the HTTP session protocol for a host to
mount at its chosen path: create or continue sessions with idempotent `POST`
calls, receive the durable `turnId`, check or cancel a specific turn, cancel the
active session turn, stream durable UI-message output, and read runtime info
plus health checks. `GET /info` advertises mount-relative
`capabilities.history.href` and `capabilities.chat.href`. Runtime plugin
definitions return typed transport-neutral instances. Transport packages bind
those exact installed instances explicitly: `projectHttp(definition, project)`
produces HTTP-owned `publicRoutes`, `authenticatedRoutes`, and discovery
entries, while a future gRPC package can project the same plugin instance into
services and streaming without changing core. The HTTP transport plugin rejects
duplicate capability names and relative paths.
Plugins may also contribute one AI SDK telemetry integration per turn through
`telemetry(context)`; the runtime applies every contribution with the agent's
declaration-local telemetry policy.

The `schedules` runtime plugin owns durable task and run persistence,
recurrence, workers, management, and execution into either new or existing
conversations. It accepts five-field cron expressions or RRULE recurrences with
IANA timezones. Its optional `scheduleFiles` source makes top-level
`agent/schedules/*.md` files a startup source of truth. A file contains strict
YAML frontmatter and uses its Markdown body as the prompt:

```md
---
name: Monday report
cron: '0 9 * * 1'
timezone: Asia/Amman
---

Prepare the weekly engineering report.
```

```ts
const scheduled = schedules({
  queue: 'scheduled-tasks',
  reconciliationIntervalMs: 5_000,
  sources: [
    scheduleFiles({
      directory: new URL('./agent/schedules/', import.meta.url),
      ownerId,
    }),
  ],
});

const root = defineAgent({
  // model, sandbox, instructions, ...
  plugins: [scheduled],
});

const runtime = new AgentRuntime(root, {
  store,
  streams,
  queue,
  mailboxStore,
  bindings: [
    schedulesCapabilities.boss.bind(boss),
    schedulesCapabilities.transaction.bind(transaction),
  ],
});

await runtime.initialize();
const scheduleControl = runtime.plugin(scheduled);
await using worker = await runtime.work();
```

Synchronization creates or updates present declarations, resumes present tasks
that were paused by an earlier synchronization, and pauses removed files while
preserving their run history. An explicitly archived task is never restored by
the filesystem.

The optional `@deepagents/experimental/zukhruf/uploads` plugin stores
composer uploads (PNG, JPEG, WebP, GIF, HEIC/HEIF, MP4, QuickTime, MP3, M4A,
WAV) in the conversation sandbox under a host-selected absolute directory.
Compose `@deepagents/experimental/zukhruf/uploads/http` with
`http(runtime, ...)` when the browser should upload bytes: the `GET` route
serves them with byte ranges so media elements can seek, discovery advertises
the accepted `mediaTypes`, and the model receives a turn-local reminder with
the sandbox paths to read. Every agent in the tree also gets a
`publish_upload` tool that adopts a file it produced below the session's
uploads directory and returns the link the user can open; pass `publicUrl`
(the absolute mount of `http()`) so that link is absolute.

Runnable end-to-end showcases live in
[`demo/zukhruf-simple`](../../demo/zukhruf-simple) (the smallest complete
deployable unit),
[`demo/zukhruf-durable-turns`](../../demo/zukhruf-durable-turns) (the durable
executor: enqueue, detach, resume, strict per-chat FIFO),
[`demo/zukhruf-research-bot`](../../demo/zukhruf-research-bot) (durable
planner and researcher chats with mailbox-delivered findings),
[`demo/zukhruf-schedules`](../../demo/zukhruf-schedules) (recurring work
managed from the DevTool and launched into fresh root tasks),
[`demo/zukhruf-group-chat`](../../demo/zukhruf-group-chat) (managed group-chat
orchestration over a shared transcript),
[`demo/zukhruf-whatsapp`](../../demo/zukhruf-whatsapp) (manager-free group
notifications where specialists volunteer public replies),
[`demo/zukhruf-dynamic-subagents`](../../demo/zukhruf-dynamic-subagents)
(a code-defined root, plugin-contributed Markdown subagents, and a mounted
skill discovered at startup).
Every `spawn_agent` call chooses all parent turns, no parent turns, or a bounded
number of recent user-turn boundaries through its required `fork_turns` input.
Collaboration tools stay on the direct model surface by default; set
`multiAgent.nonCodeModeOnly: false` to expose them through AI SDK code mode
instead.
