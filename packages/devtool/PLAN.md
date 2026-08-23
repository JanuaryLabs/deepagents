# `@deepagents/devtool` plan

## Purpose

Build a publishable, development-only Zukhruf devtool whose persistent History
sidebar can drill into the traces of each conversation. This file is the
canonical implementation and continuation record. Chat context is disposable;
update this file whenever a decision, finding, completed phase, or next action
changes.

## Current state — 2026-08-23

- The approved Traces slice is implemented in the working tree:
  conversation-scoped HTTP routes, persistent History navigation, newest-first
  trace selection, waterfall, and span inspector.
- Storage discovery belongs to the devtool plugin. Agent declarations retain
  their existing telemetry integration; the plugin reads its public
  `traces.path` descriptor and advertises it from the devtool's own
  `GET /zukhruf/v1/info` route when exactly one supported source is discoverable.
- The URI scheme selects the devtool's Node adapter. The `file:` adapter reads
  and projects the existing JSONL in place; the agent protocol exposes no
  normalized trace routes and the devtool creates no second store.
- When no unambiguous supported source is discoverable, `/info` omits `traces`
  and the UI omits every `Traces` link. A discovered empty file still shows the
  link and explicit empty state. The generic agent protocol and
  `AgentRuntimeInfo` contain no trace-storage knowledge.
- The public-flow integration suite drives a real two-step tool turn through
  `AgentRuntime`, verifies conversation isolation, recording controls, failed
  generation status and error projection, and starts a second devtool runtime
  against the same telemetry file to prove restart persistence without a
  second database. It also proves that the plugin's runtime copy receives the
  correlation context without mutating the source declaration.
- Browser smoke after the storage cleanup passed discovery, persistent History,
  the conditional underlined `Traces` link, the no-records empty state, browser
  Back, and a clean console. The earlier full trace drill-down smoke remains the
  proof for newest/older selection and span inspection.
- `demo/zukhruf-research-bot` is the first live consumer. Its host loads the
  root, planner, and researcher declarations, starts the worker and devtool,
  and waits for shutdown. It has no conversation creation, `enqueue()` call,
  terminal client, or automatic turn execution.
- Backlog `#1194` is done: the generated shadcn component scaffold and
  its unused dependencies are removed. Native controls cover the selector and
  inspector tabs; the History composition remains the only local component.
- The plugin-owned correction is green for the 15 protocol tests, six file
  telemetry tests, all three devtool integration tests,
  context/experimental/devtool typechecks, devtool lint, package dry-run,
  generated declaration audit, restart persistence, and discovery output. The
  typechecks use Nx's supported
  `--skip-sync` flag because the unrelated `demo/wasm-render` reference is
  stale. Whole-context lint still has its existing `require-yield` error at
  `test/sqlite/stream-chunks.test.ts:282`.
- A fresh normal Nx graph remains blocked by the docs Vite plugin failing to
  resolve a TypeScript config for `apps/docs/react-router.config.ts`. Verification
  temporarily excluded the docs app from Vite/Vitest inference, then restored
  `nx.json` exactly. The independent defect is tracked as backlog `#1210`.
- The complete plugin-owned devtool slice is staged as of 2026-08-23. Mixed
  root lockfile, TypeScript project-reference, and experimental runtime files
  retain their unrelated wasm and plugin-skills changes only in the working
  tree; do not overwrite, restore, stage, or attribute those changes to
  devtool.
- `.scratch/devtool/implementation-phases.md` is a historical establishment
  record, not the source of truth. Its capability checkpoint is stale because
  History already expanded `AgentPluginHost`.
- Historical baseline: the full context suite passed with 1,396 tests. The
  experimental suite had unrelated PostgreSQL-environment and pg-boss
  retention blockers.

## Source contracts

Re-read these before changing their contracts:

- `packages/experimental/src/zukhruf/DESIGN.md` — declaration/runtime split,
  conversation and turn lifetimes, durable execution, identity, and plugin
  boundaries. Read in full on 2026-08-22 before this plan was written.
- `packages/experimental/src/zukhruf/runtime/agent-runtime.ts` — plugin host and
  lifecycle.
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

