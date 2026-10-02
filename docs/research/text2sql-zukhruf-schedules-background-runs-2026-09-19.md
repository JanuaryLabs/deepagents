# Text2SQL → Zukhruf: schedules and background runs

Investigated 2026-09-19. This is a migration audit, not an implementation plan or authorization to migrate.

- Text2SQL/Limerence: `/Users/ezzabuzaid/Desktop/January/text2sql`, HEAD `b84e0f1d830840b9f36b20406a000e6ed8c591ad`.
- DeepAgents/Zukhruf: `/Users/ezzabuzaid/Desktop/January/deepagents`, HEAD `c356793ae2e8fecd6de5cd002ab9fcc612023de7`.
- Read current source, host wiring, UI, schemas, and installed pg-boss implementation. Ran the checks below. Existing unrelated working-tree files were preserved.
- **User decision: leave SQLite versus embedded PGlite for desktop undecided.**

## Finding

Zukhruf already implements durable background turns and a substantial scheduled-task system. Missing cron infrastructure is not the migration blocker. The work is preserving Limerence's execution context, team access, source dependencies, and visible behavior while replacing its chat execution path.

Use host-owned `schedules()` / `ScheduledTasks<T>` as the comparison target. `conversationScheduling()` is a different feature: it resumes the existing conversation, allows at most 50 cron definitions per conversation, and recurring definitions have a seven-day lifetime. Its dynamic wake-up tool accepts delays of 60–3,600 seconds. It is unsuitable as a direct replacement for long-lived Limerence automations.

Evidence: [conversation scheduler](../../packages/experimental/src/zukhruf/plugins/conversation-scheduling/conversation-scheduler.ts), lines 10–12, 134–175; [conversation tools](../../packages/experimental/src/zukhruf/plugins/conversation-scheduling/tools.ts), lines 49–66, 96–193.

## How Limerence currently works

```text
Automation UI or CreateAutomation client-tool form
  → POST /automations
  → validate team, Space, attached source IDs, cron and timezone
  → persist Automation + AutomationSource
  → queue.schedule("automation-run", cron, { automationId })

Due occurrence
  → runScheduledAutomation loads the current Automation
  → skip if missing or disabled
  → runs.begin(Space, creator user, work profile, automation attribution, prompt)
  → create fresh ChatSession
  → register stream
  → enqueue "chat-run"
  → getDataAgent → Space/user sandbox, model, knowledge, tools and profile
  → run and persist UIMessage stream
  → inspect result / resume stream / continue the resulting chat
```

1. **An automation is a saved prompt plus a schedule and product context.** Its row stores `spaceId`, `createdByUserId`, `name`, `prompt`, five-field cron, timezone, and `enabled`. `AutomationSource` stores its required source IDs, names and availability. Routes enforce team membership through the Space and require at least one attached source.
2. **Each occurrence starts a new chat.** `runs.begin()` generates a fresh chat ID, creates a `ChatSession` with `automationId`, then `ChatHandle.send()` registers a fresh stream and enqueues the message. Failed admission cleans up the new stream/session.
3. **Scheduled and manual execution use different actors.** Scheduled execution uses the automation creator. “Run Now” uses the requesting user. Both use `context: 'work'`; scheduling does not automatically select the dashboard/report builder profile. Manual runs are allowed while an automation is disabled, subject to source validation.
4. **All chat execution is already background work.** Interactive requests enqueue and watch a persistent stream. Browser disconnection is not execution cancellation. Workers compose the actual agent from the Space, user, optional model override, profile, tools, elements and sandbox. Desktop workers still need the application process: Electron drains/stops the backend on quit (`apps/desktop/electron/src/main/index.ts:1854`). Persistent schedules do not themselves wake a quit application or sleeping machine.
5. **Run history is chat history.** `/automations/:id/runs` lists attributed `ChatSession` rows. The automation UI opens those chats. The run-group UI uses session `activeStreamId` to separate active from non-active results; it has no separate scheduled-run review ledger.
6. **Source removal changes automation behavior.** Detaching a source marks its provenance unavailable, disables affected automations and unschedules them. Re-enabling or manually running validates the dependencies again. Actual source use can add provenance during a run.

Source map (paths below are in the Text2SQL checkout):

