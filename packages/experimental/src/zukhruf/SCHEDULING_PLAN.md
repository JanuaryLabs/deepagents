# Zukhruf timed scheduling implementation plan

> Status: implemented and verified on 2026-08-14. Focused scheduling checks are green; the full
> package target retains the pg-boss FIFO and retention regressions recorded in Slice 0.
> On 2026-08-22 the complete capability moved behind the opt-in
> `@deepagents/experimental/zukhruf/conversation-scheduling` plugin. Persisted scheduling metadata,
> wake payloads, deterministic IDs, and model-facing behavior remain unchanged.
>
> Goal: add a portable durable one-shot wake substrate and the Claude-compatible model tools
> `CronCreate`, `CronList`, `CronDelete`, and `ScheduleWakeup`. The `/loop` skill is explicitly out of
> scope: it will later be an instruction layer over these tools.

## Scope

This plan delivers:

- a generic `WakeScheduler` port;
- a Node/Postgres `PgBossWakeScheduler` using pg-boss `sendAfter()`;
- conversation-scoped scheduling state in existing `ContextStore` metadata;
- fixed cron and dynamic one-shot coordination;
- the four agreed model-facing tools;
- lazily materialized, provenance-carrying scheduled asks through the normal Zukhruf turn path;
- receipt-first state transitions across the metadata/wake dual-write boundary;
- public-boundary integration coverage over PGlite and real PostgreSQL.

This plan does not deliver:

- the `/loop` or `/proactive` skill;
- slash-command parsing, a default loop prompt, or loop UI;
- a customer automation/schedule resource outside a conversation;
- model-selectable target conversations;
- arbitrary pause/resume of an in-progress model turn;
- Cloudflare Durable Object code;
- jitter, seconds-field cron, or backfilling every missed occurrence;
- public HTTP fields for scheduled origin.

## Verified starting point

- `TurnQueue` is the built durable execution-ordering authority. It accepts immediate work only and
  enforces strict FIFO per chat plus cross-chat concurrency.
- `AgentRuntime.enqueue()` is the correct path for a fired prompt: it derives conversation-scoped
  turn identity, registers the stream, and pushes an ask. `MailboxCoordinator` is not a timer and
  must not be reused for timed scheduling.
- `ContextStore.updateChat()` already provides an atomic synchronous metadata updater: SQLite uses
  `BEGIN IMMEDIATE`; PostgreSQL uses `SELECT ... FOR UPDATE`; SQL Server uses its transaction lock.
- The installed pg-boss 12.26.1 public API exposes `sendAfter()`. A local probe proved that a
  future-dated opaque job survives a PGlite-backed restart and fires when pg-boss cron scheduling is
  disabled. Deferred jobs use database time, normal queue priority, and at-least-once worker
  semantics.
- pg-boss `schedule()` is intentionally not the foundation. Its timekeeper has missed-tick,
  minimum-cadence, two-step forwarding, expiry, and cancellation semantics that do not match the
  agreed application contract.
- `cron-parser` 5.6.2 is installed in the workspace and handles five-field parsing, timezone-aware
  occurrence calculation, and one-year reachability validation. It is not currently owned by the
  experimental package and must become a direct dependency when used there.
- No human cron formatter is installed. `cronstrue` 3.24.0 provides TypeScript declarations and has
  no runtime dependencies; add it only to satisfy Claude's `humanSchedule` output contract.
- The local Claude Code 2.1.228 implementation confirms the exact tool names and shapes described
  below. Fixed `/loop` calls `CronCreate`; dynamic `/loop` calls `ScheduleWakeup`. The skill itself
  owns instructions, not execution.

## Required invariants

### Ownership and boundaries

- `WakeScheduler` knows only a stable wake ID, due time, and opaque serializable data.
- `ConversationScheduler` owns prompts, conversations, cron, recurrence, expiry, replacement,
  catch-up, and conversion to turns.
