# Map: Codex-style standalone Scheduled Tasks for Zukhruf

Status: scheduling foundation implemented; devtool product continuation moved
to [`packages/devtool/plans/scheduled-tasks.md`](../../packages/devtool/plans/scheduled-tasks.md).

## Destination

Provide a host-owned Scheduled Tasks feature in which every due occurrence remains traceable through a durable run ledger. By default a run creates an independent root conversation; an explicit existing-conversation target instead enqueues into that owner-scoped conversation.

This feature must live alongside the current Claude Code-compatible scheduling primitives. It must not reinterpret `CronCreate`, `CronList`, `CronDelete`, or `ScheduleWakeup`, which remain agent-owned scheduling inside an existing conversation.

## Notes

### Standing product decisions

- This is a new feature, not a v2 or replacement for the current scheduler.
- A Scheduled task belongs to the host/product, not to an active conversation.
- Every occurrence creates a fresh root conversation by default. Targeting an existing conversation is explicit and intentionally reuses that conversation's transcript.
- Fresh-root cross-run memory, if supported, is an explicit resource rather than implicit chat history.
- The existing `WakeScheduler` may be reused as the clock only if its public contract fits; the new product domain must not be forced into the existing conversation-scoped coordinator.
- The durable scheduling and fresh-session foundation is implemented in `@deepagents/experimental/zukhruf`. Product UI remains separate.

### Working language

- **Conversation Schedule**: the existing agent-owned mechanism that delivers a future ask into the same conversation.
- **Scheduled Task**: a host-owned recurring or one-shot definition containing a prompt and recurrence.
- **Scheduled Occurrence**: one intended due instant produced by a Scheduled Task.
- **Scheduled Run**: the durable execution record for one occurrence.
- **Run Conversation**: the fresh root conversation created for a Scheduled Run by default, or its explicitly configured existing conversation.

### Current implementation boundary

- [`packages/experimental/src/zukhruf/SCHEDULING_PLAN.md`](../../packages/experimental/src/zukhruf/SCHEDULING_PLAN.md) documents the implemented conversation-owned scheduler and explicitly leaves customer automation outside its scope.
- [`packages/experimental/src/zukhruf/DESIGN.md`](../../packages/experimental/src/zukhruf/DESIGN.md) remains authoritative for current Zukhruf runtime and scheduling behavior.
- The host supplies callbacks for fresh-session launch, exact-turn observation, and exact-turn cancellation.
- Existing staged and unstaged work is unrelated working state and must remain untouched when this map is implemented.

### Codex Scheduled reference behavior

Research against the installed Codex app and official documentation found this reference shape:

1. The host notices a due standalone schedule.
2. It creates a persistent run record.
3. It creates a fresh root task/conversation with automation provenance.
4. It supplies the saved prompt as the first turn using the configured project, isolation, model, reasoning, and permission settings.
5. The conversation runs independently.
6. Terminal execution updates the run and exposes it in a Scheduled inbox for review.

Other useful reference behaviors are one collapsed catch-up after downtime, optional worktree isolation, explicit cross-run memory, pause/edit/delete/run-now management, and persistent run history. These are evidence, not automatically accepted Zukhruf requirements; the child tickets decide the product contract.

Reference documentation:

- [Codex automations](https://learn.chatgpt.com/docs/automations)
- [Codex Git worktrees](https://learn.chatgpt.com/docs/environments/git-worktrees)

## Accepted design (2026-08-16)

- Scheduled Tasks are a separate host-owned domain; the conversation scheduler remains unchanged.
- Product-owned `scheduled_tasks` and `scheduled_runs` tables live in the same PostgreSQL database as pg-boss. PGlite runs that same schema locally and in tests. There is no SQLite implementation.
- pg-boss owns operational one-shot jobs through public `sendAfter()` and cancellation APIs. The product accepts RRULE or five-field cron plus an IANA timezone; pg-boss cron schedules are not used.
- A schedule contains a prompt and opaque host execution configuration. Every run snapshots the effective values. Repository, project, checkout, worktree, Codex, and Eve concepts belong only to optional host adapters.
- The AgentRuntime adapter defaults to a new root conversation and also accepts an explicit owner-checked existing-conversation target.
- The host adapter launches idempotently with the stable run ID, inspects an external execution by ID, and cancels it. Zukhruf stores only lifecycle and compact review metadata; the execution system owns complete output and artifacts.
- Occurrences use the durable identity `(scheduleId, scheduledFor)`. Product state changes and pg-boss job insertion commit in one database transaction. At-least-once job delivery therefore produces one run, while adapter idempotency prevents duplicate external execution.
- Missed recurring occurrences collapse into one catch-up. Runs may overlap. Run now is independent and never advances the recurrence cursor. Creating or editing a schedule never replays dates before that operation.
- Pause, resume, edit, and archive affect future occurrences only. A running execution is canceled only through the explicit run-cancel operation. Archiving a schedule preserves its runs and external executions; permanent history removal is a separate explicit operation.
- A failed run does not pause later occurrences. Execution status and review status are orthogonal, with terminal runs entering pending review before they may be reviewed or archived.
- Every public operation is scoped by an opaque host-authenticated owner ID. Fresh-root cross-run memory is explicit; an existing-conversation target deliberately uses that conversation's history.

## Dependency-ordered implementation

1. Replace the uncommitted SQLite control plane with the PostgreSQL/PGlite task and run schema plus public host contracts.
2. Use pg-boss transaction-bound `sendAfter(..., { db })` for occurrence, dispatch, and reconciliation jobs; leave the generic conversation `WakeScheduler` unchanged.
3. Implement atomic schedule creation, occurrence deduplication, cursor advancement, one-catch-up recurrence, and independent Run now.
4. Implement generic idempotent launch, inspection, cancellation races, and crash/restart reconciliation.
5. Implement pause, resume, edit, schedule archive, explicit purge, and orthogonal run review operations.
6. Prove behavior through the public package boundary on PGlite and real PostgreSQL, including rollback, competing workers, duplicate delivery, launch crash, restart, overlap, cancellation, and ownership isolation.
7. Run `nx run @deepagents/experimental:typecheck` and `nx run @deepagents/experimental:test`, recording unrelated baseline failures separately.

## Implemented host surface

- Top-level `agent/schedules/*.md` files synchronize into the standalone control plane at startup.
- Each file uses strict `cron` and `timezone` frontmatter and its Markdown body as the prompt.
- The `schedules` AgentRuntime plugin launches each occurrence as a fresh root task by default; `ScheduleExecutionConfig.target` may explicitly select an owner-scoped existing conversation.

## Devtool product continuation

The dependency-ordered HTTP management, run inbox, cross-run memory,
notification, and UI work now lives in the tracked
[`packages/devtool/plans/scheduled-tasks.md`](../../packages/devtool/plans/scheduled-tasks.md)
plan. This scratch map remains the historical foundation and accepted scheduler
contract; it is not a second implementation tracker for the devtool work.

Concrete adapters for Codex, Eve, or execution systems other than
`AgentRuntime` remain outside that devtool plan.

## Out of scope

- Changing or removing the existing Claude Code-compatible model-facing scheduling tools.
- Implementing `/loop`.
- Proactive delivery to external channels such as email, Slack, or push notifications.
- Generalizing arbitrary subagent declarations into schedules.
- Copying Codex's internal implementation where a smaller public Zukhruf boundary is sufficient.
