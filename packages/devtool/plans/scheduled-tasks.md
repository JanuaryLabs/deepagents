# Scheduled Tasks in `@deepagents/devtool`

Status: implemented in the working tree. The scheduler exposes an optional,
definition-bound HTTP projection; the DevTool discovers that capability and
provides the routed management and pending-review workspace. The completed
implementation handoff is
[`../../../.scratch/devtool-scheduled-tasks/map.md`](../../../.scratch/devtool-scheduled-tasks/map.md);
this file records the shipped contract and remaining verification.

## Outcome

The local Scheduled Tasks surface in `@deepagents/devtool` provides:

- create, edit, pause, resume, archive, purge, and run tasks;
- review and cancel durable runs from one owner-wide inbox;
- open the exact conversation and turn behind a run;
- show durable pending-review counts.

Cross-run memory and browser alerts were explored here but remain outside the
implemented first useful core.

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
  routes under the injected document base, a persistent History sidebar, and a
  capability-gated Scheduled workspace with three-second polling.
- `schedulesHttp(scheduled)` contributes strict owner-scoped task, run, and
  pending-review routes plus `capabilities.schedules`. Omitting the projection
  removes both the capability and Scheduled navigation.
- Generated run titles and summaries remain out of scope. The workspace uses
  task names, run state, timestamps, errors, and exact conversation references.
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
- [`../../experimental/src/zukhruf/plugins/schedules/http.ts`](../../experimental/src/zukhruf/plugins/schedules/http.ts),
  [`../host/ui/src/routes/scheduled.tsx`](../host/ui/src/routes/scheduled.tsx),
  and [`../host/ui/src/app/schedules-data.ts`](../host/ui/src/app/schedules-data.ts)
  — the optional HTTP projection, routed workspace, and browser data boundary;
- [`ui-components.md`](ui-components.md) — current repository UI topology and
  the approved Limerence component-reuse seam;
- [`../../../TEST_PRIMITIVES.md`](../../../TEST_PRIMITIVES.md) — repository test
  primitives and public-boundary rules;
- [`../../../.scratch/codex-scheduled-tasks/map.md`](../../../.scratch/codex-scheduled-tasks/map.md)
  — historical scheduler decisions and Codex reference boundary;
- [`../../../.scratch/devtool-scheduled-tasks/map.md`](../../../.scratch/devtool-scheduled-tasks/map.md)
  — current implementation handoff for the first useful core.

## Ownership and boundaries

### Scheduler package owns

- authoritative task, run, and review state;
- owner-scoped control operations;
- occurrence/run idempotency and transaction boundaries;
- AgentRuntime execution provenance and exact conversation references;
- the definition-bound `schedulesHttp()` projection, request validation, and
  browser-safe read models.

### Devtool package owns

- capability-gated Scheduled navigation;
- the management, per-task runs, and pending-review UI;
- polling and browser navigation over the discovered capability URL.

### Host owns

- the `schedules()` definition and its PostgreSQL/PGlite capability bindings;
- authenticated `userId` assignment;
- explicit composition of `schedulesHttp(scheduled)` when scheduling should be
  available.

Composition stays explicit:

```ts
const scheduled = schedules(scheduleOptions);
const root = defineAgent({
  // model, sandbox, instructions, ...
  plugins: [scheduled],
});

const runtime = new AgentRuntime(root, {
  ...runtimeOptions,
  bindings: [
    schedulesCapabilities.boss.bind(boss),
    schedulesCapabilities.transaction.bind(transaction),
  ],
});

app.route('/zukhruf/v1', http(runtime, schedulesHttp(scheduled)));
app.route('/devtool', devtool({ protocolPath: '/zukhruf/v1' }));
```

No live schedule controller enters `devtool()`. `schedulesHttp()` binds the
installed definition to an explicit HTTP projection, while the static DevTool
app remains transport-neutral and discovers only the resulting capability URL.

The browser never supplies or overrides `userId`. A remote listener,
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
- Generated run titles and summaries are not required; do not parse arbitrary
  assistant prose with title/summary heuristics.
- Archiving a task preserves its runs. Purging an archived task removes the
  task and retained runs. A running task cannot be purged.

## Implemented HTTP surface

All responses use `Cache-Control: no-store`. Inputs are validated with Zod.
The authenticated Zukhruf host supplies `userId`. Missing and foreign IDs return
the same `404` shape.

| Method   | Route                              | Purpose                                     |
| -------- | ---------------------------------- | ------------------------------------------- |
| `GET`    | `/schedules/tasks`                 | List retained task definitions              |
| `POST`   | `/schedules/tasks`                 | Create with an idempotency key              |
| `GET`    | `/schedules/tasks/:taskId`         | Read one task                               |
| `PATCH`  | `/schedules/tasks/:taskId`         | Edit definition fields                      |
| `POST`   | `/schedules/tasks/:taskId/pause`   | Pause future occurrences                    |
| `POST`   | `/schedules/tasks/:taskId/resume`  | Resume from now                             |
| `POST`   | `/schedules/tasks/:taskId/run`     | Run now with an idempotency key             |
| `POST`   | `/schedules/tasks/:taskId/archive` | Archive future occurrences                  |
| `DELETE` | `/schedules/tasks/:taskId`         | Purge an already-archived inactive task     |
| `GET`    | `/schedules/tasks/:taskId/runs`    | List one task's runs                        |
| `GET`    | `/schedules/runs/inbox`            | List owner-wide pending-review runs         |
| `GET`    | `/schedules/runs/:runId`           | Read one run and its conversation reference |
| `POST`   | `/schedules/runs/:runId/cancel`    | Cancel an active run                        |
| `POST`   | `/schedules/runs/:runId/review`    | Mark a terminal run reviewed                |

