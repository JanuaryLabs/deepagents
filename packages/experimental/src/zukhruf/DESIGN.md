# zukhruf — Design

> Status: design notes from an exploratory session. Distinguishes **Built** (implemented + verified)
> from **Designed** (decided, not yet implemented) from **Open** (deliberately deferred).

## What zukhruf is

zukhruf is an **internal DSL for declaring an agent**, plus a **runtime that executes that
declaration as a background agent**. A `zukhruf/` directory is a self-contained _deployable unit_:
the file layout is the configuration.

It is built on `@deepagents/context` primitives (`agent()`, `ContextEngine`, `AgentSandbox`,
fragments, the `stream/` subsystem). It is **not** built on the legacy `@deepagents/agent`
(swarm/handoffs) package.

## First principle: declaration ⟂ runtime

The single most important rule. The thing that _describes_ an agent must be separate from the thing
that _runs_ it.

- **Declaration layer** (the DSL) — pure data, **zero side-effects**, depends on
  `@deepagents/context` for **types only** (never `agent()` / `ContextEngine` / `chat()`).
  Importing a declaration spins nothing.
- **Runtime layer** — the only code that touches the execution engine. Owns conversations,
  engines, sandboxes, durability, and lifecycle.

We rejected an earlier shape (`defineAgent(...).open().send()`) because it bolted runtime methods
onto the declaration. We also rejected the name "client" for the runtime — a client _consumes a
service_; this thing _executes a declaration_. It is the **runtime**.

## The three lifetimes

Every design question reduces to "which lifetime does this belong to?"

| Lifetime         | What                                                              | Backed by                                              |
| ---------------- | ----------------------------------------------------------------- | ------------------------------------------------------ |
| **Declaration**  | the agent spec (model, sandbox factory, instructions) — immutable | source files                                           |
| **Conversation** | one `(chatId, userId)` thread, across turns and restarts          | `ContextStore`                                         |
| **Turn**         | one durable run (a user message → the agent's response)           | `StreamStore` (in-flight), then committed to the chain |

Placement falls out of this: store → conversation, sandbox → conversation, stream → turn.

## Background-agent model: "conversation with long turns" _(Designed)_

zukhruf is not a request/response chatbot. It is a **conversation whose turns are durable
background runs**.

- A **turn is the durable run**, keyed by the reserved assistant message id
  (`engine.continue(input)` already returns it). `streamId == assistantId`.
- A turn may grind through many tool-steps and **outlives the client connection** — if the user
  leaves, the turn keeps running; on return they reconnect and observe.
- Turns **serialize per conversation** (at most one in-flight). This naturally dissolves the
  context-store concurrent-turn-loss risk — there is no interleaving to drop. It also forces a
  contract decision (see Open: mid-turn message).
- The executor is a **turn-executor**, not a perpetual brain: it wakes when a turn is queued,
  drives the loop to completion, commits, and sleeps. "Background" = the in-flight turn outlives the
  connection, _not_ that the agent never rests.
- Control: **cancel** (terminal) and **pause** (semantics Open). Each turn self-terminates (the
  agent loop ends), so runaway shrinks to "one turn runs long" — bound it with per-turn
  step/token/time caps (Open), not a global kill-switch.

Three roles: **enqueue** (on a user message — store input, register stream, return; executes
nothing) → **work** (a persistent executor drives the turn, persists, commits, marks terminal) →
**observe** (client watches the durable stream; comes and goes freely).

## Durability = stream durability _(Built)_

"Durability" here means **resumable streams**: a consumer can disconnect / reload / have its host
crash, then reconnect and resume an in-progress turn without re-running the model.

`@deepagents/context` ships the machinery (`StreamManager`, `StreamStore` [sqlite/postgres],
`ChangeSource` [polling / postgres-notify], `stream-buffer`) but it is **not wired into `chat()`** —
so the runtime does the wiring (`.framework/runtime.ts`).

Mechanism (now implemented in `send()` / `resume()`):

1. `streamId = assistantId` (from `engine.continue(input)`).
2. `streams.register(streamId)`.
3. `streams.persist(await chat(agent, { abortSignal }), streamId)` — **drives the model** and writes
   every chunk to the `StreamStore` (and, via `chat()`'s own callbacks, commits the final message to
   the `ContextStore`). It is **fire-and-forget**: `send()` awaits only `chat()`'s cheap setup, then
   returns; `persist()` keeps draining after the caller leaves. (`chat()` is async — awaiting the
   _stream_ is required; awaiting the _drive_ is not.)
4. consumers read `streams.watch(streamId)` — replays from seq 0, then tails live. Even the first
   consumer reads via `watch()`, so a mid-turn detach loses nothing.
5. reconnect = `resume()`: `headMessage()` → if the head assistant's stream row is non-terminal (or
   still has chunks), return `watch(head.id)`; else `null`.
