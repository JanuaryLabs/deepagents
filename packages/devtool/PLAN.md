# `@deepagents/devtool` plan

## Purpose

Build a publishable, development-only Zukhruf devtool whose persistent History
sidebar can drill into the traces of each conversation. This file is the
canonical implementation and continuation record. Chat context is disposable;
update this file whenever a decision, finding, completed phase, or next action
changes.

## Current state — 2026-08-27 (one-server hard cutover)

- The approved one-server, HTTP-only topology is implemented in the working
  tree. The host owns one Hono server and one `@hono/node-server` listener,
  mounts the authenticated Zukhruf protocol at `/zukhruf/v1` with
  `zukhruf(runtime)`, and mounts the DevTool UI at `/devtool` with
  `devtool()`. One terminal prints one `/devtool` URL.
- `@deepagents/devtool` (`packages/devtool/host`) is a mountable static UI app.
  `devtool()` returns a Hono app that serves the bundled assets beneath
  `/devtool/assets/*` (using `serveStatic` with a mount-prefix rewrite, which
  the probe proved necessary because Hono sub-apps see the full request path)
  and the SPA shell for every other `/devtool/*` path. It exports
  `DEVTOOL_ROUTE_PREFIX`. It receives no runtime object, runtime URL,
  credentials, hostname, port, headers, or proxy configuration and owns no
  plugin lifecycle. The Vite build uses `base: '/devtool/'`; the router uses
  React Router's `basename` from `import.meta.env.BASE_URL`, so `/devtool`
  redirects to `/devtool/history` and normal browser history works for deep
  links, refresh, and Back.
- The browser uses same-origin HTTP only: discovery `GET /zukhruf/v1/info`,
  health `GET /zukhruf/v1/health`, History via `capabilities.history.href`,
  chat via `capabilities.chat.href` (the unchanged `ZukhrufChatTransport`),
  and traces via `capabilities.traces.href`. Trace list/detail URLs carry no
  `userId`. The Traces links stay hidden when discovery omits `traces`.
- `@deepagents/experimental` owns the smallest first-class plugin HTTP
  contract: `AgentPluginInstance.protocol?: AgentPluginProtocol` with
  `discovery` entries (`{ path }` beneath the prefix) and authenticated
  `routes(host)`. `AgentRuntime` reads it once after `configure()`, gathers it
  into `runtime.protocol`, and rejects duplicate capability names or relative
  paths at construction. `zukhruf(runtime)` prefixes each path into an `href`,
  rejects collisions with the built-in `history` and `chat` capabilities at
  mount time, and mounts plugin routes after its authentication middleware so
  handlers read `userId` from the Hono context. The host only calls
  `zukhruf(runtime)`; `@deepagents/experimental` imports no DevTool package.
- `@deepagents/devtool-traces` owns the `fileTelemetry()` runtime plugin. It
  creates the file telemetry integration, correlates conversation, stream,
  agent name, and agent path on each turn, and contributes
  `capabilities.traces` plus
  `GET /zukhruf/v1/traces/:chatId` and `GET /zukhruf/v1/traces/:chatId/:traceId`
  automatically. Ownership is the authenticated `userId` plus `chatId`;
  durable turn status still overrides the projected status; empty files remain
  readable as an empty list and no file URI appears in discovery. The package
  has its own `test` Nx target.
- Consumers migrated to one server: `demo/zukhruf-simple` (`--devtool` mode,
  ordinary CLI turn preserved) and `demo/zukhruf-research-bot`. Each agent
  declaration installs `fileTelemetry()`; each `run.ts` runs `runtime.work()`
  before serving; each `server.ts` owns the HTTP composition (the host
  middleware that sets `userId` for `/zukhruf/v1/*`, `zukhruf(runtime)` at
  `/zukhruf/v1`, `devtool()` at `/devtool`, and the one listener on
  `127.0.0.1:4317`), returns the `/devtool` URL, and `run.ts` disposes worker and
  server through the existing `AsyncDisposableStack`.
  `tools/src/verify-definition-owned-plugins.ts` packs
  `@deepagents/devtool-traces` and uses `fileTelemetry()` as the
  definition-owned plugin.