- Agent declarations remain the owners of AI SDK telemetry integrations and
  recording policy. Devtool setup must not move or replace them.
- Use the existing `createFileTelemetry()` integration and
  `TelemetryLogRecord` vocabulary. Its public `traces.path` descriptor may be
  projected, but records must not be copied into another persistence mechanism.
- Zukhruf supplies conversation/turn context at the runtime boundary;
  declaration-scoped telemetry alone cannot correlate a trace to History. The
  devtool plugin opts that existing namespace into telemetry on its cloned
  runtime declaration graph.
- The devtool's `/zukhruf/v1/info` exposes `traces.path`; the URI scheme selects
  its adapter. `file:` is local-only and is consumed by Node, never the browser.
- Honor `telemetry: { isEnabled: false }`; an opted-out turn produces no trace.

### Durability and privacy

- Traces must survive process restart because History survives process restart.
- Do not store trace payloads in `ContextStore` chat metadata; prompts and tool
  outputs are large and sensitive, and chat metadata is not a trace database.
- Do not rely on `StreamStore` as permanent trace storage; its contract permits
  cleanup after terminal turns.
- Durability, retention, and deletion belong to the agent's file telemetry
  JSONL. The devtool owns no database and exposes no second retention setting.
- Keep the loopback-only server boundary. Remote access and authentication stay
  out of scope.
- Preserve AI SDK recording controls. `preserveRuntimeContext` may retain only
  explicitly selected non-sensitive correlation namespaces when inputs are not
  recorded. The UI must label disabled payloads and never imply that missing
  sensitive data was captured.

## HTTP/read surface

Keep the HTTP API conversation-scoped. Exact route names may be adjusted while
implementing, but the behavior is fixed:

- list turn traces for one discovered session, newest first;
- fetch one trace and its ordered parent/child spans;
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
- [x] `nx run @deepagents/devtool:typecheck --skip-sync`
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
- [x] Use the existing `AgentRuntimePlugin.configure(root)` seam to include the
      existing Zukhruf runtime context only in the plugin's runtime copy.
- [x] Omit `traces` and hide links when the source is not discoverable.
- [x] Preserve the embedded `devtool()` lifecycle.
- [x] Re-run final lint, package, restart, and discovery integration proof.
- [x] Reload the live browser for the corrected empty-file adapter proof.

## Non-goals

- Global traces page or aggregate dashboard.
- Cost calculation without a real pricing source.
- Agent topology, handoff graph, or dedicated child-progress protocol.
- Trace mutation, retry, cancellation, approval, or other controls.
- Remote listener, authentication, multi-user deployment, or hosted collector.
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

- Reuse the declaration's existing `createFileTelemetry()` and its
  `TelemetryLogRecord` output. The devtool's file adapter groups lifecycle
  events by AI SDK `callId` and derives the agent, generation, and function
  spans required by the existing UI.
- The Zukhruf executor already supplies `chatId`, `userId`, `streamId`,
  declaration name, and canonical agent path under `runtimeContext.zukhruf`.
  The devtool plugin opts that namespace into AI SDK telemetry through the
  existing declaration-configuration seam.
- The devtool advertises an absolute `file:` URI only when exactly one supported
  source is discoverable. The scheme is the adapter identifier.
- When `recordInputs` is false, `createFileTelemetry()` can preserve only
  `zukhruf`; prompt, tool, and unrelated runtime context remain redacted.

### Selected storage and retention

- The declaration's JSONL file is the only durable telemetry store. Its path is
  exposed locally as a `file:` URI through discovery.
- The devtool file adapter is read-only and stateless. Restart persistence
  follows the file, and deleting or rotating that file deletes or rotates the
  traces.
- There is no devtool retention job, mutation endpoint, SQLite schema, or
  lifecycle-owned storage to maintain.

## Continuation record

**Exact next action:** rerun the declaration-only demo without submitting a
turn if fresh live-browser validation is wanted. Do not commit without explicit
authorization. Fixing the independent docs graph defect and stale wasm
reference remains outside this change.