6. cancel = two-layer: `manager.cancel(streamId)` flips store status; `persist`'s `onCancelDetected`
   aborts the turn's `AbortController`, which stops the model mid-call.

Durability comes from **decoupling generation from consumption** through the store: the model keeps
running even if every consumer drops; chunks pile up; a reconnecting `watch()` replays them. So even
the _first_ consumer reads via `watch()`, never the raw stream.

Two complementary stores:

- **ContextStore** — the durable _chain_ (final messages). The permanent record.
- **StreamStore** — the in-flight _chunks_ + status. Only needed to survive a disconnect mid-turn;
  cleanup-able after the turn completes. Its status field
  (`queued → running → completed/failed/cancelled`) **is the turn/job state machine.**

The store is **mandatory** — the caller must provide it; no in-memory default.

## Background executor: enqueue → work → observe _(Built)_

> Implemented on pg-boss (`.framework/queue/`). All decisions below are confirmed and shipped.

### Verified substrate (what `@deepagents/context` already provides)

- `engine.continue(user(input))` **persists immediately** — user message + empty assistant
  placeholder are committed to the ContextStore before it returns (`engine.ts` calls `save()`
  internally). Enqueue in process A / execute in process B needs nothing new on the enqueue side.
- The StreamStore status field is a real job state machine: `register()` → `queued`, `persist()` →
  `running`, terminal on complete/fail/cancel; `listStreamIds({status})` queries it;
  `persist()` early-returns on already-terminal (safe against double-drive of a finished turn).
- `persist()`'s cancel-watcher is the executor's abort hook — unchanged.

### The three gaps (where the design lives)

1. **Addressing** — a queued stream id doesn't say _which conversation_ it belongs to; nothing maps
   `streamId → (chatId, userId)`.
2. **Claiming** — `updateStreamStatus` is not compare-and-swap; N workers scanning `queued` would
   double-drive a turn. Per-conversation serialization needs an authority.
3. **Work entry point** — `send()` fuses enqueue+work in the caller's process. The core needs an
   `executeTurn(...)` the host adapter invokes on its own schedule.

### TurnQueue port _(Built — `.framework/queue/turn-queue.ts`)_

A zukhruf-owned port; StreamStore stays the generic turn state machine, the queue row carries the
zukhruf addressing **and the turn's input**. The port is **handler-shaped, not fetch-shaped**:
claiming, heartbeating, and settlement belong to the implementation (pg-boss does all three
natively; re-deriving them behind a `claim/heartbeat/complete` surface would fight the library).
On Durable Objects the port is **absorbed** (the actor invokes the handler directly).

```ts
interface TurnRef {
  streamId;
  chatId;
  userId;
  input;
}
abstract class TurnQueue {
  push(turn: TurnRef): Promise<void>;
  consume(
    handler: (turn, { signal }) => Promise<void>,
    options: { concurrency?; onOrphaned(turn, error) },
  ): Promise<AsyncDisposable>;
}
```

Contract: per chat at most ONE active handler, strict FIFO per chat, cross-chat concurrency; a
crashed handler/worker surfaces once through `onOrphaned` (no retry), then the chat unblocks.

### pg-boss implementation _(Built — `.framework/queue/pg-boss.turn-queue.ts`)_

`PgBossTurnQueue(boss /* borrowed */, {queue?})` on pg-boss v12 (all semantics live-verified):

- **`key_strict_fifo` policy + `singletonKey = chatId`** — per-chat serialization is structural:
  1 active per key, unlimited queued, strict push order, failed job blocks the key.
- **`retryLimit: 0`** — the stale-turn decision in config: a crashed turn is never silently re-run
  (its bash already executed); it dead-letters instead.
- **Heartbeats are the lease** — `heartbeatSeconds` + `work()`'s automatic heartbeat; the pg-boss
  monitor fails the job of a dead worker. No hand-rolled lease.
