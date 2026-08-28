# Scheduled Tasks in `@deepagents/devtool`

Status: in progress; the shared Shadcn sidebar seam, routed off-canvas
navigation shell, and placeholder Scheduled route are ported. Schedule
capability discovery, management routes, management UI, and notification scope
still await approval and implementation.

## Outcome

Add a local Scheduled Tasks management surface to `@deepagents/devtool`:

- create, edit, pause, resume, archive, purge, and run tasks;
- review and cancel durable runs from one owner-wide inbox;
- open the exact conversation and turn behind a run;
- share explicit, versioned Markdown memory across otherwise independent runs;
- show durable unread counts and optional browser notifications.

The UI and inbox require an HTTP bridge. Cross-run memory and desktop alerts are
adjacent capabilities, not prerequisites for listing or reviewing runs, so they
remain separate phases with separate proofs.

## Current foundation

- `@deepagents/experimental/zukhruf/schedules` owns PostgreSQL/PGlite task and
  run persistence, recurrence, workers, run review state, and lifecycle
  mutations.
- `schedules()` returns a reusable plugin definition. Each `AgentRuntime`
  materializes a fresh `ScheduleControl`, available through
  `runtime.plugin(definition)`. It supports fresh-root and
  existing-conversation targets.
- `@deepagents/devtool` is a mountable static UI app served by the host's one
  Hono server at a host-selected path (currently `/devtool` in both demos). It
  discovers capabilities from the same-origin info route at the host-selected
  protocol mount; runtime plugins expose typed transport-neutral instances, and
  definition-bound HTTP projections contribute authenticated routes and
  discovery entries to `http(runtime, ...projections)`. It has React Router
  routes under the injected document base, a persistent History sidebar, a
  placeholder Scheduled route, and three-second polling.
- The current schedule adapter leaves successful run `title` and `summary`
  empty, exposes runs only through one task at a time, and has no cross-run
  memory.
- The devtool has publishable `history` and `traces` child packages and
  consumes Base UI-backed primitives from `@deepagents/react-shadcn`.
  History owns status presentation; the host owns its theme and shell.

## Source contracts

Read these before implementing a phase:

- [`../PLAN.md`](../PLAN.md) — devtool ownership, current UI, HTTP, package,
  verification, and dirty-tree state;
- [`../../experimental/src/zukhruf/DESIGN.md`](../../experimental/src/zukhruf/DESIGN.md)
  — declaration/runtime lifetimes, scheduling, durability, and plugin boundaries;
- [`../../experimental/src/zukhruf/plugins/schedules/scheduled-tasks.ts`](../../experimental/src/zukhruf/plugins/schedules/scheduled-tasks.ts)
  — authoritative task/run state and PostgreSQL transactions;
- [`../../experimental/src/zukhruf/plugins/schedules/index.ts`](../../experimental/src/zukhruf/plugins/schedules/index.ts)
  — AgentRuntime schedule adapter and public control surface;
- [`../host/src/index.ts`](../host/src/index.ts),
  [`../host/ui/src/main.tsx`](../host/ui/src/main.tsx), and the
  [`../traces/src`](../traces/src) package — current mountable UI app, the
  browser's same-origin discovery, the `fileTelemetry()` plugin's routes,
  polling, navigation, and native UI;
- [`ui-components.md`](ui-components.md) — current repository UI topology and
  the approved Limerence component-reuse seam;
- [`../../../TEST_PRIMITIVES.md`](../../../TEST_PRIMITIVES.md) — repository test
  primitives and public-boundary rules;
- [`../../../.scratch/codex-scheduled-tasks/map.md`](../../../.scratch/codex-scheduled-tasks/map.md)
  — historical scheduler decisions and Codex reference boundary.

## Ownership and boundaries

### Scheduler package owns

- authoritative task, run, review, and memory state;
- owner-scoped control operations;
- occurrence/run idempotency and transaction boundaries;
- AgentRuntime execution provenance and structured run-result projection;
- model access to memory during an eligible scheduled run.

### Devtool package owns

- the loopback HTTP adapter over an explicitly supplied `ScheduleControl`;
- request validation and browser-safe read models;
- management, inbox, memory-editor, and notification UI;
- local notification preference.

### Host owns

- the `schedules()` definition and its PostgreSQL/PGlite capability bindings;
- the single owner ID exposed by one local devtool instance;
- the decision to install both plugins.

Composition stays explicit:

```ts
const scheduled = schedules(scheduleOptions);
const developerTool = devtool();
const root = defineAgent({
  // model, sandbox, instructions, ...
  plugins: [scheduled, developerTool],
});

const runtime = new AgentRuntime(root, {
  ...runtimeOptions,
  bindings: [
    schedulesCapabilities.boss.bind(boss),
    schedulesCapabilities.transaction.bind(transaction),
  ],
});

const scheduleControl = runtime.plugin(scheduled);
```

The proposed HTTP bridge cannot be passed into `devtool()` as a live control
object during definition construction: `scheduleControl` exists only after the
runtime materializes both definitions. Before Phase 1 implementation, choose a
small explicit post-construction host attachment or a first-class plugin
interaction contract. Do not reintroduce caller-created plugin instances, a
service locator, or runtime plugin selection.

The browser never supplies or overrides `ownerId`. A remote listener,
multi-user devtool, authentication system, plugin registry, and service locator
remain out of scope.

## Product contract

- `pending_review` is the durable unread source of truth. Opening a run does not
  mark it reviewed; the user chooses **Mark reviewed**.
- The inbox lists pending-review runs across every retained schedule for the
  configured owner, newest first.
- Run execution state and review state stay independent.
- A run response includes an exact conversation reference. Fresh-root runs
  point to the run conversation; existing-conversation runs point to their
  configured conversation and exact turn.
- Successful AgentRuntime runs project structured `title` and `summary` values.
  Do not parse arbitrary prose with title/summary heuristics.
- Schedule memory is one explicit Markdown resource per schedule. It is not
  inherited transcript history and is not stored in chat metadata.
- Memory updates use optimistic versions so overlapping runs cannot silently
  overwrite each other. A conflict requires reread and merge.
- Archiving a task preserves its memory and runs. Purging an archived task
  removes both. A running task cannot be purged.
- The first notification release is an in-app count plus optional native
  browser notifications while the devtool page is open. It adds no WebSocket,
  SSE, service worker, email, Slack, or push infrastructure.

## Proposed HTTP surface

All responses use `Cache-Control: no-store`. Inputs are validated with Zod.
Unknown owners are impossible because the devtool binds one owner before route
registration. Missing or foreign IDs return the same `404` shape.

| Method   | Route                                | Purpose                                     |
| -------- | ------------------------------------ | ------------------------------------------- |
| `GET`    | `/api/schedules`                     | List retained task definitions              |
| `POST`   | `/api/schedules`                     | Create idempotently                         |
| `GET`    | `/api/schedules/:taskId`             | Read one task                               |
| `PATCH`  | `/api/schedules/:taskId`             | Edit definition fields                      |
| `POST`   | `/api/schedules/:taskId/pause`       | Pause future occurrences                    |
| `POST`   | `/api/schedules/:taskId/resume`      | Resume from now                             |
| `POST`   | `/api/schedules/:taskId/run`         | Run now with an idempotency key             |
| `POST`   | `/api/schedules/:taskId/archive`     | Archive future occurrences                  |
| `DELETE` | `/api/schedules/:taskId`             | Purge an already-archived inactive task     |
| `GET`    | `/api/schedules/:taskId/runs`        | List one task's runs                        |
| `GET`    | `/api/scheduled-runs/inbox`          | List owner-wide pending-review runs         |
| `GET`    | `/api/scheduled-runs/:runId`         | Read one run and its conversation reference |
| `POST`   | `/api/scheduled-runs/:runId/cancel`  | Cancel an active run                        |
| `POST`   | `/api/scheduled-runs/:runId/review`  | Mark a terminal run reviewed                |
| `POST`   | `/api/scheduled-runs/:runId/archive` | Archive a terminal run                      |
| `GET`    | `/api/schedules/:taskId/memory`      | Read Markdown and version                   |
| `PUT`    | `/api/schedules/:taskId/memory`      | Replace Markdown at an expected version     |

Discovery advertises this surface only after the host explicitly attaches the
future schedules bridge. Existing devtool users and bundles remain unchanged
when it is absent.

## Proposed wireframes

### Run inbox

