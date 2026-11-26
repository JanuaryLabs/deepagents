# @deepagents/experimental

A home for unstable, in-progress building blocks that are not yet part of the
stable `@deepagents/*` surface. APIs here may change without notice.

## `@deepagents/experimental/providers/codex`

`codex('gpt-5.5')` creates an AI SDK model using an existing ChatGPT login from
`codex login`. Apps that own user accounts can use `createCodexAccounts()` for
per-user ChatGPT device sign-in instead. Zukhruf continues to own tools, history,
and turn execution. See the
[provider API and credential behavior](./src/providers/codex/README.md).

## `@deepagents/experimental/providers/claude`

`claude('claude-sonnet-4-6')` creates an AI SDK model using the existing Claude Code
login. Apps that own user accounts can use `createClaudeAccounts()` for per-user
Claude Pro or Max PKCE sign-in instead. It follows the same provider protocol
while Zukhruf owns task execution. See the
[provider API and credential behavior](./src/providers/claude/README.md).

## `@deepagents/experimental/coding-agent-reminders`

`coding-agent-reminders` is an experimental event-aware reminder and guard
framework for coding agents. It provides Claude Code hook types, predicates,
context normalization, command I/O, and rule evaluation without prescribing a
reminder catalog. See
[`src/coding-agent-reminders/README.md`](./src/coding-agent-reminders/README.md)
for the public API and lifecycle mapping.

## `@deepagents/experimental/zukhruf`

Zukhruf provides a declaration API and a runtime for durable background agents,
built on `@deepagents/context` primitives (`agent()`, `ContextEngine`, `AgentSandbox`,
fragments, the stream subsystem).

```ts
import {
  AgentRuntime,
  PgBossTurnQueue,
  defineAgent,
  defineStack,
} from '@deepagents/experimental/zukhruf';
```

The public experimental surface contains the pure declaration layer
(`defineAgent` / `defineInstructions` / `defineTool` / `defineSandbox`),
`AgentRuntime`, typed runtime plugins, the domain values, and the store/queue
ports and adapters. The optional Hono transport plugin is a separate
`@deepagents/experimental/zukhruf/http` entry point.
Declarations have a types-only dependency on `@deepagents/context`.

`defineAgent()` accepts native AI SDK `reasoning`, `maxOutputTokens`,
`timeout`, `toolCallConcurrency`, `toolApproval`, and
`experimental_toolApprovalSecret` settings. The runtime forwards them to each
turn without adding defaults. If you configure a signing secret, reuse it
across workers and restarts that resume the same approval. A `toolApproval`
map overrides `needsApproval` for the listed tools; unlisted tools keep their
own rules. A callback controls every tool call, including tools added by the
runtime. The runtime stores approvals and resumes turns after a decision.

`defineAgent()` also accepts the AI SDK's `stopWhen`: one condition or an array
of conditions imported from `ai`. For example,
`[hasToolCall('notify'), isStepCount(6)]` stops after a step calls `notify` or
after six completed steps, whichever happens first. A step can execute several
tool calls before the condition is checked. The default is `isStepCount(200)`,
inherited from `agent()` in `@deepagents/context`.

If the provider interrupts a response, the runtime retains partial output
and marks the turn `failed` without automatically retrying it. Compaction
keeps the input token and prompt cache measurements from the last successful
step.

If a response ends midway through a tool's arguments, chat persistence records
that call as `output-error` with the message
`Tool input ended before the call was complete.` The incomplete call does not
execute or leave the conversation waiting for client input, so the next queued
user turn can proceed.

The `AgentHost` returned by `AgentRuntime.initialize()` exposes enqueue, host
mailbox delivery, observation, approval, denial, worker lifecycle,
model-facing collaboration for declared subagents, and session deletion and
archiving (`deleteSession`, `archiveSession`, `unarchiveSession`, and
`listHistory(userId, { archived })`). Its control plane, executor,
status projector, mailbox coordinator,
and injected collaboration-tool implementations are internal wiring. See
[`src/zukhruf/DESIGN.md`](./src/zukhruf/DESIGN.md) for the decided semantics,
[`TODO.md`](./src/zukhruf/TODO.md) for the convergence plan, and
[`BUGS.md`](./src/zukhruf/BUGS.md) for known residue.