- Obsolete and removed: the embedded `devtool()` runtime plugin, `DevtoolOptions`,
  loopback listener ownership, `runtime.url`, runtime headers, `hono/proxy`,
  `startDevtool`, direct `AgentPluginHost` access from the DevTool, the
  DevTool-owned `/zukhruf/v1/info` and History routes, the `?userId=` trace
  query contract, declaration scanning for `traces.path`, the separate
  trace-discovery plugin, `mountTraceRoutes`, and the proxy-focused tests and
  documentation. No compatibility path remains.
- The `/scheduled` route remains the unchanged placeholder. Scheduled Tasks
  stay a later slice; see [`plans/scheduled-tasks.md`](./plans/scheduled-tasks.md).
- Separate overlapping work in the same dirty tree (the shared component
  stylesheet imports in `host/ui/src/styles.css` and the
  `shimmer-styles.integration.test.ts` bundle proof) is preserved untouched.

## Superseded state — 2026-08-27 (before the cutover)

- `packages/devtool` is a folder-only container; the published
  `@deepagents/devtool` package lives at `packages/devtool/host` with
  publishable `history` and `traces` child packages. Shared display primitives
  come from `@deepagents/react-shadcn`.
- The Traces slice (conversation-scoped reads, persistent History navigation,
  newest-first trace selection, waterfall, span inspector) and the routed
  off-canvas shell with `/history`, `/chat/:sessionId?`,
  `/history/:userId/:chatId/traces/:traceId?`, and `/scheduled` are built.
- **Obsolete:** storage discovery belonging to an embedded devtool plugin, the
  `traces: { path: "file:///..." }` projection from a DevTool-owned
  `/zukhruf/v1/info`, the loopback-only DevTool listener, the runtime-URL
  proxy for chat, and the browser-supplied `?userId=` trace contract. These
  were replaced by the one-server cutover above.
- Backlog `#1194` and `#1210` remain done. Whole-context lint still has its
  existing `require-yield` error at `test/sqlite/stream-chunks.test.ts:282`.
- `.scratch/devtool/implementation-phases.md` is a historical establishment
  record, not the source of truth.

## Source contracts

Re-read these before changing their contracts:

- `packages/experimental/src/zukhruf/DESIGN.md` — declaration/runtime split,
  conversation and turn lifetimes, durable execution, identity, and plugin
  boundaries. Read in full on 2026-08-22 before this plan was written.
- `packages/experimental/src/zukhruf/runtime/agent-runtime.ts` — plugin host,
  lifecycle, and the `AgentPluginProtocol` contribution contract gathered into
  `runtime.protocol`.
- `packages/experimental/src/zukhruf/protocol/session.ts` — the authenticated
  `/zukhruf/v1` protocol, discovery merging, and plugin route mounting.
- `packages/experimental/src/zukhruf/runtime/agent-turn-executor.ts` — the point
  where one declaration becomes one conversation-scoped durable turn.
- `packages/context/src/lib/telemetry/*` — the built-in AI SDK lifecycle
  integrations, recording controls, JSONL record format, and file writer.
- Installed AI SDK source under `node_modules/ai/src/telemetry/*` — current
  telemetry event behavior.
- `TEST_PRIMITIVES.md` — use native Node testing primitives and public package
  entry points. Do not add test-only exports or internal aliases.

## Product model

The screen follows Zukhruf's actual lifetimes:

```text
History item = one root conversation (chatId, userId)
  └─ Turn trace = one durable model run (streamId)
       └─ Span tree = agent root → generation steps → function/tool executions
```

A conversation can have multiple turn traces. The underlined `Traces` link
opens that conversation's traces and selects the newest trace by default.

## Approved interaction contract

- History remains the permanent left sidebar in both the conversation and
  traces views.