- `TurnQueue` remains the only authority for turn ordering and execution claims.
- `ContextStore` metadata is authoritative. Wake jobs are durable, disposable receipts.
- `PgBossWakeScheduler` requires a stable queue name. Replicas of one agent tree share it; distinct
  trees use distinct queues so a worker cannot claim another tree's wake.
- Scheduling tools bind to the runtime-supplied plugin turn context; tool input cannot select another
  user, chat, root, or child.
- The tools are injected only when `AgentRuntime` receives `conversationScheduling()` in `plugins`.
  Agent
  declarations do not repeat them and the raw wake port never enters model context.

### Model-facing contract

```ts
CronCreate({
  cron: string,
  prompt: string,
  recurring?: boolean, // default true
}): Promise<{
  id: string,
  humanSchedule: string,
  nextRunAt: number,
  timezone: string,
  recurring: boolean,
  warning?: string,
}>;

CronList({}): Promise<{
  jobs: Array<{
    id: string,
    cron: string,
    humanSchedule: string,
    nextRunAt: number,
    timezone: string,
    prompt: string,
    recurring?: boolean,
  }>,
}>;

CronDelete({ id: string }): Promise<{ id: string }>;

ScheduleWakeup(
  | { delaySeconds: number, reason: string, prompt: string }
  | { stop: true },
): Promise<{
  scheduledFor: number,
  clampedDelaySeconds: number,
  wasClamped: boolean,
  stopped?: boolean,
  cancelledWakeups?: number,
}>;
```

- Names and casing match Claude Code exactly.
- Zukhruf deliberately omits Claude's `durable` field. Every definition is durable and scoped to
  the current conversation.
- Zukhruf deliberately omits Claude's internal feature-gated `noop` input.
- A cron ID is a deterministic UUID unique within its conversation.
- `CronCreate` accepts exactly five cron fields, requires a match within the next year, resolves in
  the configured IANA timezone, and returns that exact occurrence and timezone without executing
  immediately. A one-shot whose next occurrence is in a later local calendar year also returns an
  explicit warning.
- A conversation may own at most 50 active cron definitions.
- `recurring: false` fires at the next match and deletes itself.
- Recurring definitions expire seven days after creation, after their final due occurrence.
- `ScheduleWakeup` accepts 60–3600 seconds and rounds valid fractional delays to whole seconds. A
  normal call replaces the conversation's previous dynamic wake. `{stop: true}` cancels dynamic
  state only.
- `reason` is retained for explanation/telemetry but is not injected into the fired prompt.
- `CronDelete` and dynamic stop prevent future firing; they do not cancel an already-enqueued or
  running turn.

### Firing and recovery

- Each occurrence has a deterministic identity derived from conversation, definition ID,
  generation, and intended fire time.
- A due prompt remains scheduling metadata while the conversation is running, queued, or
  approval-paused. Once eligible, exactly one catch-up becomes `kind: 'ask'` and
  `origin: 'scheduled'` in the same conversation.
- Scheduled origin is persisted in the user message metadata before queue cleanup, not left only on
  the pg-boss job.
- The materialized ask uses normal FIFO ordering. Work already waiting runs first; work arriving
  later cannot overtake it. Approval/continuation retain their separate protocol priority.
- Duplicate wake delivery or duplicate TurnQueue receipts may occur, but one deterministic stream ID
  prevents a second model execution.
- After downtime, one overdue occurrence may catch up. The coordinator then arms the next future
  match; it never expands all missed ticks.
- A definition becomes active only after its wake exists. Recurrence inserts its successor before
  enqueueing the occurrence and advancing metadata. Stale or unpublished receipts validate
  generation and due time against metadata before enqueueing and become no-ops.
- No process-local timer, recurrence cursor, or cancellation flag is authoritative.

## Target ownership

```text
AgentRuntime
├── AgentTurnExecutor
├── AgentControlPlane
├── MailboxCoordinator
└── conversationScheduling() plugin
    └── ConversationScheduler
        ├── ContextStore metadata.zukhruf.scheduling
        ├── WakeScheduler
        │   └── PgBossWakeScheduler
        ├── CronCreate / CronList / CronDelete
        └── ScheduleWakeup
```