Compose infrastructure in a reusable `defineStack(async (resources) => ...)`
recipe returning `{ storage }`, plus any plugin `bindings` or host options.
`storage` is an `AgentStorage`: the context store, stream manager, turn queue
and mailbox store on one database, the wakes of the sandbox idle stop on their
own queue beside the turn queue, one queue per settle follow-up (the idle
stop's arm and each plugin's `conversationAvailable`, recorded before the turn
queue releases a settled turn), and `admit(tree, work)`, which runs `work`
with all four bound to one unit under a per-tree lock. On PostgreSQL,
`PostgresAgentStorage.create({ pool, boss })` builds the stores on the host's
pool and the turn queue on PgBoss, refuses a PgBoss on another database with
`AgentStorageDatabaseMismatchError`, and admits in one transaction under a
per-tree advisory lock. It borrows the pool and PgBoss; register it with
`resources.use()` so the host closes the stream change source it opened.
For one process, `EmbeddedAgentStorage.open({ directory })` keeps the stores in
`<directory>/zukhruf.sqlite` and pg-boss on PGlite in `<directory>/zukhruf.queue`,
and closes both. Its admissions run one at a time in one SQLite `BEGIN
IMMEDIATE` transaction; a turn pushed inside one is an outbox row of that
transaction, which a relay pushes to pg-boss after the commit, and `open`
pushes the rows a killed process left. Work inside `admit` uses its scope: a
call to the storage itself there rejects with `AdmissionScopeError`. The
callback receives JavaScript's native `AsyncDisposableStack`: use
`resources.use()` for disposable adapters and `resources.adopt()` for adapters
exposing a cleanup method. Backend choices and startup calls stay explicit.

```ts
const stack = defineStack(async (resources) => ({
  storage: resources.use(await PostgresAgentStorage.create({ pool, boss })),
  multiAgent: Team.codex({ maxConcurrentThreads: 4 }),
}));
```

`multiAgent` takes a `Team`, the collaboration tools and guidance every agent
of the tree gets; omitted, it is `Team.codex()`, all six tools.

Multi-agent mode: every turn of the root and of each subagent ends its system
prompt with Codex's `<multi_agent_mode>` message, apart from the guidance, so a
`guidance` rewrite never removes it. `multiAgentMode: 'explicitRequestOnly'`
(the default) spawns only when the user, AGENTS.md or a skill asks for it;
`'proactive'` delegates whenever parallel work could save time or improve
quality.

```ts
multiAgent: Team.codex({ multiAgentMode: 'proactive' }),
```

Direct messaging: a team without `DirectMessaging` has no `send_message` or
`followup_task`, and its guidance does not mention them. Agents still spawn,
wait, and get each child's final answer, as with Codex's
`disable_direct_message`.

```ts
multiAgent: new Team(new Spawning()).with(new Supervision()).with(new Waiting()),
```

```ts
import declaration from './agent.ts';
import stack from './stack.ts';

const runtime = new AgentRuntime(declaration);
await using host = await runtime.initialize(stack);
await using worker = await host.work();
```

Importing the recipe or constructing the runtime opens nothing.
`runtime.initialize(stack)` opens and validates one stack, then returns the
ready host without starting workers. `info`, `plugin()`, `observe()`, and HTTP
plugin projection are available on that host. Host disposal waits for startup,
drains active queue and plugin workers, closes plugins, then releases the
registered adapters in reverse order. Startup failures roll back resources.
Stopping a worker alone keeps its host and adapters available.

Every host initializes from a `defineStack` recipe. A recipe can return shared
adapters without registering them with `resources`; those adapters remain
caller-owned. Host and worker disposal always wait for active work. Only
registered adapters are released by host disposal.