- **DLQ worker is the crash reconciler** — consumes `<queue>-dead`, calls `onOrphaned` (runtime
  flips the orphaned stream row to `failed`), then `deleteJob(sourceId)` unblocks the chat.

### Runtime API split _(Built — replaces the fused `continue()/send()`)_

```
enqueue (any short-lived process):
  enqueue({chatId,userId}, {id, input})            // id: REQUIRED caller-supplied unique string — the ask's identity
    → manager.register(id)                         // stream row: 'queued' (ON CONFLICT DO NOTHING)
    → queue.push({streamId: id, chatId, userId, input})  // job id = streamId; duplicate send → null
    → { id, stream: watch(id) }                    // caller may watch immediately

work (long-running executor process):
  runtime.work({concurrency?}) → queue.consume(executeTurn, {onOrphaned})
  executeTurn: stream terminal? skip (cancel-while-queued)
    → sandbox = decl.sandbox({chatId, userId})     // per-chat, attach-or-create; never disposed here
    → engine.set(user(input), assistant placeholder id=streamId); save()
    → chat() + AWAIT persist()                     // worker holds the job for the whole turn

observe (anywhere): { engine, resume(), cancel(streamId?) } — never spins a sandbox.
```

**Enqueue is idempotent on the turn id, and the id is caller-supplied by necessity.** Idempotency
is only achievable by the sender: the hop between caller and enqueue is the unreliable part, so
only the party _before_ that hop can mark two arrivals as the same ask. A runtime-minted id makes
dedup impossible by construction (every retry looks new). The id is any unique string (a client
message id, or `crypto.randomUUID()` absent a natural key).

**Division of labor: queue = at-least-once; runtime = exactly-once-per-turn.** The queue promises
"never lost, strict FIFO per chat, maybe delivered twice" — job ids are monotonic **UUIDv7** so the
`ORDER BY created_on, id` tiebreak follows push order (fixes FIFO ties on ms-resolution clocks
without timing hacks). Turn-level dedup lives in the runtime: `executeTurn` skips turns whose
stream row is terminal, before touching sandbox/chain/model. The stream row never expires — unlike
queue-side dedup by retained job rows, which silently ends at pg-boss's `deleteAfterSeconds`
(7-day default). So duplicates reattach, a post-completion resubmit replays the finished stream
(first input wins), and the register→push crack self-heals on retry — all backed by the store that
is already the turn's permanent state machine.

**The port contract is pinned by a behavioral test suite** (`queue/turn-queue.contract.ts`):
durability across consumers, duplicate-push safety (at-least-once: never lost, never concurrent,
never out of order), strict FIFO per chat, cross-chat overlap, concurrency cap, orphan-exactly-once

- chat unblock, and dispose/backlog-pickup — instantiated per implementation
  (`pg-boss.turn-queue.contract.test.ts` runs it on PGlite). Any new backend must pass it; a pg-boss
  upgrade that changes semantics fails it. It already caught one real coupling: pg-boss fetch orders
  by `created_on, id`, so same-millisecond pushes scrambled under random ids on ms-resolution clocks
  (PGlite) — which is why job ids are monotonic UUIDv7.