Suggested files are deliberately few:

```text
packages/experimental/src/zukhruf/plugins/conversation-scheduling/
├── wake-scheduler.ts
├── pg-boss.wake-scheduler.ts
├── conversation-scheduler.ts
├── tools.ts
├── pg-boss.wake-scheduler.contract.test.ts
└── scheduling.integration.test.ts
```

Keep persisted-state parsing and small identity helpers with `coordinator.ts` until their size or
independent reuse proves a separate file necessary.

## Persisted shape

Store the resolved timezone with every cron definition so a later host configuration change does
not reinterpret existing work. `humanSchedule` is derived for tool output and need not be stored.

```ts
interface SchedulingState {
  cron: Record<
    string,
    {
      id: string;
      expression: string;
      prompt: string;
      recurring: boolean;
      timezone: string;
      createdAt: number;
      expiresAt: number;
      nextRunAt: number;
      generation: number;
    }
  >;
  dynamic?: {
    prompt: string;
    reason: string;
    createdAt: number;
    nextRunAt: number;
    generation: number;
  };
}
```

This lives at `chat.metadata.zukhruf.scheduling`. Treat it as an untyped persistence boundary:
validate every field when loading, fail closed on malformed reserved state, and
preserve unrelated `zukhruf` metadata during every atomic update.

The wake payload carries only enough opaque routing data for the coordinator to reload state:

```ts
interface SchedulingWake {
  conversation: ConversationId;
  kind: 'cron' | 'dynamic';
  definitionId?: string;
  generation: number;
  scheduledFor: number;
}
```

`WakeScheduler` remains generic over this data and does not inspect it.

## Receipt-first transition protocol

`ContextStore` and pg-boss cannot share one portable transaction. Correctness therefore comes from
authority, deterministic identity, and ordering rather than pretending the dual write is atomic.

| Failure boundary                                         | Required result                                                                                         |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Wake insertion fails during create/replace               | Metadata remains unchanged and the tool reports failure.                                                |
| Wake inserted, process dies before metadata publication  | The unpublished receipt reloads metadata and no-ops.                                                    |
| Definition deleted/replaced while old wake is claimed    | Handler sees the generation mismatch or absence and no-ops.                                             |
| Successor insertion fails                                | The current definition and occurrence remain untouched so pg-boss can retry the wake.                   |
| Successor inserted, process dies before occurrence claim | Retrying the current wake observes the same deterministic successor and occurrence identities.          |
| Handler claims occurrence, dies before enqueue           | The metadata-resident dispatch resumes the same deterministic enqueue.                                  |
| Handler enqueues occurrence, dies before clearing claim  | Retry or settlement re-enqueues the same turn ID and then clears the dispatch.                          |
| Multiple workers handle duplicates                       | Atomic metadata transition selects one state advance; deterministic turn identity prevents reexecution. |
| Runtime is down across several cron matches              | The durable wake produces one catch-up occurrence, followed by the next future match.                   |
| Delete/stop races with an already-enqueued turn          | Future wakes stop; existing turn remains under ordinary cancellation semantics.                         |

Do not add an outbox table or a second scheduling store. The existing atomic chat updater stores at
most one dispatching occurrence alongside active definitions; deterministic wake and turn IDs make
recovery idempotent. If startup scans become a measured bottleneck, add a store-native scheduled-chat
index then—not before.

## Execution slices

### Slice 0 — preserve and prove the baseline

#### Work

- [x] Record `git status --short` and preserve every unrelated staged and unstaged path.
- [x] Run the current experimental package typecheck and tests before edits.
- [x] Keep the existing red/known queue regressions distinct from scheduling work if they reproduce.
- [x] Re-run a minimal pg-boss `sendAfter()` probe only if the installed version changed from the
      verified 12.26.1 surface.