An agent's `sandbox` is `defineSandbox(environment, options)`, where
`environment` is a `@deepagents/context` sandbox environment that gives each
chat its own sandbox (see
[one-off and chat sandboxes](https://januarylabs.github.io/deepagents/docs/context/sandbox#one-off-and-chat-sandboxes)).
An environment that can stop its sandboxes (Docker, Apple container,
microsandbox) requires `idleTimeoutMs`: the runtime stops a chat's sandbox,
keeping its files, once the chat has been idle that many milliseconds, and the
next turn starts it again. `0` stops it as soon as the chat is idle and `false`
never stops it while the chat is idle; there is no default. Archiving a session
stops its sandboxes at once, whatever their `idleTimeoutMs`. The virtual and
Daytona environments take no `idleTimeoutMs`.

```ts
import { DockerSandboxEnvironment } from '@deepagents/context';
import { defineSandbox } from '@deepagents/experimental/zukhruf';

const sandbox = defineSandbox(
  new DockerSandboxEnvironment({ namespace: 'analytics', image: 'node:lts' }),
  { idleTimeoutMs: 10 * 60_000 },
);
```

A chat waiting on an approval is not idle, so its sandbox keeps running, and
each sub-agent's sandbox stops on its own declaration's idle time. See the
sandbox idle stop in [`src/zukhruf/DESIGN.md`](./src/zukhruf/DESIGN.md).

The host lazily acquires one sandbox handle per agent declaration and
conversation from the agent's `sandbox` declaration. Later turns and plugins
borrow the same handle; they must leave disposal to the host. A failed
acquisition is retried on the next request. Host disposal closes the held
handles after its workers stop; closing a handle never stops or removes the
chat's sandbox.

`host.deleteSession(conversation)` deletes a session and every sub-agent chat
under it: it stops their turns, waiting at most 10 s for a running one, removes
each sandbox through its environment's `delete`, then their mail, streams and
chats, and refuses the session's id from then on, for every user. Data the
host keeps per conversation (a volume, an object-storage prefix) is the host's
to remove: the stack's `conversationDataCleanup` gets every deleted
conversation once their sandboxes are gone, and its rejection aborts the
delete, which a second call finishes.
`host.archiveSession(conversation)` hides a session from `listHistory`,
refuses its new turns, scheduled ones included, and stops its sandboxes;
`host.unarchiveSession(conversation)` brings it back and runs the turns that
were queued. See session delete and archive in
[`src/zukhruf/DESIGN.md`](./src/zukhruf/DESIGN.md).

```ts
const stack = defineStack(async (resources) => ({
  storage: resources.use(await PostgresAgentStorage.create({ pool, boss })),
  conversationDataCleanup: async (conversations) => {
    for (const { chatId } of conversations) await removeChatVolume(chatId);
  },
}));
```

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
plus health checks. `DELETE /session/:sessionId` deletes a session (204),
`POST /session/:sessionId/archive` archives it (204), and
`POST /session/:sessionId/unarchive` answers 200 with its history item.
`GET /history` lists the sessions that are not archived, and
`GET /history?archived=true` the archived ones. `GET /events` tells the owner
of each session and sub-agent chat that was deleted, archived or unarchived
with `{ type: 'change', resource: 'conversation', id, lifecycle }`, where
`lifecycle` is `deleted`, `archived` or `unarchived`. `GET /info` advertises mount-relative
`capabilities.history.href` and `capabilities.chat.href`. A runtime plugin's
`initialize(host)` returns its typed transport-neutral running phase, which
`host.plugin(definition)` returns. Transport packages bind those exact running
phases explicitly: `projectHttp(definition, project)` produces HTTP-owned
`publicRoutes`, `authenticatedRoutes`, and discovery entries, while a future
gRPC package can project the same running phase into
services and streaming without changing core. The HTTP transport plugin rejects
duplicate capability names and relative paths.
Runtime refusals keep their meaning over HTTP, and no answer names another user
or session: a session the caller does not own answers 404
`zukhruf/session-not-found` (so does a deleted session's id, for good, even to
a `POST` that would start it again), a turn the session never issued (including a
regenerate of a message that never ran) answers 404
`zukhruf/session-turn-not-found`, an approval continuation for a turn the
session has moved past answers 409 `zukhruf/session-turn-stale`, and a
sub-agent turn whose tree has no free agent slot answers 429
`zukhruf/agent-thread-limit`, a turn or an archive of an archived session
answers 409 `zukhruf/session-archived`, and an unarchive of a session that is
not archived answers 409 `zukhruf/session-not-archived`. Hosts that call the
runtime directly catch the same refusals as `ConversationNotFoundError`,
`TurnNotFoundError`, `StaleTurnError`, `AgentThreadLimitError`,
`ConversationArchivedError` and `ConversationNotArchivedError` from the main
entry.
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

const stack = defineStack(async () => ({
  storage,
  bindings: [
    schedulesCapabilities.boss.bind(boss),
    schedulesCapabilities.transaction.bind(transaction),
  ],
}));
const runtime = new AgentRuntime(root);
await using host = await runtime.initialize(stack);

const scheduleControl = host.plugin(scheduled);
await using worker = await host.work();
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
(the absolute mount of `http()`) so that link is absolute. An archived session
is read-only: `POST /session/:sessionId/uploads` answers 409
`zukhruf/session-archived`, while a file uploaded before the archive still
reads. Both routes answer 404 for a deleted session.

The optional `@deepagents/experimental/zukhruf/mcp` plugin contributes tools
from an AI SDK `MCPClient`. Provide `mcp({ name, connect })`; Zukhruf connects
once during host initialization, snapshots the server's current tool catalog,
and closes the client when that host is disposed. The model sees each tool as
`mcp__<name>__<tool>`, named as Codex names MCP tools: characters outside
`[A-Za-z0-9_]` become `_`, and a name over 128 characters, or one that two tools
sanitize to, gets a 12-hex sha1 suffix. Calls still reach the server under the
tool's own name, so two servers that both expose `search` run side by side.

Codex's MCP timeouts apply per server. `connectTimeoutMs` (default 30000)
bounds connecting and, separately, listing the tools; a server that misses it
fails host initialization with `required MCP servers failed to initialize:
<name>: MCP client startup timed out after 30s`. `connect` receives
`{ signal }`, which aborts at that deadline: pass it to `createMCPClient` as
`initializationOptions.signal` so the handshake stops too. `toolTimeoutMs`
(default 300000) bounds each call; a call that outlasts it returns an
error-flagged result, `timed out awaiting tools/call after 300s`, which the
model reads while the turn goes on. Cancelling the turn still aborts a pending
call at once.

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
Collaboration tools stay on the direct model surface by default; pass
`Team.codex({ exposure: new CodeModeTools() })` as `multiAgent` to expose them
through AI SDK code mode instead.