**Identity invariant (and its tripwire).** One id carries three identities: the request key ("this
ask"), the stream id ("this execution's chunk log"), and the assistant message id ("this chain
node"). This fusion is valid **only while a turn executes at most once** — which v1 guarantees by
construction (`retryLimit: 0`, no reopen, no regenerate). The moment a re-execution feature lands
(regenerate / reopen / retry), the cardinality becomes 1 ask : N attempts and these identities MUST
split (request key stays on the queue/dedup layer; per-attempt stream + assistant ids minted per
execution, with a discovery helper for resume — the shape Limerence uses because it has regenerate).

**The chain mutates at execution time, not enqueue time.** The queue carries the user message until
the turn runs. Enqueue-time `engine.continue()` would be wrong twice over: a queued turn-N+1's user
message would leak into turn N's prompt, and `chat()` streams into the chain HEAD placeholder —
which must be the running turn's, not the newest enqueued one. Consequence: queued-but-unstarted
turns are invisible to `resume()` (the enqueue caller holds their `watch()` stream instead), and a
turn cancelled while queued never enters the chain at all.

### Consequences

- **Mid-turn message contract resolved → queue.** Turn N+1 enqueued during turn N waits; strict
  FIFO per chat. Reject/interrupt remain possible later as enqueue-time policy.
- **Stale turn → mark failed.** Worker dies mid-turn: heartbeat lapses → pg-boss fails the job →
  DLQ → `onOrphaned` flips the stream row to `failed` → chat unblocks. The user resends. (Full
  crash-recovery contract stays Open; auto-requeue rejected — it silently re-runs bash.)
- **Sandbox is per-chat, named by chatId.** `decl.sandbox({chatId, userId})` +
  `createDockerSandbox({name: chatId})` — attach-or-create already existed in the context package
  (`container-sandbox.ts` probes `sandbox-<name>`, attaches/restarts/creates, TOCTOU-safe). The
  container engine is the registry (zero in-memory state); the workspace FS survives across turns,
  workers, and restarts. The runtime NEVER disposes it.
- ChangeSource stays hardcoded to `PollingChangeSource` for now _(decided)_ — not a configurable
  port yet.

### Approval-resume _(Built)_

A `needsApproval` tool call ends the agent loop mid-answer (SDK-native — probe-verified through
`agent()`/`chat()` with ZERO context-package changes). **The pause is pure data**: the assistant
message commits with an `approval-requested` tool part (chain head) and the stream goes terminal —
nothing is in-flight, so the pause survives crashes/restarts for free. `approve()` flips the part
to `approval-responded {approved: true}`, persists in place (`engine.continue(assistant)`),
reopens the stream, and pushes a continuation; on re-run **the AI SDK itself executes the tool**
(`output-available`, real output) and generation continues into the same assistant message.
`deny()` is the same flow with `{approved: false, reason}` → `output-denied`, tool never runs.
Note: `reopenStream` wipes the prior chunk log (FK cascade) — each segment is a fresh streaming
surface; full history lives in the chain, which is the source of truth anyway.

- **Identity: nothing new on the port.** Stream id and assistant id stay fused, and under the
  at-least-once contract the port needs no dedup key at all — a continuation is just another push
  (fresh v7 job id). Double-approve idempotency is consumer-side, like everything else: `approve()`
  no-ops if the `toolCallId` is already resolved on the chain head, and a duplicate continuation
  job is skipped by the terminal-stream check after the first one completes. (Watch the
  check-then-attach race between two concurrent approvals at implementation time.)
- **Mid-approval user messages: QUEUE BEHIND** _(decided, built)_. The FIFO alone can't enforce
  this (the paused turn's job completed, so the key unblocks), so gated turns **park**:
  `executeTurn` sees a pending tool part at the chain head and calls `context.park()` — before
  touching the chain or sandbox.
- **Parking = park-as-cancelled** _(built; contract-tested)_: `park()` self-cancels the claimed job
  (clean, no worker errors); cancelled jobs don't block the key, so the continuation runs;
  `approve()/deny()` pushes the continuation at `priority: 1` (outranks parked rows' older
  `created_on`) and `resumeParked(chatId)` revives parked jobs with their original `created_on` —
  FIFO order reassembles for free. No polling, no new storage. `park`/`resumeParked` are port
  surface now (`ConsumeContext.park`, `TurnQueue.resumeParked`), pinned by two contract tests
  (no redelivery until revival + original order; continuation outranks revived turns).
- **Disambiguation**: parked turn = job `cancelled` + stream row `queued`; user-cancelled turn =
  stream row `cancelled` (its job is also `cancelled`). `resumeParked` revives **every** cancelled
  job for the chat without inspecting stream rows — a revived user-cancelled turn is harmless because
  `executeTurn`'s terminal-stream check skips it before touching the chain/sandbox. The StreamStore
  remains the turn state machine; job state is transport detail.
- **Parked-turn durability — no TTL needed** _(Built)_. Earlier this section required auto-deny
  before production, because a parked (cancelled) job sat on pg-boss's `deleteAfterSeconds` clock
  (default 7d) and an unanswered approval would wedge then silently lose the parked line. Resolved
  structurally instead: the turns queue is created with **`deleteAfterSeconds: 0`** (pg-boss never
  time-deletes a terminal job), so a parked turn awaits its approval indefinitely with zero loss.
  Table growth is avoided by **commit-driven GC** — `consume` deletes a job the moment its turn runs
  and commits to the chain (`pg-boss.turn-queue.ts`), so completed jobs don't accumulate while parked
  jobs are kept until their approval resolves. No auto-deny, no store, no data loss, survives
  restarts (the pause is durable chain data). Pinned by `pg-boss.turn-queue.retention.test.ts`
  (config, commit-GC no-accumulation, parked-survives-maintenance-then-revives, and a real-time
  load-bearing proof — a control job with `deleteAfterSeconds: 1` is deleted by retention while the
  parked turn survives, polled via `timebox`) plus five runtime scenario tests (pause/approve/deny/
  queue-behind/cancel-while-queued all leave no jobs behind). (`retentionSeconds`, which governs
  still-`created` jobs, can't be 0; its default 14d is never approached — a queued turn only waits
  behind one running turn, and a gated follow-up becomes `cancelled`, not `created`.)
- **Tool surface**: `defineTool` = pure passthrough of the AI SDK's `tool()`;
  `AgentDeclaration.tools` merges over sandbox tools in `agent()`. Sandbox-bound approval tools
  (e.g. approve-before-bash) remain deferred — they need per-turn tool factories. Regenerate
  (attempt-level identity split, branches-as-attempts) stays deferred — see TODO.md.
- **Still Open here**: an abandoned approval keeps its parked job forever (bounded by abandoned
  gated chats; folds into the per-chat GC item, not a time TTL); cancel-of-paused-turn semantics
  (paused stream is terminal, cancel no-ops — semantically it should probably mean deny).

## Stacks: one runtime, swappable (or absorbed) adapters _(Designed)_

A **stack** binds the runtime's needs to one platform (Cloudflare, Node+Postgres, …) and is the
deploy target. Decision: **one runtime, swappable adapters** — write the orchestration once, supply
platform adapters.

For that to hold, the runtime must be **event-driven, not loop-driven**: a set of handlers
(`onTurnQueued`, `onWake`, `onCancel`) the host adapter invokes, with **all continuation routed
through a Scheduler port** and **zero in-memory continuation state** between calls (everything to
resume a turn round-trips the store). The Scheduler port is the same "host-runtime wakeup" seam we
keep `@deepagents/context` free of — it is the linchpin of portability, because "continue this work
later" is the one thing every platform expresses differently.

**Compute is long-running only. Serverless is out.** A turn runs start-to-finish in one execution
(Node/container process, or a Cloudflare Durable Object spanning long turns via alarms). Pure
short-lived functions (Vercel) are excluded — they would force cross-invocation slicing, i.e. the
step-level checkpointing we deferred.

Ports (the runtime's needs):

| Port                  | Node+Postgres                            | Cloudflare Durable Objects                    |
| --------------------- | ---------------------------------------- | --------------------------------------------- |
| ContextStore          | Postgres                                 | DO storage / D1                               |
| StreamStore           | Postgres                                 | DO storage                                    |
| ChangeSource          | `LISTEN/NOTIFY`                          | **absorbed** (DO WebSocket)                   |
| Queue (pending turns) | Postgres/PgBoss                          | **absorbed** (actor addressability)           |
| Scheduler             | node-cron                                | **absorbed** (DO alarms)                      |
| Compute / executor    | worker pool + per-conversation **lease** | one actor per `chatId` (serialization free)   |
| Sandbox               | Docker                                   | gated — no Docker → Daytona/E2B/CF-containers |

Key subtlety: on a Durable Object, several ports are not _implemented_ — they are **absorbed** by the
platform (the actor _is_ the queue, change-source, scheduler, and per-conversation serializer). So
the adapter seam must allow "this capability is provided intrinsically by the host," or we'd bolt a
redundant queue onto a platform that already is one. The unifying abstraction is therefore a
**per-conversation executor**: native as a DO, leased on Node.

## Built (implemented + verified)

**Durable streams + reconnect AND the background executor are now built** (see the executor
section). Still designed-not-built: the stacks (a real Node+Postgres bundle; the DO adapter).

- `.framework/agent.ts` — `defineAgent({model, sandbox, instructions, name?}) → AgentDeclaration`
  (pure; `sandbox` is a factory `(ctx: {chatId, userId}) => Promise<AgentSandbox>` so the backend
  can be named per chat; types-only context dependency).
- `.framework/sandbox/define.ts` — `defineSandbox(createBackend, opts?) → () => Promise<AgentSandbox>`
  (backend-agnostic `createBashTool` wrapper; seam = `DisposableSandbox`; proven over docker + virtual).
- `.framework/instructions.ts` — `defineInstructions(...fragments) => fragments`.
- `.framework/runtime.ts` — `createRuntime(decl, {store, streamStore, queue})` →
  `{ enqueue(conv, {id, input}) → {id, stream}, observe(conv) → {engine, resume, cancel(streamId?)},
work({concurrency?}) → AsyncDisposable }`. Enqueue is idempotent on the required caller-supplied
  UUID id (see the executor section). Instructions are seeded **unconditionally per turn**
  (the old `getTurnCount()===0` guard ran reopened conversations with an empty system prompt).
- `.framework/queue/` — `TurnQueue` port + `PgBossTurnQueue` (see the executor section).
- `agent.ts` / `sandbox.ts` / `instructions.ts` — pure declarations (no top-level await; importing
  spins nothing — verified `before=0 after=0` containers).
- `run.ts` — the **executor showcase**: PGlite-backed pg-boss (self-contained, no server), in-process
  `work()`, enqueue turn 1, detach mid-stream, enqueue turn 2 into the same chat (waits — strict
  FIFO), `resume()` replays turn 1, then turn 2 streams. Uses
  `SqliteContextStore('./zukhruf.sqlite')` + `SqliteStreamStore('./zukhruf.streams.sqlite')` +
  `PGlite('./zukhruf.queue')`.
- `.framework/runtime.integration.test.ts` — 8 black-box tests through enqueue/work/observe (real
  `PgBossTurnQueue` on in-memory PGlite, real `createVirtualSandbox`, mock model): detach→resume
  full replay + chain commit; resume null; cancel in-flight → `cancelled`; cancel after completion
  no-op; same-chat strict FIFO (never 2 active); cross-chat overlap (gate-proven, deterministic);
  cancel-while-queued skips execution + nothing enters the chain; crashed turn → `failed` + next
  turn in chat unblocks (exercises the DLQ reconciler end-to-end).
- Verified end-to-end: a live turn (gpt-5.4-mini) ran bash in a per-conversation container and
  disposed it with no leak.
- Backends switch by composition in `sandbox.ts`
  (`defineSandbox(({chatId}) => createDockerSandbox({name: chatId}))` ↔ Daytona etc.);
  `docker.ts`/`daytona.ts` deleted (no presets, no dispatcher flag).

## Open (deliberately deferred)

- **Crash-recovery contract** — turn-fails-retry vs resume-with-idempotent-tools vs resume-exactly-once
  (tool-call journal). Set aside. (The executor's stale-turn default — mark failed — is only the
  minimal v1 stance, not this contract.)
- **Observe / reconnect UX** — how a reconnecting client discovers the in-flight turn (head message +
  stream status) and what it sees at each turn state; notifications when a turn finishes while away.
- **Pause vs cancel** — cancel is terminal; pause (suspend/resume mid-turn) semantics undecided.
- **Per-turn bounds** — step / token / wall-clock / no-progress caps as automatic terminals.
- **Per-chat sandbox GC** — sandboxes are per-chat, named by chatId, and never disposed by the
  runtime. Nothing reclaims a dead chat's container yet (chat deletion hook? idle TTL? host policy?).
- **Queued-turn visibility** — `resume()` only sees executing/executed turns (the chain mutates at
  execution time). A reconnecting client can't discover turns that are queued but unstarted; folds
  into the observe/reconnect UX item.

_Resolved by the executor build:_ **mid-turn message contract** → queue (strict FIFO per chat,
structural via `key_strict_fifo`); **sandbox lifetime** → per-chat, named by chatId, attach-or-create;
**workspace durability** → the per-chat container persists, so the FS survives across turns, workers,
and restarts (durable volumes only needed once containers are reclaimed).\_

## Principles carried throughout

- **Caller composes; no backend bundling.** No `{backend: 'docker'|'daytona'}` flag — the caller
  picks the value. (A _stack_ is the exception that proves it: a coherent bundle of ~6 ports that
  must agree, not a single hidden choice.)
- **Strict contracts over lenient fallbacks.** The store is required; no silent in-memory default.
- **No in-memory continuation state.** Anything needed to resume a turn must round-trip the store —
  the same discipline that makes it durable also makes it portable.
- **The runtime never disposes the sandbox.** Sandboxes are per-chat named resources
  (attach-or-create by chatId); their lifetime belongs to the chat, and reclamation is host policy
  (Open). This revises the earlier "sandbox disposes itself per handle" principle, which fit the
  fused per-conversation handle the executor replaced.
- **Scaffold one primitive at a time**, even erroring, where the error is diagnostic (it pins the
  exact missing dependency).