#### Verification

```sh
nx run @deepagents/experimental:typecheck
nx run @deepagents/experimental:test
```

#### Exit criteria

- Baseline failures are recorded before attribution.
- No unrelated index or working-tree content changes.

### Slice 1 — one-shot wake port and pg-boss adapter

#### Work

- [x] Add `Wake<T>`, `WakeScheduler<T>`, and the idempotent schedule/cancel/at-least-once consume
      contract.
- [x] Implement `PgBossWakeScheduler` on an explicitly named agent-tree queue using public `PgBoss` APIs only:
      `createQueue`, `sendAfter`, `work`, `cancel`, `findJobs`, and `offWork` as needed.
- [x] Keep the `PgBoss` instance borrowed; the caller still owns `start()` and `stop()`.
- [x] Use database-backed due time and normal polling. Do not create `setTimeout` state or use the
      pg-boss recurring timekeeper.
- [x] Make repeated insertion of the same logical wake idempotent and conflicting reuse fail
      explicitly.
- [x] Keep handler failure retryable; prove recovery after handler error and worker/process death.
- [x] Export the port and Node adapter from the Zukhruf barrel.

#### Behavioral proof

- [x] Contract suite covers future-not-early delivery, opaque data, duplicate schedule, cancel before
      claim, cancel/claim race, handler retry, disposal, and restart persistence.
- [x] Run the same core contract against PGlite and real PostgreSQL. Keep the real-Postgres path
      public and Docker-gated through existing test primitives.

#### Exit criteria

- No prompt, conversation, cron, recurrence, or TurnQueue type appears in the wake port.
- The adapter contains no custom SQL and works with pg-boss cron scheduling disabled.

### Slice 2 — conversation scheduling coordinator

#### Work

- [x] Add `ConversationScheduler` over `ContextStore`, `WakeScheduler<SchedulingWake>`, and the normal
      internal enqueue path.
- [x] Add strict persisted-state parsing at `metadata.zukhruf.scheduling` and preserve all sibling
      metadata keys.
- [x] Use `ContextStore.updateChat()` for create, delete, dynamic replace/stop, occurrence claim, and
      advancement.
- [x] Generate deterministic UUID cron, wake, and occurrence IDs with the repository's existing
      UUID primitives.
- [x] Validate the configured IANA timezone and persist the resolved value with each cron definition.
- [x] Implement create/list/delete, dynamic schedule/stop, wake handling, seven-day expiry, one-shot
      deletion, and one-occurrence catch-up.
- [x] Insert create/replacement wakes before publishing metadata and recurring successors before
      enqueueing their occurrence and advancing state.
- [x] Keep `humanSchedule` out of persistence; derive it at the tool boundary.

#### Behavioral proof

- [x] Public-runtime integration tests cover concurrent creates/deletes, replacement races, malformed
      reserved metadata, timezone stability, expiry, the 50-job cap, and current-conversation
      ownership.
- [x] Deterministic barriers reproduce every row in the receipt-first failure table before the final
      green implementation.

#### Exit criteria

- Metadata remains the only durable definition source.
- No wake payload contains a prompt or cron expression.
- No process-local map affects correctness.

### Slice 3 — Claude-compatible scheduling tools

#### Work

- [x] Add direct experimental-package dependencies on `cron-parser` and `cronstrue`.
- [x] Define strict Zod input/output schemas for `CronCreate`, `CronList`, `CronDelete`, and
      `ScheduleWakeup` with the agreed casing and fields.
- [x] Implement tool factories over `ConversationScheduler`; use `AgentToolContext.actor` to bind the
      current conversation without putting the raw wake port in tool context.
- [x] Inject all four tools alongside collaboration tools only when scheduling is configured.
- [x] Add scheduling tool metadata/namespace treatment consistent with existing runtime-owned tools.
- [x] Keep `durable`, `noop`, target conversation, queue policy, and origin absent from model input.
- [x] Preserve concise Claude-compatible success/error messages and result objects.