```text
┌──────────────────────────────────────────────────────────────────────────────────────────────┐
│ Zukhruf Devtool                                                               ● Connected   │
├──────────────────────┬───────────────────────────────────────────────────────────────────────┤
│ [ History ] [Scheduled 3]                                                     [+ New task]  │
│                      │ SCHEDULED / INBOX                                                      │
│ INBOX             3  │ Inbox 3                                      [Inbox] [Tasks]          │
│ ┌──────────────────┐ ├───────────────────────────────────────────────────────────────────────┤
│ │ ● Monday report  │ │ Monday report                                      Completed         │
│ │   Completed 12:43│ │ Finished 12:43 PM · fresh conversation                                │
│ └──────────────────┘ │                                                                       │
│   ✕ Vendor monitor   │ Engineering report is ready.                                          │
│     Failed 12:31     │                                                                       │
│   ● Daily triage     │ [Open conversation]  [Mark reviewed]  [Archive run]                   │
│     Completed Monday │                                                                       │
│                      ├───────────────────────────────────────────────────────────────────────┤
│ TASKS             4  │ RUN DETAILS                                                           │
│   Monday report     ●│ Scheduled for 12:40 PM                                                │
│   Vendor monitor    ●│ Started 12:40 PM · finished 12:43 PM                                  │
│   Daily triage      ‖│ Run ID  7ea… · Turn ID  12b…                                         │
│   Cleanup           ○│                                                                       │
└──────────────────────┴───────────────────────────────────────────────────────────────────────┘
```

### Task management and memory

```text
┌──────────────────────────────────────────────────────────────────────────────────────────────┐
│ Zukhruf Devtool                                                               ● Connected   │
├──────────────────────┬───────────────────────────────────────────────────────────────────────┤
│ [ History ] [Scheduled 3]                                                     [+ New task]  │
│                      │ SCHEDULED / TASKS                                                      │
│ INBOX             3  │ Monday report                    Active     [Run now] [•••]            │
│   Monday report      ├───────────────────────────────────────────────────────────────────────┤
│   Vendor monitor     │ [Overview] [Runs] [Memory]                                             │
│   Daily triage       │                                                                       │
│                      │ Name       [ Monday report                                      ]      │
│ TASKS             4  │ Prompt     [ Prepare the weekly engineering report.             ]      │
│ ┌──────────────────┐ │            [                                                     ]      │
│ │ Monday report   ●│ │ Schedule   [ 0 9 * * 1                ] [ Asia/Amman          ▾ ]      │
│ │ Next Mon 9:00 AM │ │ Target     [ New conversation                                  ▾ ]      │
│ └──────────────────┘ │                                                                       │
│   Vendor monitor   ● │                                                    [Save changes]      │
│   Daily triage     ‖ ├───────────────────────────────────────────────────────────────────────┤
│   Cleanup          ○ │ MEMORY  v7                                                            │
│                      │ [ Current priorities and facts shared across independent runs…  ]      │
│                      │ [                                                             ]      │
│                      │                                               [Discard] [Save memory]   │
└──────────────────────┴───────────────────────────────────────────────────────────────────────┘
```

Component selection follows the approved seam in
[`ui-components.md`](ui-components.md). Do not add a second primitive system or
import components from another application.

Interactions and states:

- **History / Scheduled** switches the sidebar and main workspace while keeping
  browser Back/Forward navigation.
- **Inbox / Tasks** switches between global review work and task management.
- Selecting an inbox item does not mutate review state.
- **Open conversation** navigates to the exact conversation and turn.
- **Run now**, pause/resume, archive, cancel, review, and purge show pending,
  success, conflict, and failure states; destructive actions require the
  approved accessible confirmation component.
- Create/edit accepts five-field cron plus timezone in the first UI. RRULE
  remains API-capable and read-only in the form until a concrete editor exists.
- Memory save sends the displayed version. `409 Conflict` keeps the draft and
  offers reload instead of overwriting newer memory.
- Keyboard focus, visible labels, error text, reduced motion, and native form
  semantics are acceptance requirements.

## Dependency-ordered phases

### Phase 0 — Contract and approval

Work:

- approve or revise the management and inbox UI structure;
- [x] approve the Limerence component seam after its source inventory;
- confirm whether notifications are page-open browser alerts or require a
  closed-browser host notifier;
- confirm that the local devtool binds one owner ID;
- make this file the single source of truth for this product slice.

Complete when the user explicitly approves the UI structure, schedule bridge
shape, and notification guarantee. No additional production code changes belong
to this phase.

### Phase 1 — Scheduler read model and run results

Work:

- add an owner-wide pending-review query to the public schedule control;
- expose the exact conversation/turn reference required to open a run;
- persist scheduled provenance on the enqueued turn;
- project structured successful `title` and `summary` values through the
  AgentRuntime adapter without parsing arbitrary assistant prose;
- add the missing competing-worker and duplicate-occurrence public-boundary
  proofs tracked by backlog `#1214`.