| Mechanism                                                     | Source                                                                                                          |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Automation persistence                                        | `packages/persistence/db/models/automation.prisma:1`                                                            |
| Team/Space/source validation; CRUD; manual execution; history | `apps/backend/src/routes/automations.route.ts:15`, `:121`, `:205`, `:284`, `:329`                               |
| Scheduler registration and occurrence dispatch                | `apps/backend/src/core/background/automation-worker.ts:12`                                                      |
| Fresh session and rollback                                    | `packages/harness/runs/src/index.ts:72`                                                                         |
| Stream admission, continuation, watch/status/cancel           | `packages/harness/runs/src/chat.ts:57`                                                                          |
| Complete background payload                                   | `packages/harness/runs/src/job.ts:9`                                                                            |
| Worker composition and persisted outcome                      | `apps/backend/src/core/background/chat-worker.ts:56`                                                            |
| Per-run Space/model/profile resolution                        | `packages/harness/runtime/src/lib/data-agent.ts:204`; `apps/desktop/backend/src/core/background/sandbox.ts:300` |
| Source provenance and automatic disabling                     | `apps/backend/src/core/source-provenance.ts:3`, `:74`; `apps/backend/src/routes/spaces.route.ts:1109`           |
| Human-reviewed client-tool creation and browser timezone      | `packages/genui/tools/src/lib/tool-create-automation.tsx:65`, `:95`, `:292`                                     |
| Automation results UI                                         | `apps/desktop/frontend/src/app/routes/Automations/Automations.tsx:305`, `:636`                                  |

The desktop automation routes are equivalent to the server routes apart from database/auth typing. The v2 automation worker has the same execution logic with its own Prisma client. Do not assume the three applications are different scheduling products.

## Host and failure behavior

| Concern                     | Text2SQL today                                                                                                               | Zukhruf today                                                                                              | Migration implication                                                        |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Server queue                | `BackgroundQueue` backed by pg-boss/Postgres                                                                                 | `PgBossTurnQueue`; scheduled tasks use pg-boss and transactional Postgres tables                           | Existing technology fit, different contracts                                 |
| Desktop queue               | Native `node:sqlite` implementation                                                                                          | No production SQLite `TurnQueue` or SQLite `ScheduledTasks` implementation found; demo uses pg-boss/PGlite | Database choice remains open; embedded operation already exists              |
| Timezone                    | Saved at creation from the browser; reused on boot                                                                           | Per-task timezone; five-field cron and DTSTART/RRULE recurrence                                            | Preserve existing cron + zone without converting to RRULE                    |
| Missed occurrences          | SQLite drops occurrences ≥60 seconds late; installed pg-boss scheduler sends only the preceding occurrence within 60 seconds | Materializes one overdue occurrence, then advances to the next future occurrence                           | **Behavior change; no skip-missed option in current ScheduledTasks options** |
| Same-chat concurrency       | Exclusive singleton rejects another in-flight chat job                                                                       | Strict FIFO queues later turns; approval can park them                                                     | Busy errors become queued work unless host preserves old admission policy    |
| Automation overlap          | Singleton protects automation dispatch; each resulting chat has a different key, so complete runs can overlap                | Fresh-conversation occurrences may overlap; existing-conversation turns serialize                          | Do not interpret the old automation singleton as a whole-run overlap lock    |
| Chat retries                | `retryLimit: 0`, 30-second heartbeat, 30-minute expiry                                                                       | Ordinary turn retry limit zero; dead-letter/orphan handling, heartbeat; special continuation recovery      | Neither promises arbitrary mid-tool exactly-once replay                      |
| Automation dispatch retries | Two retries on the dispatch queue; fresh random chat per `runs.begin()`                                                      | Stable run identity, occurrence uniqueness, idempotent executor contract                                   | Stronger dispatch identity available, but adapters must honor it             |
| Crash reconciliation        | At boot, fail stale active chat jobs and orphaned queued/running streams; keep created/retry jobs                            | Queue dead letters report orphaned turns; runtime settles streams and continuation state                   | Verify actual process-crash behavior before production cutover               |
| Schedule/queue consistency  | App row and queue schedule are separate writes; desktop re-registers enabled schedules at boot                               | Task/run state and scheduled queue jobs written in one supplied transaction                                | Keep product mappings consistent with scheduler state too                    |
| Run lifecycle               | Chat + stream state                                                                                                          | Scheduled run has dispatching/running/completed/failed/cancelled plus separate review status               | Map run IDs to product chats and preserve result navigation                  |
| Management                  | CRUD, enabled flag, Run Now                                                                                                  | Create/update/pause/resume/archive/purge, Run Now, cancel run, review/archive result                       | Mostly covered or expanded; deletion/archival meaning must be deliberate     |
| Live result changes         | Product session/stream queries                                                                                               | Owner-scoped schedule events and HTTP projection                                                           | Existing UI/generated client still require integration                       |

Text2SQL evidence: `apps/backend/src/startup.ts:31`, `apps/desktop/backend/src/startup.ts:38`, `apps/backend/src/core/background/chat-streams.ts:52`, `apps/backend/src/core/background/stream-recovery.ts:48`, `apps/desktop/backend/src/core/background/automation-worker.ts:31`, `packages/queue/sqlite/src/index.ts:718`, `:775`, and installed `node_modules/pg-boss/dist/timekeeper.js:135`.

