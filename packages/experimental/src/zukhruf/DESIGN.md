# Zukhruf — Design

> Status: design notes from an exploratory session. Distinguishes **Built** (implemented + verified)
> from **Designed** (decided, not yet implemented) from **Open** (deliberately deferred).

## What Zukhruf is

Zukhruf is an **internal DSL for declaring an agent**, plus a **runtime that executes that
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

## Background-agent model: "conversation with long turns" _(Built)_

Zukhruf is not a request/response chatbot. It is a **conversation whose turns are durable
background runs**.

- A **turn is the durable run**. The caller supplies an idempotency key in `TurnInput.id`; the
  runtime deterministically scopes it by `(userId, chatId)` and uses the derived value as both
  `streamId` and assistant message id. Re-execution would require splitting those attempt
  identities.
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
so the host composes a `StreamManager`, `AgentRuntime` borrows it, and `AgentTurnExecutor`
performs each model turn.

Mechanism:

1. `enqueue()` derives a conversation-scoped stream id from `TurnInput.id`, registers it as queued,
   and pushes the ask into `TurnQueue`; it does not mutate conversation history or execute the
   model. The returned `id` is this durable stream id, not the caller's raw key.
2. A worker resolves the chat's agent declaration, writes the user message plus assistant
   placeholder (`id = streamId`) to `ContextEngine`, then calls `chat()`.
3. The worker awaits `StreamManager.persist(stream, streamId)` for the full turn. Persist writes
   every chunk/status to `StreamStore`, while `chat()` commits the final assistant message to
   `ContextStore`. The worker owns execution even when every observer disconnects.
4. consumers read `manager.watch(streamId)` — replays from seq 0, then tails live. Even the first
   consumer reads via `watch()`, so a mid-turn detach loses nothing.
5. reconnect = `observe(conversation).resume()`: find the head assistant's stream and return its
   replay watcher; a conversation with no started turn returns `null`.
6. cancel = two-layer: `manager.cancel(streamId)` atomically changes only a queued/running stream;
   active same-process monitors are signalled immediately and the durable change watcher covers
   cross-process cancellation. After asynchronous sandbox acquisition the executor first rechecks
   terminal state, then atomically claims `queued → running` before model construction and starts
   cancellation observation before `chat()` enters provider setup. A cancellation that wins the
   claim race never starts sampling; one that lands after the claim aborts provider setup or the
   active model call. Terminal writes are conditional, so neither path can be overwritten by a late
   completion or failure.

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

> Implemented on pg-boss (`queue/`). All decisions below are confirmed and shipped.

### Verified substrate (what `@deepagents/context` already provides)

- `ContextEngine` can persist the user message + empty assistant placeholder when the worker starts.
  Keeping this mutation at execution time prevents queued turn N+1 from changing turn N's prompt.
- The StreamStore status field is a real job state machine: `register()` → `queued`, atomic
  `claim()` → `running`, terminal on complete/fail/cancel; `listStreamIds({status})` queries it;
  `persist()` early-returns on already-terminal (safe against double-drive of a finished turn).
  Terminal transitions update only queued/running rows, so terminal state is monotonic.
- Cancellation observation starts immediately after the execution claim, before provider setup,
  and continues through `persist()` using the same abort hook.

### Resolved executor boundaries

1. **Addressing** — each `TurnRef` carries `{chatId,userId,streamId}`; model-facing agent routing is
   separate and uses metadata-backed `AgentPath` values.
2. **Claiming** — `TurnQueue` owns delivery, heartbeat, settlement, and strict per-chat FIFO. The
   runtime's terminal stream check makes at-least-once delivery idempotent, while StreamStore's
   atomic execution claim orders worker start against cancellation.
3. **Work entry point** — `enqueue()` only registers/pushes; `work()` installs
   `AgentTurnExecutor.execute`; and `observe()` only watches existing state.

### TurnQueue port _(Built — `queue/turn-queue.ts`)_

A Zukhruf-owned port; StreamStore stays the generic turn state machine, the queue row carries the
Zukhruf addressing **and the turn's input**. The port is **handler-shaped, not fetch-shaped**:
claiming, heartbeating, and settlement belong to the implementation (pg-boss does all three
natively; re-deriving them behind a `claim/heartbeat/complete` surface would fight the library).
On Durable Objects the port is **absorbed** (the actor invokes the handler directly).