Complete when public package tests prove owner isolation, deterministic inbox
ordering, fresh/existing conversation references, structured results, duplicate
delivery, and competing workers on PGlite and real PostgreSQL.

### Phase 2 — Devtool HTTP management adapter

Work:

- add the explicit schedules option to `devtool()`;
- advertise schedule capability and route URLs through discovery;
- implement the read and lifecycle routes in the table above;
- preserve scheduler idempotency keys and lifecycle errors at the HTTP boundary;
- keep static UI serving and trace routes unchanged when schedules are absent.

Complete when one devtool integration flow creates, edits, runs, cancels,
reviews, archives, and purges through HTTP, proves foreign IDs are not exposed,
and proves restart persistence through the real public package boundary.

### Phase 3 — Explicit cross-run memory

Work:

- add one schedule-owned Markdown memory record in the scheduler PostgreSQL
  schema with a monotonic version;
- expose owner-checked read and compare-and-swap update operations;
- inject memory only into eligible scheduled execution context;
- provide a typed, run-scoped update mechanism; add the smallest runtime seam
  only if the current plugin tool/context hooks cannot hide it from ordinary
  turns;
- expose memory through the devtool HTTP adapter.

Complete when run N updates memory, independent run N+1 sees the update without
receiving run N's transcript, ordinary turns cannot read or write it, two
overlapping stale writers conflict instead of losing data, archive preserves
memory, purge removes it, and a memory failure cannot merge run transcripts.

### Phase 4 — Management UI and run inbox

Work:

- add the approved Scheduled navigation, inbox, task list, task editor, run
  detail, and memory editor;
- reuse the existing polling loop and browser-history routing;
- derive the unread badge from `pending_review`;
- default new tasks to fresh conversations while allowing an existing History
  conversation to be selected explicitly;
- expose every loading, empty, active, terminal, validation, conflict, and
  unavailable state.

Complete when the approved browser flow works with keyboard-only navigation:
create → edit → run now → inspect pending run → open exact conversation → mark
reviewed → edit memory → pause/resume → archive, with browser Back/Forward and a
clean console.

### Phase 5 — Notifications

Work:

- show the durable pending-review count in Scheduled navigation;
- add an explicit **Enable browser alerts** action and persist only that local
  preference in browser storage;
- notify only runs first observed entering `pending_review` after initial
  hydration;
- focus the exact inbox run when a notification is clicked;
- degrade to the in-app badge when permission is denied or unsupported.

Complete when notifications never fire for initial backlog hydration, reviewed
or archived runs, another owner, or the same observed transition twice; denied
permission leaves the inbox fully usable.

### Phase 6 — Verification and handoff

Work:

- run `nx run @deepagents/experimental:typecheck` and
  `nx run @deepagents/experimental:test`;
- run `nx run @deepagents/devtool:typecheck`,
  `nx run @deepagents/devtool:test`, `nx run @deepagents/devtool:lint`, and the
  package build/dry-run;
- run the browser flows for inbox, tasks, memory conflicts, notifications,
  responsive overflow, browser navigation, accessibility, and console errors;
- update the public README and the authoritative Zukhruf design text;
- record unrelated Nx baseline blockers separately rather than weakening the
  gates or mutating project inference during verification.

Complete when every phase criterion has current evidence, generated package
artifacts expose only public surfaces, and the continuation record names no
remaining required work.

## Non-goals

- hosted or remote devtool access;
- service-worker or closed-browser notification delivery;
- email, Slack, mobile push, or webhook delivery;
- automatic memory summarization or vector retrieval;
- implicit transcript inheritance between scheduled runs;
- worktree/project/model/permission editors without a concrete host adapter;
- RRULE visual authoring;
- aggregate analytics, charts, or schedule performance dashboards;
- changes to conversation-owned `CronCreate`, `CronList`, `CronDelete`, or
  `ScheduleWakeup`.

## Implementation rules

- Reproduce a failing public flow before each behavior change.
- Drive tests through package specifiers and public runtime/devtool surfaces.
- Reuse Hono, Zod, native browser APIs, the current polling loop, and current
  UI composition. Add no dependency unless those prove insufficient.
- Keep scheduler state authoritative; HTTP responses and browser state are
  projections.
- Preserve unrelated staged and unstaged work. Leave new changes unstaged
  unless the user explicitly authorizes staging in that turn.

## Exact next action

Obtain explicit approval or corrections for the wireframes and notification
scope. After approval, implement Phase 1 only.
