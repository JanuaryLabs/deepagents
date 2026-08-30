# Map: Scheduled Tasks in Zukhruf DevTool

Status: charted; all tickets resolved and implemented

## Destination

Produce an implementation-ready decision handoff for connecting host-owned
Scheduled Tasks to the generic Zukhruf DevTool through an optional HTTP
projection and a focused management workspace, proved by one DevTool-hosted
schedules demo.

The map is complete when a coding session can implement the useful core without
inventing product rules, transport boundaries, UI behavior, package ownership,
or acceptance evidence.

## Notes

- This map plans the work; it does not carry production implementation.
- Continue to use `/wayfinder`; use `/grilling` and `/domain-modeling` only for
  decisions that genuinely require the user, and `/prototype` for the focused
  UI ticket.
- A **Scheduled Task** is the existing host-owned definition and run-ledger
  domain. A **Conversation Schedule** is the existing model-facing mechanism
  that delivers a future ask into its current conversation. This effort changes
  only Scheduled Tasks.
- The accepted scheduler foundation remains documented in
  [`../codex-scheduled-tasks/map.md`](../codex-scheduled-tasks/map.md).
- [`../../packages/devtool/plans/scheduled-tasks.md`](../../packages/devtool/plans/scheduled-tasks.md)
  is supporting research, not the canonical map. It contains broader scope and
  stale pre-`projectHttp()` composition that this effort must not copy.
- The reusable composition target is a definition-bound projection shaped like
  `http(runtime, schedulesHttp(scheduled))`; the static `devtool()` Hono app
  remains transport-neutral and does not receive a live schedule controller.
- Schedule capability availability comes from HTTP discovery. DevTool hides
  Scheduled navigation when the capability is absent.
- Schedule HTTP operations use the authenticated Zukhruf request `userId`; no
  second owner option or identity system is introduced.
- The core covers UI-managed task creation and editing, pause/resume,
  archive/purge, Run now, per-task run history, an owner-wide pending-review
  inbox, explicit review/cancellation, and opening the exact run conversation.
- New tasks default to fresh conversations and may explicitly target an existing
  owner-scoped conversation.
- The first editor supports five-field cron plus an IANA timezone. Other
  recurrence forms may be displayed read-only.
- Inbox rows use task name, run state, timestamps, error, and exact conversation
  reference. Generated run titles and summaries are not required.
- Preserve the existing Limerence-style routed sidebar and browser navigation.
- The proof host is the schedules demo, composed through public package
  boundaries rather than demo-only control access.
- Ask the user only about real product choices or trade-offs. Repository facts,
  API discovery, and routine technical defaults belong to the agent.

## Decisions so far

<!-- Closed ticket decisions are indexed here by name. -->

- [Define the Scheduled Task and run read model](issues/01-define-scheduled-task-run-read-model.md) — Add one owner-wide pending-review query, project existing records into minimal browser views, derive exact conversation links without schema changes, and persist distinct Scheduled Task provenance through queued-message metadata.
- [Choose the schedules HTTP projection contract](issues/02-choose-schedules-http-projection-contract.md) — Export a definition-bound schedules HTTP subpath beside the plugin, advertise one optional authenticated capability root, and map strict owner-scoped lifecycle routes through typed domain errors.
- [Prototype the core Scheduled Tasks workspace](issues/03-prototype-core-scheduled-tasks-workspace.md) — Ship the user-supplied reference: one filtered searchable list beside a settings-style detail pane, with the pending-review inbox as a first-class list tab, raw cron plus a read-only prose line instead of a recurrence builder, and no notifications row.
- [Choose the DevTool schedules demo composition](issues/04-choose-devtool-schedules-demo-composition.md) — Use the existing `agent.ts` / `run.ts` / `server.ts` demo shape with one shared composition, install no `scheduleFiles()` source because file declarations revert browser edits and block startup after an archive, and prove absence with `--no-schedules`.
- [Choose implementation slices and acceptance gates](issues/05-choose-implementation-slices-and-acceptance-gates.md) — Five ordered slices with public-boundary integration coverage; the projection type-imports the domain and converts errors per call because separate build entry points duplicate classes and Hono resolves handler errors at the innermost frame.

## Not yet specified

Nothing remains for this destination. Two constraints discovered during
implementation are recorded in ticket 05 and bind any future work on this
surface: a subpath build entry point must type-import shared domain classes, and
Hono error categorisation must happen at the call site rather than in
middleware.

## Out of scope

- Cross-run Markdown memory.
- Browser, service-worker, desktop, email, Slack, push, or webhook notifications.
- Changes to `CronCreate`, `CronList`, `CronDelete`, `ScheduleWakeup`, or other
  model-facing Conversation Schedule behavior.
- File-managed schedules from `scheduleFiles()`, including their DevTool
  representation and lifecycle policy.
- Generated run titles or summaries.
- Remote-listener deployment, new authentication, or a multi-user DevTool
  product.
- A visual RRULE authoring tool.
- Execution adapters other than the existing Zukhruf `AgentRuntime` adapter.