- Every History item has a separate, underlined `Traces` link beneath its title
  and subtitle.
- Clicking the item title/summary opens the conversation summary.
- Clicking `Traces` opens the traces view scoped to that conversation.
- The selected History item stays highlighted in both views.
- `History.ItemTrigger` and the `Traces` link are sibling interactive controls;
  never nest an anchor inside the existing button.
- The newest turn trace opens by default. A compact selector switches older
  traces for that conversation.
- Selecting a waterfall row or timing bar opens the span inspector.
- Loading, empty, unavailable, running, completed, failed, cancelled, and
  not-recorded states must be explicit.
- There is no global traces page or second traces sidebar in this slice.

## Approved wireframe

```text
┌──────────────────────────────────────────────────────────────────────────────────────────────┐
│ Zukhruf Devtool                                                               ● Connected   │
├──────────────────────┬───────────────────────────────────────────────────────────────────────┤
│ HISTORY           4  │ First conversation                                                     │
│                      │ Traces · 8 turns                                      Completed        │
│ ┌──────────────────┐ ├───────────────────────────────────────────────────────────────────────┤
│ │ ● First conversa…│ │ Trace  [ Latest · 12:43 PM · 4.82s · Completed              ▾ ]       │
│ │   user-1 · 12:43 │ │                                                                       │
│ │   Traces         │ │     0s       1s       2s       3s       4s                         │
│ └──────────────────┘ │     │        │        │        │        │                          │
│                      │                                                                       │
│   ● Compare vendors  │ ▼ Agent · support                                ████████████████     │
│     user-1 · 12:38   │                                                                       │
│     Traces           │   ◆ Generation · gpt-5.4                         ███████              │
│                      │                                                                       │
│   ✕ Send follow-up   │     ◇ Function · search_docs                           ██             │
│     user-1 · 12:31   │                                                                       │
│     Traces           │   ◆ Generation · gpt-5.4                               ██████         │
│                      │                                                                       │
│   ● Billing question │     ◇ Function · send_email                                  ███     │
│     user-2 · Monday  │                                                                       │
│     Traces           ├───────────────────────────────────────────┬───────────────────────────┤
│                      │                                           │ GENERATION                │
│                      │                                           │ gpt-5.4 · 2.31s            │
│                      │                                           │                           │
│                      │                                           │ Overview Input Output Raw │
│                      │                                           │                           │
│                      │                                           │ 2,840 input · 412 output  │
└──────────────────────┴───────────────────────────────────────────┴───────────────────────────┘
```

## Visual contract

### Visual thesis

A restrained, monochrome debugger surface: dense like browser DevTools, calm
like Linear, with timing bars as the single visual accent and destructive red
reserved for real failures.

### Content plan

1. Persistent History navigation and conversation context.
2. Conversation-scoped trace header and newest-first trace selector.
3. Hierarchical timing waterfall as the primary workspace.
4. Secondary span inspector with Overview, Input, Output, and Raw views.

No hero, dashboard cards, aggregate charts, or decorative imagery belong in
this operational surface.

### Interaction thesis

- History selection persists while the main view changes between summary and
  traces.
- Span selection is immediate and local: row hover clarifies the timing bar;
  click updates the inspector without moving the layout.
- Running spans use one restrained motion (an indeterminate bar or pulse) and
  the existing status spinner. Respect reduced-motion preferences.

### Component budget

Retain only the current History composition. Native `select` and buttons cover
trace selection and inspector tabs; CSS covers scrolling, badges, separators,
loading states, and the fixed grid layout. Do not keep generated component
scaffold for hypothetical future work.

## Trace data contract

Each trace is correlated from the preserved Zukhruf runtime context:

```ts
interface DevtoolTraceContext {
  chatId: string;
  userId: string;
  streamId: string;
  agentName: string;
  agentPath: string;
}
```

The read model must preserve the existing trace vocabulary rather than invent
another one:

- trace: ID, conversation/turn context, workflow/agent name, start/end,
  status, total usage, step count, finish reason;
- span: ID, trace ID, parent ID, start/end, type, name/model, usage,
  input/output, and error;
- status is derived from open/end/error state and the durable turn terminal
  status where needed;
- durations are derived from timestamps;
- input/output absence is distinguishable from redaction.

### Capture boundary

- The `fileTelemetry()` runtime plugin owns recording, discovery, correlation, projection, and
  the authenticated `/zukhruf/v1/traces` routes. The DevTool UI never receives
  a runtime object or file path.

- Agent declarations remain the owners of AI SDK recording policy and any
  declaration-local integrations. Runtime plugins may contribute additional
  integrations; the AI SDK dispatches to all of them.
- `fileTelemetry()` uses the existing `createFileTelemetry()` integration and
  `TelemetryLogRecord` vocabulary. Its public `traces.path` descriptor may be
  projected, but records must not be copied into another persistence mechanism.
- Zukhruf supplies conversation/turn context at the runtime boundary;
  the plugin adds that correlation metadata to its integration's start event
  for each turn.
- The `file:` source is consumed inside the runtime process, never the browser.
  Discovery advertises only `capabilities.traces.href`, never the file URI.
- Honor `telemetry: { isEnabled: false }`; an opted-out turn produces no trace.

### Durability and privacy

- Traces must survive process restart because History survives process restart.
- Do not store trace payloads in `ContextStore` chat metadata; prompts and tool
  outputs are large and sensitive, and chat metadata is not a trace database.
- Do not rely on `StreamStore` as permanent trace storage; its contract permits
  cleanup after terminal turns.
- Durability, retention, and deletion belong to the agent's file telemetry
  JSONL. The devtool owns no database and exposes no second retention setting.
- Trace reads are authenticated HTTP operations behind the host's
  `/zukhruf/v1/*` middleware; ownership derives from the authenticated
  `userId`, never a query parameter.
- Preserve AI SDK recording controls. Correlation metadata is not model input;
  runtime context remains redacted when inputs are not recorded. The UI must
  label disabled payloads and never imply that missing sensitive data was
  captured.

## HTTP/read surface

Keep the HTTP API conversation-scoped. Exact route names may be adjusted while
implementing, but the behavior is fixed:

- list turn traces for one discovered session, newest first
  (`GET /zukhruf/v1/traces/:chatId`);
- fetch one trace and its ordered parent/child spans
  (`GET /zukhruf/v1/traces/:chatId/:traceId`);
- reject a trace that does not belong to the requested conversation;
- expose no mutation or runtime control endpoint in this slice;
- polling is sufficient initially and reuses the current History refresh
  pattern. Do not add WebSocket or SSE infrastructure.

## Implementation phases

### Phase 0 — Canonical plan

- [x] Preserve current state, approved wireframe, decisions, contracts,
      non-goals, gates, and next action in this tracked package file.

### Phase 1 — Telemetry projection proof

- [x] Probe the installed AI SDK tracing channel with a mock streaming model
      and a real tool execution.
- [x] Record the event-shape findings below.
- [x] Select the smallest correct per-turn correlation hook.
- [x] Select the existing file telemetry JSONL as the durable source.
- [x] Add one focused public-flow integration test that failed when the old
      in-memory devtool database restarted and now targets the existing JSONL.
- [x] Re-run the focused proof through `nx run @deepagents/context:test` with
      only the unrelated docs inference temporarily excluded.

### Phase 2 — Conversation-scoped trace API

- [x] Add the minimum plugin/runtime read surface needed by the devtool.
- [x] Project one real Zukhruf turn with generation and function spans from
      built-in telemetry.
- [x] List traces by conversation and fetch one trace tree.
- [x] Prove conversation isolation, ordering, status, usage, error, redaction,
      restart persistence, and plugin disposal.

### Phase 3 — Approved UI