Zukhruf evidence: [queue contract](../../packages/experimental/src/zukhruf/queue/turn-queue.ts), lines 90–120; [pg-boss queue](../../packages/experimental/src/zukhruf/queue/pg-boss.turn-queue.ts), lines 25–48, 109–125, 232–309; [orphan handling](../../packages/experimental/src/zukhruf/runtime/agent-runtime.ts), line 632; [ScheduledTasks](../../packages/experimental/src/zukhruf/plugins/schedules/scheduled-tasks.ts), lines 20–79, 260–267, 398–478, 712–764, 934–1010, 1013–1100; [local stack](../../demo/zukhruf-schedules/stack.ts), lines 19–64.

## What is genuinely missing versus host integration

### 1. Carrying Limerence execution context: built-in plugin gap, existing lower-level seam

The built-in `schedules()` execution config accepts only a fresh/existing conversation target and rejects unknown fields. Its launcher submits the prompt plus Zukhruf scheduling provenance. It does not create Limerence `ChatSession` attribution or accept `spaceId`, run profile, model selection, artifact IDs or source dependencies.

The lower-level exported **`ScheduledTasks<ExecutionConfig>` already supplies the appropriate extension point**: a JSON execution config and `launch` / `inspect` / `cancel` adapter. A Limerence integration can bind its product context there; a new generic scheduler abstraction is unnecessary. `launch` must be idempotent by `runId`: calling today's random-ID `runs.begin()` without changing the identity handling does not satisfy that contract.

For the wider background-run migration, Zukhruf's model comes from the agent declaration. `TurnRequest` supports UIMessage, client tools and elements, but not Limerence's `modelId` override or profile fields. The host must resolve this mapping explicitly; a direct payload rename loses behavior. Zukhruf's sandbox factory receives `chatId` and `userId`, so Space/attribution must be durably resolvable before the sandbox is opened.

Evidence: [schedule config and launcher](../../packages/experimental/src/zukhruf/plugins/schedules/index.ts), lines 30–43, 263–302, 415–450; [generic adapter](../../packages/experimental/src/zukhruf/plugins/schedules/scheduled-tasks.ts), lines 203–237; [agent declaration](../../packages/experimental/src/zukhruf/agent.ts), lines 16–44; [turn payload](../../packages/experimental/src/zukhruf/queue/turn-queue.ts), lines 7–26; [executor](../../packages/experimental/src/zukhruf/runtime/agent-turn-executor.ts), lines 155–158, 193.

### 2. Ownership and actor identity: migration blocker to resolve

Limerence automation management is team-scoped through Space. Scheduled work executes as the creator; manual work executes as the requester. Existing chats can be opened through team-scoped product routes. Zukhruf's built-in scheduled task owner also becomes the conversation's user, and its directory rejects access using a different user identity.

Preserve authorization, execution identity, user memory and credentials separately. Merely substituting `teamId` for `userId` would change the meaning of the execution principal. This needs a host identity design or a focused runtime seam, not removal of the owner checks.

Evidence: Text2SQL `apps/backend/src/routes/automations.route.ts:70`, `:342`; `packages/harness/runs/src/index.ts:147`; Zukhruf [executionConversation](../../packages/experimental/src/zukhruf/plugins/schedules/index.ts), line 400; [owner check](../../packages/experimental/src/zukhruf/control-plane/agent-directory.ts), line 170.

### 3. Source dependency safety: retain in Limerence

Zukhruf has no concept of an attached data source becoming unavailable. Preserve required-source validation, provenance recording, disable/unschedule on detach, and revalidation on manual run/re-enable. These are product responsibilities; adding them to the generic scheduler would couple it to Limerence.

### 4. Missed-run policy: real behavioral gap if parity is required

Example: an every-six-hours automation sleeps through 06:00 and 12:00, and the app returns at 14:00. Current SQLite scheduling produces no catch-up run and next fires at 18:00. Zukhruf produces one catch-up run for the overdue occurrence. Both implementations were exercised in this audit.

Choose the intended product behavior before migration. If skip-missed remains required, the generic scheduled-task API needs an explicit policy; it currently exposes none. This choice is independent of SQLite versus PGlite.

### 5. Browser interaction and unattended execution: transport exists, policy differs

Zukhruf already carries client-declared tool schemas, complete UI messages and element catalogs. Do not record browser tools as wholly missing. Limerence's CreateAutomation form performs the product write after user review, then returns `addToolOutput`; keep that interaction rather than replacing it with autonomous `CronCreate`.

The built-in schedule inspector turns a completed stream containing `approval-requested` into a failed scheduled run with “requires interactive tool approval.” Limerence exposes `needsReply` on chat status and supports later continuation. Decide whether an automation requiring input should fail, wait, or remain a resumable chat, and test the selected behavior. This is a scheduled-run result policy difference; ordinary Zukhruf approvals are supported.