```ts
type TurnRef = {
  streamId;
  chatId;
  userId;
} & (
  | { kind: 'ask'; input }
  | { kind: 'approval'; toolCallId; approvalId; decision }
  | { kind: 'continuation'; recovery }
  | { kind: 'mailbox' }
);
abstract class TurnQueue {
  push(turn: TurnRef): Promise<{ jobId: string; inserted: boolean }>;
  consume(
    handler: (turn, { signal }) => Promise<void>,
    options: { concurrency?; onOrphaned(turn, error) },
  ): Promise<AsyncDisposable>;
  resumeParked(chatId: string): Promise<void>;
}
```

Contract: per chat at most ONE active handler, strict FIFO per chat, cross-chat concurrency; a
crashed handler/worker surfaces once through `onOrphaned` (no retry), then the chat unblocks.
Approval commands use deterministic job identity from their persisted approval ID, so concurrent
API processes converge on one queued command without mutating context themselves.

### pg-boss implementation _(Built — `queue/pg-boss.turn-queue.ts`)_

`PgBossTurnQueue(boss /* borrowed */, {queue?, schema?})` on pg-boss v12 (all
semantics live-verified):

- **Schema is explicit for custom database adapters** — pg-boss does not expose the configured
  schema through its custom-adapter interface. Callers using `fromPglite` or another custom adapter
  must pass the same `schema` to `PgBossTurnQueue`; the built-in database path is read directly.
  Initialization validates the queue catalog/table without creating transient probe queues, so
  preprovisioned least-privilege deployments do not need catalog-write permission at startup.
- **`key_strict_fifo` policy + `singletonKey = chatId`** — per-chat serialization is structural:
  1 active per key, unlimited queued, strict push order, failed job blocks the key.
- **`group.id = chatId` + global `groupConcurrency: 1`** — pg-boss filters active chats before
  selecting the next job, so a blocked same-chat successor cannot starve ready turns from other
  chats.
- **Approval IDs are queue IDs** — an approval job uses
  `uuidv5("approval:" + approvalId, conversationNamespace)` and `singletonKey = chatId`.
  pg-boss's job-ID uniqueness makes approve, deny, and duplicates for one approval converge on the
  first inserted command. Different sibling approval IDs remain distinct jobs.
- **`retryLimit: 0`** — the stale-turn decision in config: a crashed turn is never silently re-run
  (its bash already executed); it dead-letters instead.
- **Heartbeats are the lease** — `heartbeatSeconds` + `work()`'s automatic heartbeat; the pg-boss
  monitor fails the job of a dead worker. No hand-rolled lease.
- **DLQ worker is the crash reconciler** — consumes `<queue>-dead`, calls `onOrphaned` (runtime
  flips the orphaned stream row to `failed`), and always deletes the failed source job in `finally`.
  Projection failures remain retryable without blocking the chat's strict-FIFO key.

### Runtime API split _(Built — replaces the fused `continue()/send()`)_

```
enqueue (any short-lived process):
  enqueue({chatId,userId}, {id, input})            // id: REQUIRED caller idempotency key
    → AgentTurnId.fromRequest(conversation, id)    // deterministic, conversation-scoped durable id
    → manager.register(streamId)                   // stream row: 'queued' (ON CONFLICT DO NOTHING)
    → queue.push({kind: 'ask', streamId, chatId, userId, input})
    → { id: streamId, stream: watch(streamId) }    // caller may watch immediately

deliver (any host process):
  runtime.deliver(communication, QueueOnly | TriggerTurn)
    → durable mailbox append before any payload-free wake is scheduled

work (long-running executor process):
  runtime.work({concurrency?}) → queue.consume(AgentTurnExecutor.execute, {onOrphaned})
  AgentTurnExecutor.execute: stream terminal? skip (cancel-while-queued)
    → mailbox.beginTurn(conversation, streamId)   // attempt-scoped cross-worker activity boundary
    → resolve chat metadata → selected declaration
    → ask drains the leading queue-only FIFO prefix; mailbox turns drain all
    → engine.set(user(input), assistant placeholder id=streamId); save()
    → sandbox = declaration.sandbox({chatId, userId}) // per-chat, attach-or-create; never disposed here
    → terminal stream? project/skip                // closes cancel-during-setup race
    → atomically claim stream queued → running     // orders execution against cancellation
    → monitor cancellation → chat(contextVariables) → AWAIT persist(preclaimed)
                                                    // worker holds the job for the whole turn
    → child terminal? idempotent queue-only FINAL_ANSWER to its direct parent
    → mailbox.endTurn(conversation, streamId)     // stale attempts cannot close a successor

observe (anywhere): AgentObservation { engine, resume(), cancel(streamId?) } — never spins a sandbox.
```