- [x] Keep History mounted as the permanent sidebar.
- [x] Add a sibling underlined `Traces` link to each History item.
- [x] Add conversation-summary and traces view state with browser-history-safe
      navigation.
- [x] Add newest-first trace selector, waterfall, and span inspector.
- [x] Add loading, empty, unavailable, live, failed, and not-recorded states.
- [x] Remove unused generated UI components and dependencies not retained by
      the approved component budget (backlog `#1194`).

### Phase 4 — Verification and package proof

- [x] Focused `nx run @deepagents/context:test` telemetry proof.
- [x] `nx run @deepagents/devtool:lint`
- [x] `nx run @deepagents/devtool:typecheck`
- [x] `nx run @deepagents/devtool:test`
- [ ] Browser smoke: summary → underlined Traces link → newest trace → older
      trace → span inspector → browser Back, with no console errors.
- [x] `npm pack --dry-run`; packed-consumer execution remains historical proof.
- [x] Verify the built Node entry has no UI runtime imports and the browser
      asset graph is complete.
- [x] Update README with only the public setup, storage/retention, local URL,
      and sensitive-data behavior developers need.

### Phase 5 — Devtool-owned discovery hard cutover

- [x] Keep `devtool()` as an embedded runtime plugin and remove the standalone
      attachment client.
- [x] Keep telemetry integrations in agent declarations; do not add a runtime
      observability owner or narrow the declaration telemetry type.
- [x] Keep trace discovery and `traces: { path: "file:///..." }` projection in
      the devtool plugin's own `/zukhruf/v1/info` route.
- [x] Select the devtool adapter from the URI scheme and keep file access in
      the Node devtool process.
- [x] Remove trace storage metadata and telemetry inspection from Zukhruf core.
- [x] Use the devtool definition's fresh `AgentPluginInstance.configure(root)`
      hook to discover telemetry only in that runtime's copy.
- [x] Omit `traces` and hide links when the source is not discoverable.
- [x] Preserve the embedded `devtool()` lifecycle.
- [x] Re-run final lint, package, restart, and discovery integration proof.
- [x] Reload the live browser for the corrected empty-file adapter proof.

### Phase 6 — Devtool package container

- [x] Make `packages/devtool` the container and move the existing published
      package to `packages/devtool/host`.
- [x] Update npm workspace discovery, package-lock links, Nx paths, TypeScript
      references, package metadata, and tracked plan links.
- [x] Verify typecheck, integration tests, lint, and `npm pack --dry-run` from
      the nested host package.
- [x] Extract the existing History composition as the first real child package.
- [x] Extract the trace read model and trace UI as a child package without
      duplicating their contracts.
- [x] Consolidate shared display primitives in `@deepagents/react-shadcn`
      without adding speculative devtool components.
- [x] Keep devtool status formatting in History and theme values in the host.
- [ ] Add the Scheduled Tasks and run-inbox UI only after their HTTP,
      notification, and cross-run-memory contracts are approved.

### Phase 7 — One-server hard cutover (approved, implemented 2026-08-27)

- [x] Add the plugin HTTP contribution contract to `@deepagents/experimental`
      (`AgentPluginProtocol`, `runtime.protocol`, discovery merging, route
      mounting, deterministic duplicate failures) with public integration tests.
- [x] Add `fileTelemetry()` to `@deepagents/devtool-traces`; it contributes one
      AI SDK telemetry integration plus authenticated trace discovery and
      routes. Its Nx `test` target proves multi-integration dispatch, owner
      isolation, list/detail, durable status, empty files, omitted capability
      without the plugin, restart persistence, and no file-path leakage.
- [x] Convert `devtool()` into a mountable static Hono app with a `/devtool`
      base, asset prefix rewrite, and scoped SPA fallback; remove the embedded
      plugin, listener, proxy, options, and direct host access.
- [x] Switch the browser to same-origin `/zukhruf/v1` discovery, health,
      History, chat, and traces; remove the runtime-URL state and the
      `?userId=` trace contract.