Evidence: [client tool transport](../../packages/experimental/src/zukhruf/plugins/http/index.ts), lines 99–114; [scheduled approval policy](../../packages/experimental/src/zukhruf/plugins/schedules/index.ts), lines 331–358; Text2SQL `packages/harness/runs/src/chat.ts:170`.

### 6. Existing records and visible results: explicit data/API mapping

Limerence automation IDs are CUIDs; the built-in schedule HTTP API validates UUID task/run IDs. Limerence stream IDs originate from user messages/random UUIDs; Zukhruf derives conversation-scoped `zukhruf-turn:…` IDs and checks their ownership. Existing automation/chat links, history, continuation and cancellation cannot be migrated by renaming endpoints alone.

The old worker requests generated chat titles. Zukhruf's turn executor does not set `generateTitle`, so the shared chat implementation uses a static title. Its built-in scheduled executor also returns null title/summary. Preserve the desired history presentation explicitly; this is smaller than a scheduler gap.

Evidence: [HTTP IDs/projection](../../packages/experimental/src/zukhruf/plugins/schedules/http.ts), lines 60–89; [turn IDs](../../packages/experimental/src/zukhruf/control-plane/agent-turn-id.ts), lines 14–35; [executor chat call](../../packages/experimental/src/zukhruf/runtime/agent-turn-executor.ts), lines 264–276; [title behavior](../../packages/context/src/lib/chat.ts), lines 203–225; Text2SQL worker `apps/backend/src/core/background/chat-worker.ts:104`.

### 7. Connector refreshes: a separate background workload

The desktop and v2 backends also register `connector-pull` jobs. Desktop refreshes have source-level deduplication, two retries, startup recovery, re-registration and a pull on boot. They build a replacement SQLite file and rename it into place, then update connection status. These jobs do not invoke an agent.

Retain them as ordinary product jobs. Zukhruf can replace agent-turn execution without replacing the complete `BackgroundQueue` abstraction. Do not manufacture LLM turns for connector refreshes.

Evidence: Text2SQL `apps/desktop/backend/src/core/background/connector-pull-worker.ts:25`, `:54`, `:90`, `:192`, `:213`; `apps/desktop/backend/src/startup.ts:50`.

## Verification and limits

- Standard focused `nx run @deepagents/experimental:test` could not start its PostgreSQL global setup: `Docker is required for container-backed tests`. No PostgreSQL competing-worker claim is treated as freshly verified.
- Re-ran the same Nx target with its command overridden to omit container global setup and exclude the two `real PostgreSQL` cases. **17 tests passed**, covering occurrence deduplication, one catch-up/overlap, task management, owner isolation, cancellation during launch, idempotent launch retry, transaction rollback, queued coordinator restart, drain behavior, HTTP discovery/events, fresh/existing conversations and explicit review state.
- These tests use PGlite, a fake generic executor, and (for HTTP tests) a controlled turn queue/mock model. They verify the scheduled-task lifecycle and HTTP/runtime integration, not real provider execution or multi-process turn recovery.
- A separate in-memory probe imported the current Text2SQL SQLite queue source. It asserted zero jobs at 14:00 after missed six-hour slots, then one job at 18:00:10. Passed. No application data was opened.
- No migration code or product behavior changed.

Reproduce the local Zukhruf verification from the DeepAgents root:

```sh
NX_DAEMON=false nx run @deepagents/experimental:test --outputStyle=static \
  --command='node ../../tools/src/run-node-tests.ts /tmp/zukhruf-schedules-pglite-tests.xml --test-timeout=60000 --test-force-exit --test-skip-pattern="real PostgreSQL" src/zukhruf/plugins/schedules/scheduled-tasks.integration.test.ts src/zukhruf/plugins/schedules/schedules-http.integration.test.ts'
```

## Checks required before migration

1. Schedule a Space automation with source dependencies and a saved timezone; verify fresh-chat attribution, correct user credentials/memory and result navigation.
2. Run it manually as another authorized team member; verify intended actor identity and shared access without weakening isolation.
3. Detach a required source; verify it disables/unschedules, and manual execution/re-enable rejects invalid dependencies.
4. Stop/restart across a due time; assert the chosen missed-run policy. Keep desktop database selection open until separately decided.
5. Submit duplicate run requests and crash between external launch and schedule acknowledgement; verify the same run/chat is recovered without duplicate side effects.
6. Exercise busy chats, cancellation, browser reconnect, tool output, approval/needs-reply and existing-history continuation against the product UI.
7. Exercise model/profile selection and dashboard/report completion behavior across the shared run path, then verify connector refreshes still operate independently.

Start by proving this product-to-runtime boundary through the existing public APIs. The current source does not justify rebuilding scheduling or adding a universal job framework.