**Enqueue is idempotent on a caller key, and that key is caller-supplied by necessity.** Idempotency
is only achievable by the sender: the hop between caller and enqueue is the unreliable part, so
only the party _before_ that hop can mark two arrivals as the same ask. A runtime-minted id makes
dedup impossible by construction (every retry looks new). The id is any unique string (a client
message id, or `crypto.randomUUID()` absent a natural key). `AgentTurnId` then derives a stable
conversation-scoped durable id, preventing one user's equal raw key from replaying or cancelling
another conversation's stream.

**Division of labor: queue = at-least-once; runtime = exactly-once-per-turn.** The queue promises
"never lost, strict FIFO per chat, maybe delivered twice" — job ids are monotonic **UUIDv7** so the
`ORDER BY created_on, id` tiebreak follows push order (fixes FIFO ties on ms-resolution clocks
without timing hacks). Turn-level dedup lives in `AgentTurnExecutor`: it skips turns whose stream
row is terminal before touching sandbox/chain/model. The stream row never expires — unlike
queue-side dedup by retained job rows, which ends when commit-GC or retention removes the row. So
duplicates reattach, a post-completion resubmit replays the finished stream
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

**Identity invariant (and its tripwire).** The raw request key maps deterministically to one
conversation-scoped durable id. That durable id carries two identities: the stream ("this
execution's chunk log") and assistant message ("this chain node"). This fusion is valid **only
while a turn executes at most once** — which v1 guarantees by construction (`retryLimit: 0`, no
regenerate). Approval continuation reopens the same logical turn. The moment general re-execution
lands (regenerate / retry), the cardinality becomes 1 request : N attempts and stream + assistant
ids MUST split per attempt, with a discovery helper for resume.

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
  DLQ → `onOrphaned` flips the stream row to `failed` → chat unblocks. The process-kill recovery
  path is integration-tested; automatic retry or exact resumption remains deliberately unsupported
  because it could silently re-run bash.
- **Sandbox is per-chat, named by chatId.** `decl.sandbox({chatId, userId})` +
  `createDockerSandbox({name: chatId})` — attach-or-create already existed in the context package
  (`container-sandbox.ts` probes `sandbox-<name>`, attaches/restarts/creates, TOCTOU-safe). The
  container engine is the registry (zero in-memory state); the workspace FS survives across turns,
  workers, and restarts. The runtime NEVER disposes it.
- The host selects the `StreamStore` and `ChangeSource` when constructing the borrowed
  `StreamManager`; `AgentRuntime` neither initializes nor disposes them.

## Independent-thread mailbox foundation _(Built)_

The mailbox is pending **inter-agent input** for one conversation. It is not the work scheduler.
A caller supplies one durable `MailboxStore`; every operation names its target `ConversationId`
explicitly. A pending item is an `InterAgentCommunication` envelope with an author, recipient,
optional other recipients, explicit `MESSAGE | NEW_TASK | FINAL_ANSWER` type, content, metadata,
stable ID, and a `triggerTurn` bit.

`AgentRuntime` requires `mailboxStore` and exposes `deliver(communication, mode)` as the host-facing
entry point. The store contract is deliberately small: begin/end the target's active-turn boundary,
idempotent append, pending check, leading queue-only drain, and full FIFO drain. Mailbox lifetime
remains caller-owned.

The receive contract follows Codex MultiAgentV2:

1. validate and idempotently append the envelope to the target mailbox;
2. for `queue-only`, request a fallback wake only when the same mailbox transaction observed an
   active target;
3. for `trigger-turn`, push a payload-free `{kind: 'mailbox'}` wake onto `TurnQueue` only after the
   append succeeds.

Several queue-only messages can therefore accumulate while a target is idle. One later trigger
wakes exactly one normal target turn, which reads every currently pending item in FIFO order. The
runtime records each envelope as its own model-visible user history item, with the original envelope
retained in message metadata. Draining the mailbox is the consumption point.

### Mailbox versus TurnQueue

| Primitive      | Authority                                        | Operations                                         | Starts work?          |
| -------------- | ------------------------------------------------ | -------------------------------------------------- | --------------------- |
| `MailboxStore` | pending communication + active delivery boundary | begin/end, append, pending, prefix/full FIFO drain | never                 |
| `TurnQueue`    | durable execution scheduling and activity        | push, inspect activity, claim, park, settle        | yes, through a worker |

They may eventually share a physical backend, but the contracts stay separate. In particular,
mailbox payloads never enter `TurnQueue`; a mailbox `TurnRef` is only a durable wake receipt.
Strict per-chat TurnQueue FIFO guarantees at most one target turn at a time. The worker brackets that
turn with transactional mailbox begin/end calls keyed by the turn's `streamId`. Mail committed
before the matching end observes the active row; mail committed after end observes an idle target.
A stale orphan callback cannot delete a successor turn's activity row because its attempt token no
longer matches. Mail arriving while active becomes visible at the next AI SDK sampling boundary when
one exists and reserves one serialized fallback wake. If the safe boundary consumes it, the wake is
a no-op; otherwise the wake delivers it immediately after the active turn settles. Queue-only
delivery to an idle target still never schedules work.

### Intentional differences from Codex

- **Pending mail is durable.** Codex currently keeps a session-local `VecDeque` and makes mail
  durable only after consumption into rollout/history. Zukhruf enqueue and work may run in different
  processes, so `SqliteMailboxStore` persists pending envelopes and proves survival across store
  re-instantiation. A process-local queue could lose an idle target's message before any worker saw
  it.
- **Drain is consumption.** There is no claim, acknowledgement, lease, redelivery handshake, or
  consumed-state protocol. The runtime drains FIFO input, incorporates it into the model request,
  and writes the matching conversation history. If the process crashes or history persistence fails
  after the drain, that mail is lost. This is the accepted simpler failure window; callers should
  send a new communication when they need another delivery attempt. The one exception is a durable
  ID tombstone for consumed `FINAL_ANSWER` envelopes: it prevents orphan recovery from projecting
  the same terminal child result twice, but does not make ordinary mail acknowledgeable or
  redeliverable.
- **Wake scheduling is not crash-reconciled.** Trigger-turn delivery appends first and then requests
  a payload-free TurnQueue wake. Cross-runtime sender/end-turn races may request more than one; the
  extra serialized wake drains nothing and completes without a model call. If scheduling fails or
  the process dies between append and wake, the mail remains pending but worker startup does not
  scan or manufacture a replacement wake. A later target turn or trigger can consume it.
- **Delivery activity is durable but not scheduling.** `MailboxStore` keeps one tiny active-recipient
  row with the active `streamId`, so enqueue and the matching turn-end have a cross-process ordering
  point and stale attempts cannot end successors. It has no watcher, subscription, execution job,
  claim, acknowledgement, or lease. `TurnQueue` remains the sole scheduling authority.
- **AI SDK history uses user messages.** Codex can emit a protocol-native `AgentMessage` carrying
  author and recipient fields. AI SDK `UIMessage` has no inter-agent role, so Zukhruf records one
  ordered user message per communication, renders a compact author/recipient header into its single
  text part, and retains the exact envelope in metadata. This preserves model visibility and durable
  replay, but the provider-visible item shape is intentionally not Codex's Rust protocol variant.
- **The safe active boundary is an AI SDK step.** `ContextEngine`'s prepare-step path drains newly
  arrived mail before the next sampling request, makes it model-visible in FIFO order, and persists
  the matching assistant/mail/assistant history split. Codex can keep the same sampling loop alive
  when mail misses the final boundary; Zukhruf uses a serialized fallback wake for a new turn
  instead. TurnQueue serialization prevents concurrent turns, and an
  already-consumed fallback becomes a payload-free no-op.
- **Identity and addressing stay separate.** `ConversationId {chatId,userId}` is the durable
  internal thread identity. `AgentPath` is the model-facing address: `/root` is the root, absolute
  paths address siblings, and relative names resolve beneath the sender. `AgentDirectory` filters
  chats by the sender's top-level `zukhrufTreeId` before matching the reserved metadata path. The
  stored chat owner is authoritative: a caller-supplied `userId` mismatch is rejected before the
  conversation can execute, be observed, be cancelled, receive host-delivered mail, or answer an
  approval. Broadcast and encrypted content remain out of scope.

## Independent-agent control plane _(Built)_

The control plane deliberately reuses declarations, `ContextStore`, mailbox storage, and TurnQueue
instead of introducing a Runner or separate thread database:

- `defineAgent({name, subagents})` requires a stable declaration name and declares which agent types
  the current agent may spawn. `AgentTurnExecutor` injects the direct AI SDK `spawn_agent`,
  `send_message`, `followup_task`, `list_agents`, `wait_agent`, and `interrupt_agent` tools for every
  turn.
- `AgentRuntimeOptions.multiAgentV2` is the host configuration surface for Codex V2-compatible
  collaboration guidance and tool exposure. Root and subagent usage hints are separate complete
  overrides; empty strings disable them. The selected hint is injected as a non-persisted role
  fragment, so forked transcript history never copies a parent's hint into a child. `usageHintText`
  appends guidance to `spawn_agent`. `toolNamespace` applies a validated native OpenAI Responses
  namespace to all six collaboration tools. Reserved, padded, non-ASCII, and over-64-character
  namespaces fail during runtime construction.
- Collaboration tools are direct-model-only by default, matching Codex V2's
  `non_code_mode_only = true`. Zukhruf does not have a nested code-mode executor, so
  `nonCodeModeOnly: false` fails explicitly instead of pretending the tools are reachable from an
  execution surface that does not exist.
- `new AgentRuntime(root, options)` recursively compiles declarations by unique canonical names
  without surrounding whitespace. Each worker turn loads the chat's reserved Zukhruf metadata and
  selects the matching declaration.
- The first root execution initializes `{treeId, path: '/root', parentChatId: null,
declarationName}` in existing chat metadata. Runtime execution also records `lastTurnId`,
  allowing a queued cancellation or setup failure to remain observable before an assistant history
  head exists.
  Root initialization and latest-turn writes use the store's transactional `updateChat` updater,
  preserving concurrent host metadata. Terminal reconciliation updates only the state it observes
  under the row lock, so duplicate or stale callbacks cannot rewind a successor.
  `spawn_agent` creates a separate child chat with its own path, parent, declaration name, context
  history, stream, mailbox, and TurnQueue key. Its optional `fork_turns` string controls the initial
  history snapshot: `all` (the default), `none`, or a positive number of recent user-turn
  boundaries. The selected `agent_type` still determines the child declaration independently.
- Reserved metadata fails closed. Every non-root thread must name an existing same-user,
  same-tree parent whose canonical path is the immediate ancestor; self-parenting and skipped
  ancestors are rejected before work is queued. Persisted paths must already be canonical rather
  than being silently normalized on load.
- Collaboration tools are internal direct `tool()` adapters. `chat(..., {contextVariables})`
  supplies only the `AgentControlPlane` and the current actor (turn, thread, declaration); tools
  receive no raw stores, queue callbacks, or `AsyncLocalStorage` state.
- `spawn_agent` validates the selected direct subagent and derives deterministic child-chat and
  initial-turn IDs from the user, tree, and canonical path. Concurrent calls and queue retries
  therefore converge on one durable child and one initial ask. It returns the Codex V2 shape
  `{task_name}` where the value is the canonical `/root/...` child path, without awaiting child
  execution. The history snapshot and cloned message IDs are persisted
  deterministically before enqueue, so a queue-push gap retries the original snapshot instead of
  copying newer parent state. Forked history keeps real user messages and final assistant content
  while dropping synthetic reminders, inter-agent envelopes, reasoning, and tool traffic. Once the
  initial turn is terminal, reusing the path is rejected instead of reporting a no-op respawn as
  successful.
- `send_message` resolves a target path and stores queue-only `MESSAGE` mail. `followup_task`
  resolves the same way, rejects `/root`, stores `NEW_TASK`, and requests a serialized mailbox turn
  for the target. Both return Codex V2's empty success text. Mailbox wakes use the same
  conversation-scoped durable turn identity as asks, so their owner can resume or cancel them.
  Cross-runtime races may enqueue duplicate empty wake receipts; serialized execution and
  empty-drain handling make them harmless no-ops.
- `list_agents` scans only the caller's metadata-scoped tree, optionally resolves a path prefix
  relative to the caller, and combines each chat's canonical path and persisted context with the
  TurnQueue's required `idle | queued | running` activity. Its strict status schema matches Codex
  V2: `pending_init | running | interrupted | shutdown | not_found | {completed} | {errored}`. An
  unstarted child stays `pending_init`; an initialized child with a queued follow-up or unresolved
  approval is `running`. A failed or cancelled continuation reports `errored` or `interrupted`.
  `shutdown` remains a legal compatibility status even though Zukhruf has no shutdown lifecycle.
  Listing is observational and never wakes or consumes an agent.
- `wait_agent` waits only for pending mail addressed to the calling agent. It observes the durable
  mailbox without draining it, so the same mail enters the next model step. The tool returns
  the strict Codex V2 `{message, timed_out}` shape. Host-configurable minimum, default, and maximum
  waits default to 10 seconds, 30 seconds, and 1 hour respectively. It aborts with the caller turn.
  Zukhruf has no in-turn steer channel, so steer activity is intentionally absent.
- `interrupt_agent` resolves canonical or relative paths, rejects root/self, returns the target's
  previous listed status (`not_found` for a missing target), and leaves the target reusable. For a
  running or oldest queued turn it
  first commits stream cancellation, projects its idempotent `FINAL_ANSWER`, then removes matching
  scheduler copies that are still queued. Active work retains its strict-FIFO key until its handler
  exits; local handlers are signalled by the adapter and remote handlers observe the durable stream
  cancellation. Projection precedes destructive queue cleanup so a mailbox failure remains
  retryable.
  Terminal and approval-paused targets are no-ops. This is the complete model-facing lifecycle
  surface: there are no close, shutdown, resume, or approval-as-denial tools.
- Every genuinely terminal non-root turn is projected to its direct parent as idempotent queue-only
  `FINAL_ANSWER` mail. The envelope carries `completed | failed | cancelled` status metadata and a
  deterministic ID, and SQLite retains terminal-ID tombstones after FIFO consumption, so orphan
  recovery can retry without duplicating a delivered completion. Projection reads the assistant
  message whose id matches the terminal stream, never a newer conversation head. An approval pause is not terminal:
  projection waits for continuation, guaranteeing one final answer. A failed or cancelled
  continuation overrides that pause and is projected immediately. Child progress UI remains
  deferred.

### Approval-resume _(Built)_

A `needsApproval` tool call ends the agent loop mid-answer (SDK-native — probe-verified through
`agent()`/`chat()` with ZERO context-package changes). **The pause is pure data**: the assistant
message commits with an `approval-requested` tool part (chain head) and the stream goes terminal —
nothing is in-flight, so the pause survives crashes/restarts for free.

`approve()` and `deny()` are asynchronous command helpers. The API process reads the tool part,
derives the deterministic job ID from `approval.id`, and queues `{kind: 'approval', ...decision}`.
It never mutates ContextEngine or reopens the stream. The return value identifies the original turn
and command:

```ts
{ id, jobId, status: 'queued' | 'already-queued' | 'already-applied' }
```

The worker re-reads the paused tool part, applies the winning decision, and persists
`approval-responded`. It finishes immediately while sibling approvals remain. The final sibling's
approval job reopens and resumes the original turn directly; normal approval does not create a
separate continuation job. On re-run **the AI SDK itself executes an approved tool**
(`output-available`, real output), while denial settles as `output-denied` and never executes it.
Note: `reopenStream` wipes the prior chunk log (FK cascade) — each segment is a fresh streaming
surface; full history lives in the chain, which is the source of truth anyway.

- **ContextEngine is permanent deduplication state.** While the part is
  `approval-requested`, the API may enqueue the deterministic command. The same persisted decision
  returns `already-applied`; the opposite persisted decision is a conflict. A queued opposite
  command cannot report an immediate conflict because both decisions address the same job ID; the
  worker's recheck makes the first queued command durable. After pg-boss deletes the command,
  `approval-responded` still prevents retries from creating another job.
- **Mid-approval user messages: QUEUE BEHIND** _(decided, built)_. The FIFO alone can't enforce
  this (the paused turn's job completed, so the key unblocks), so gated turns **park**:
  `AgentTurnExecutor` sees a pending tool part at the chain head and calls `context.park()` — before
  touching the chain or sandbox.
- **Parking = park-as-cancelled** _(built; contract-tested)_: `park()` self-cancels the claimed job
  (clean, no worker errors); cancelled jobs don't block the key, so the approval command runs;
  approval commands use `priority: 1` (outranks parked rows' older
  `created_on`) and `resumeParked(chatId)` revives parked jobs with their original `created_on` —
  FIFO order reassembles for free. No polling, no new storage. `park`/`resumeParked` are port
  surface now (`ConsumeContext.park`, `TurnQueue.resumeParked`), pinned by two contract tests
  (no redelivery until revival + original order; approval command outranks revived turns).
- **Disambiguation**: parked turn = job `cancelled` + stream row `queued`; user-cancelled turn =
  stream row `cancelled` (its job is also `cancelled`). `resumeParked` revives **every** cancelled
  job for the chat without inspecting stream rows — a revived user-cancelled turn is harmless because
  `AgentTurnExecutor`'s terminal-stream check skips it before touching the chain/sandbox. The
  StreamStore remains the turn state machine; job state is transport detail.
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
  parked turn survives, polled via `timebox`) plus the runtime approval scenarios
  (pause/approve/deny/queue-behind/cancel-while-queued all leave no jobs behind).
  (`retentionSeconds`, which governs still-`created` jobs, cannot be zero. A sufficiently deep or
  blocked backlog can still outlive its 14-day default; startup reconciliation for that remaining
  orphan case is tracked in BUGS.md and TODO.md. A gated follow-up becomes `cancelled`, not
  `created`.)
- **Tool surface**: `defineTool` preserves the AI SDK's `tool()` inference and adds the optional
  `recovery: 'idempotent'` contract; `AgentDeclaration.tools` merges over sandbox tools in
  `agent()`. Sandbox-bound approval tools (e.g. approve-before-bash) remain deferred — they need
  per-turn tool factories. Regenerate (attempt-level identity split, branches-as-attempts) stays
  deferred — see TODO.md.
- **Still Open here**: an abandoned approval keeps its parked job forever (bounded by abandoned
  gated chats; folds into the per-chat GC item, not a time TTL); cancel-of-paused-turn semantics
  (paused stream is terminal, cancel no-ops — semantically it should probably mean deny).
- **Recoverable handoff**: the approval job owns response persistence, stream reopening, direct
  resumption, and parked-turn revival. A worker crash after `approval-responded` but before direct
  resumption is detected from durable state and schedules a recovery-only continuation job.
  Continuation completion always reconciles parked turns. The regression suite covers sibling
  approvals, mixed concurrent decisions, worker crashes, queue/revival failure, and child terminal
  projection.
- **Idempotent continuation crash recovery**: when every approved tool in the continuation declares
  `recovery: 'idempotent'`, orphan cleanup reopens the failed stream and schedules one recovery
  attempt. The SDK reuses the persisted `toolCallId`, so the tool can pass it to its provider as the
  idempotency key and recover the original result without repeating the external effect.
- **Failed or cancelled continuation recovery**: non-opted-in continuations, cancelled
  continuations, and a failed recovery attempt settle approved `approval-responded` parts to
  `output-error`, preserve denied siblings as `output-denied`, report the terminal result, and
  resume parked turns. The same class-owned transition runs after persistence, during
  already-terminal replay, and from orphan cleanup. Later asks therefore do not inherit a phantom
  approval gate, even when terminal projection itself must be retried.

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

- `agent.ts` — `defineAgent({name, model, sandbox, instructions, tools?, subagents?})` returns a
  pure declaration with caller tools and a normalized subagent list. `sandbox` is
  a factory `(ctx: {chatId, userId}) => Promise<AgentSandbox>` so each independent chat owns its
  backend. `name` is the stable declaration identity persisted in chat metadata.
- `sandbox/define.ts` — `defineSandbox(createBackend, opts?) → () => Promise<AgentSandbox>`
  (backend-agnostic `createBashTool` wrapper; seam = `DisposableSandbox`; proven over docker + virtual).
- `instructions.ts` — `defineInstructions(...fragments) => fragments`.
- `runtime/agent-runtime.ts` —
  `new AgentRuntime(rootDeclaration, {store, streams, queue, mailboxStore})` →
  `{ enqueue(conv, {id, input}) → {id, stream},
deliver(communication, mode) → void,
approve(conv, {toolCallId}) / deny(conv, {toolCallId, reason?}) → {id, stream},
observe(conv) → AgentObservation {engine, resume, cancel(streamId?)},
work({concurrency?}) → AsyncDisposable }`.
  It wires `AgentControlPlane`, `AgentTurnExecutor`, `ApprovalController`,
  `AgentStatusProjector`, and `MailboxCoordinator` once. Enqueue
  remains idempotent on the required caller-supplied key and returns its conversation-scoped
  durable id. Instructions are seeded
  **unconditionally per turn** (the old `getTurnCount()===0` guard ran reopened conversations with
  an empty system prompt).
- `control-plane/agent-path.ts`, `agent-thread.ts`, and `agent-directory.ts` — canonical rooted
  addressing, durable thread identity, and ContextStore-backed tree discovery.
  `agent-status-projector.ts`
  translates transcript and stream state into agent-list status and terminal mail without leaking
  `ContextEngine` into `AgentControlPlane`. `collaboration/spawn-agent.ts`, `message-tools.ts`,
  `list-agents.ts`, `wait-agent.ts`, and `interrupt-agent.ts` are thin model-facing adapters over
  `AgentControlPlane`. These collaborators and adapters are package-internal; the customer barrel
  exposes the runtime, DSL, domain values, and store/queue ports and adapters.
- `mailbox/` — caller-owned durable `MailboxStore` / `SqliteMailboxStore`, stable communication IDs,
  durable-before-wake delivery, FIFO drain, and a transactional begin/enqueue-active/end
  handoff keyed by the active turn's stream ID. This tiny activity record orders queue-only delivery
  across worker processes and rejects stale end-turn attempts; it is not a thread store, execution
  queue, claim, acknowledgement, or lease protocol. Initial asks may consume only the leading
  queue-only prefix so an earlier trigger and everything after it retain FIFO order.
- `queue/` — `TurnQueue` port + `PgBossTurnQueue`, including required durable
  `getTurnActivity(): idle | queued | running` status inspection plus exact active/oldest-queued
  lookup and stream cancellation. The latter two are architecture-forced adapter capabilities for
  model-facing interruption: pg-boss must free a strict-FIFO key and signal an active worker, while
  an actor host may absorb both capabilities (see the executor section).
- `demo/zukhruf-durable-turns/agent.ts`, `instructions.ts`, and sandbox factories are pure
  declarations (no top-level await; importing spins no container or agent turn).
- `demo/zukhruf-durable-turns/run.ts` — the **independent-agent showcase**: PGlite-backed pg-boss
  (self-contained, no server), concurrent in-process `work()`, detach/resume a root turn that calls
  nonblocking `spawn_agent`, wait until the specialist's queue-only `FINAL_ANSWER` is durable, then
  enqueue a second root turn that consumes it. Uses
  `SqliteContextStore('./zukhruf.sqlite')` + `SqliteStreamStore('./zukhruf.streams.sqlite')` +
  `SqliteMailboxStore('./zukhruf.mailbox.sqlite')` + `PGlite('./zukhruf.queue')`.
- Integration suites cover enqueue/work/observe durability, ownership and stream isolation,
  topology validation, approval continuation and sibling-decision races, failed-continuation
  settlement and parked-turn revival, cancellation during setup and the atomic execution-claim
  race, crash recovery and stale-orphan isolation, turn-specific terminal projection,
  mailbox FIFO and cross-worker safe-boundary delivery, concurrent/retryable spawn, canonical
  sibling messaging, genuine root/child/grandchild execution, follow-up ordering, root rejection,
  queued/running/waiting-approval/terminal tree status, caller-mailbox wait/timeout/cancellation,
  queued and cross-runtime active interruption, target reuse, and idempotent
  success/failure/cancellation forwarding.
- Backends switch by composition in the demo sandbox declarations
  (`defineSandbox(({chatId}) => createDockerSandbox({name: chatId}))` ↔ Daytona etc.);
  `docker.ts`/`daytona.ts` deleted (no presets, no dispatcher flag).

## Open (deliberately deferred)

- **Non-idempotent post-crash continuation recovery** — process-kill detection, one automatic replay
  for opted-in idempotent approval tools, terminal failure, and chat unblocking are built. Provider
  reconciliation and exact resumption through a tool-call journal remain deliberately deferred.
- **Observe / reconnect UX** — how a reconnecting client discovers the in-flight turn (head message +
  stream status) and what it sees at each turn state; notifications when a turn finishes while away.
- **General pause vs cancel** — approval parking is built, while arbitrary suspend/resume of a
  running model turn remains undecided. Cancel is terminal for queued/running streams.
- **Per-turn bounds** — step / token / wall-clock / no-progress caps as automatic terminals.
- **Per-chat sandbox GC** — sandboxes are per-chat, named by chatId, and never disposed by the
  runtime. Nothing reclaims a dead chat's container yet (chat deletion hook? idle TTL? host policy?).
- **Queued-turn visibility** — `resume()` only sees executing/executed turns (the chain mutates at
  execution time). A reconnecting client can't discover turns that are queued but unstarted; folds
  into the observe/reconnect UX item.

_Resolved by the executor build:_ **mid-turn message contract** → queue (strict FIFO per chat,
structural via `key_strict_fifo`, with grouped claims preventing cross-chat starvation);
**sandbox lifetime** → per-chat, named by chatId, attach-or-create; **workspace durability** → the
per-chat container persists, so the FS survives across turns, workers, and restarts (durable volumes
only needed once containers are reclaimed).\_

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