- [x] Migrate `demo/zukhruf-simple`, `demo/zukhruf-research-bot`, and the
      packed-plugin verification script to one server.
- [x] Update this plan, the host README, the Zukhruf design and README, the
      Scheduled Tasks plan foundation, and both demo READMEs.
- [ ] Browser smoke on the one-server `zukhruf-simple` DevTool (see the
      continuation record).

## Non-goals

- Global traces page or aggregate dashboard.
- Cost calculation without a real pricing source.
- Agent topology, handoff graph, or dedicated child-progress protocol.
- Trace mutation, retry, cancellation, approval, or other controls.
- DevTool-owned listener, proxy, runtime URL, credentials, or hosted collector.
- WebSocket/SSE transport.
- Remote observability adapters, credentials, authentication, or CORS.

## Verification rules

- Use package module specifiers in tests.
- Drive behavior through `AgentRuntime`; no calls to private classes, test-only
  aliases, exports, or entry points.
- Prefer one integration flow over per-function unit suites.
- Use `nx run <project>:typecheck` and `nx run <project>:test`.
- Leave all changes unstaged unless the user explicitly authorizes staging in
  the current turn.

## Probe findings

Probed against installed `ai@7.0.70` on Node `v25.9.0` with
`MockLanguageModelV4`, a two-step `streamText` call, and one real tool
execution.

- `ai:telemetry` emits the hierarchy
  `streamText -> step -> languageModelCall / executeTool`. Binding an
  `AsyncLocalStorage` to the tracing channel's start channel preserved exact
  parent IDs across the long-lived streaming context.
- The root `streamText` start event contains `callId`, operation/model fields,
  recording flags, and explicitly included `runtimeContext`. Step and child
  events reuse `callId`; step events also contain `stepNumber`.
- Streaming `start` and `end` fire at setup. The root `asyncEnd` fires only
  after `fullStream` is consumed. Step `asyncEnd` fires after its model/tool
  work. This is sufficient for root/step timing.
- `languageModelCall` `asyncEnd` contains the provider's returned
  `{ stream }`, so it measures stream acquisition rather than normalized model
  completion and does not itself expose usage or generated output.
- `executeTool` `asyncEnd` contains normalized `output` and
  `toolExecutionMs`. A thrown tool error is normalized as tool output rather
  than published on the tracing channel's `error` channel.
- `recordInputs: false` and `recordOutputs: false` are present on events and
  must be honored by the trace integration; absence must be labelled as not
  recorded, not treated as empty content.

### Selected capture design

- `fileTelemetry()` owns one existing `createFileTelemetry()` integration and
  its `TelemetryLogRecord` output. The devtool's file adapter groups lifecycle
  events by AI SDK `callId` and derives the agent, generation, and function
  spans required by the existing UI.
- The Zukhruf runtime supplies the conversation, stream, declaration name, and
  canonical agent path to each per-turn plugin telemetry contribution. The
  file plugin adds that correlation metadata to its integration's `onStart`
  event.
- The plugin keeps its absolute `file:` URI private and advertises only the
  authenticated trace route.
- When `recordInputs` is false, prompt, tool, and runtime context remain
  redacted while the devtool-owned correlation metadata remains available.

### Selected storage and retention

- The declaration's JSONL file is the only durable telemetry store. Its path is
  exposed locally as a `file:` URI through discovery.
- The devtool file adapter is read-only and stateless. Restart persistence
  follows the file, and deleting or rotating that file deletes or rotates the
  traces.
- There is no devtool retention job, mutation endpoint, SQLite schema, or
  lifecycle-owned storage to maintain.

## Continuation record

**Exact next action:** keep the one-server composition as the only supported
topology. The next product slice is still Scheduled Tasks: obtain approval or
corrections for its wireframes and notification scope, then implement Phase 1
of [`plans/scheduled-tasks.md`](./plans/scheduled-tasks.md) as an installed
runtime plugin that contributes its own `AgentPluginProtocol`. Do not stage or
commit without explicit authorization.