The table paths are relative to the authenticated Zukhruf protocol mount.
Discovery advertises the capability only when the host composes
`schedulesHttp(scheduled)`; existing DevTool hosts remain unchanged when it is
absent.

## Implemented workspace reference

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

### Task management

```text
┌──────────────────────────────────────────────────────────────────────────────────────────────┐
│ Zukhruf Devtool                                                               ● Connected   │
├──────────────────────┬───────────────────────────────────────────────────────────────────────┤
│ [ History ] [Scheduled 3]                                                     [+ New task]  │
│                      │ SCHEDULED / TASKS                                                      │
│ INBOX             3  │ Monday report                    Active     [Run now] [•••]            │
│   Monday report      ├───────────────────────────────────────────────────────────────────────┤
│   Vendor monitor     │ [Overview] [Runs]                                                      │
│   Daily triage       │                                                                       │
│                      │ Name       [ Monday report                                      ]      │
│ TASKS             4  │ Prompt     [ Prepare the weekly engineering report.             ]      │
│ ┌──────────────────┐ │            [                                                     ]      │
│ │ Monday report   ●│ │ Schedule   [ 0 9 * * 1                ] [ Asia/Amman          ▾ ]      │
│ │ Next Mon 9:00 AM │ │ Target     [ New conversation                                  ▾ ]      │
│ └──────────────────┘ │                                                                       │
│   Vendor monitor   ● │                                                    [Save changes]      │
│   Daily triage     ‖ │                                                                       │
│   Cleanup          ○ │                                                                       │
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
- Keyboard focus, visible labels, error text, reduced motion, and native form
  semantics are acceptance requirements.

## Dependency-ordered phases

### Phase 0 — Contract and approval (complete)

Work:

- [x] approve the management and inbox UI structure;
- [x] approve the Limerence component seam after its source inventory;
- [x] use the authenticated Zukhruf `userId` as the owner boundary;
- [x] complete the scratch implementation handoff.

The approved contract is recorded in the completed implementation handoff.

### Phase 1 — Scheduler read model and run results (complete)

Work:

- [x] add an owner-wide pending-review query to the public schedule control;
- [x] expose the exact conversation/turn reference required to open a run;
- [x] persist scheduled provenance on the enqueued turn;
- [x] retain task name and run metadata as the first browser projection without
      parsing arbitrary assistant prose;
- [x] add competing-worker and duplicate-occurrence public-boundary proofs.

Complete when public package tests prove owner isolation, deterministic inbox
ordering, fresh/existing conversation references, run metadata, duplicate
delivery, and competing workers on PGlite and real PostgreSQL.

### Phase 2 — Schedules HTTP projection (complete)

Work:

- [x] add the explicit definition-bound `schedulesHttp(scheduled)` projection;
- [x] advertise the schedule capability and root URL through discovery;
- [x] implement the read and lifecycle routes in the table above;
- [x] preserve scheduler idempotency keys and lifecycle errors at the HTTP
      boundary;
- [x] keep static UI serving and trace routes unchanged when schedules are
      absent.

Complete when one devtool integration flow creates, edits, runs, cancels,
reviews, archives, and purges through HTTP, proves foreign IDs are not exposed,
and proves restart persistence through the real public package boundary.

### Phase 3 — Management UI and run inbox (implemented; browser verification pending)

Work:

- [x] add the approved Scheduled navigation, inbox, task list, task editor, and
      run detail;
- [x] reuse the existing polling loop and browser-history routing;
- [x] derive review work from `pending_review`;
- [x] default new tasks to fresh conversations while allowing an existing
      History conversation to be selected explicitly;
- [x] expose loading, empty, active, terminal, validation, conflict, and
      unavailable states.

Complete when the approved browser flow works with keyboard-only navigation:
create → edit → run now → inspect pending run → open exact conversation → mark
reviewed → pause/resume → archive, with browser Back/Forward and a clean
console.

### Phase 4 — Verification and handoff (in progress)

Evidence and remaining work:

- [x] focused schedules HTTP integration proves optional discovery, strict
      validation, task lifecycle, provenance, pending review, and both
      conversation targets;
- [x] DevTool host, UI, and traces lint, typecheck, build, and test targets pass;
- [ ] run the browser flows for inbox, tasks, responsive overflow, browser
      navigation, accessibility, and console errors.

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

Browser-smoke the implemented `zukhruf-schedules` demo across task management,
pending review, exact-conversation navigation, the `--no-schedules` absence
path, browser Back/Forward, responsive overflow, accessibility, and console
errors. No implementation phase remains.