#### Behavioral proof

- [x] Drive tools through a real `AgentRuntime` model/tool loop, not direct calls to hidden classes.
- [x] Prove list/delete isolation between root, child, sibling, user, and separate runtime instances.
- [x] Prove invalid/unreachable cron, invalid timezone configuration, missing dynamic fields, clamping,
      replacement, stop, cap, and human-readable output.

#### Exit criteria

- A future `/loop` skill can be instructions only.
- An agent without scheduling configuration sees none of the four tools.

### Slice 4 — scheduled turn ordering and provenance

#### Work

- [x] Extend the trusted internal ask ref with scheduled origin and occurrence metadata; ordinary
      asks need no explicit origin.
- [x] Keep due occurrences in authoritative scheduling metadata while their conversation has active
      or queued work, then materialize one normal FIFO ask after settlement.
- [x] Enqueue each occurrence through `AgentRuntime`/`AgentControlPlane`, never by calling
      `TurnQueue.push()` directly.
- [x] Persist scheduled origin and schedule/occurrence identity in the created user message metadata
      by using the existing `user(UIMessage)` path.
- [x] Keep the public HTTP session validator strict `{input}` and make it impossible for a client to
      forge scheduled origin.
- [x] Make `AgentRuntime.work()` start both consumers and return one combined async disposable, while
      preserving the current lifecycle when scheduling is absent.

#### Behavioral proof

- [x] A due occurrence is not materialized during an active turn or while ordinary work is queued.
- [x] A 35-minute busy window over three ten-minute ticks produces one catch-up after queued user
      work, not three scheduled asks.
- [x] Once materialized, the scheduled ask retains normal FIFO position against later arrivals.
- [x] Duplicate wake and TurnQueue delivery produces one assistant execution and one durable
      scheduled-origin user message.
- [x] Cancelling an already-enqueued scheduled turn uses the existing observation/cancellation path.

#### Exit criteria

- `TurnQueue` remains the sole execution serializer.
- Scheduled provenance survives queue-job cleanup.
- Existing enqueue, mailbox, approval, and continuation ordering tests remain green.

### Slice 5 — restart and cross-process proof

#### Work

- [x] Add restart tests for every metadata/wake boundary using persistent PGlite where sufficient.
- [x] Add real-PostgreSQL multi-consumer tests for duplicate wake delivery and concurrent state
      advance; queue contracts cover FIFO settlement and approval/continuation ordering.
- [x] Prove one catch-up after downtime, successor re-arming, seven-day expiry, and cleanup of spent
      wake receipts.
- [x] Update `DESIGN.md`, package exports, and demo wiring examples to reflect the implemented status.
- [x] Leave `schedules/` directories out of the conversation-local tool slice; the later standalone
      Scheduled Tasks control plane owns file declarations without changing these runtime tools.

#### Verification

```sh
nx run @deepagents/experimental:typecheck
nx run @deepagents/experimental:test
nx run @deepagents/experimental:build
git diff --check
```

#### Exit criteria

- Focused and package-level checks pass, with unrelated baseline failures reported separately.
- The full accepted contract is observable through public runtime/tool behavior.
- No `/loop` skill, command parser, compatibility shim, or speculative platform adapter was added.

## Completion definition

Scheduling is complete only when:

- all four tools are available in configured runtimes and absent otherwise;
- fixed and dynamic schedules survive runtime/process restart;
- metadata/wake crashes cannot silently lose an active definition or execute an occurrence twice;
- fired prompts use the normal durable turn machinery with FIFO ordering and durable origin;
- current-conversation ownership and the 50-job/seven-day/60–3600-second bounds are enforced;
- PGlite and real-PostgreSQL integration coverage passes;
- `AgentRuntime.work()` owns one coherent disposable lifecycle;
- documentation clearly leaves `/loop` as a future skill over the finished primitives.

Nothing is staged or committed unless explicitly requested in the implementation turn.
