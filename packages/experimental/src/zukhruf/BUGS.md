# Zukhruf — Known Bugs

> Tracked defects in the runtime. Each entry: symptom → cause → why nothing recovers it → repro → fix direction.

## 1. `watch()` stream hangs forever when a pending turn's queue job is deleted by retention

**Status:** Resolved for parked and completed turns by `deleteAfterSeconds: 0` plus commit-driven GC in `pg-boss.turn-queue.ts`, test-pinned by `pg-boss.turn-queue.retention.test.ts` and the runtime scenarios. A **parked** turn's job is `cancelled` and is never time-deleted; commit-GC removes a job only after its stream is terminal. **Remaining:** a `created`/queued job is still governed by `retentionSeconds` (14d, which cannot be zero). A sufficiently deep or repeatedly blocked backlog can therefore outlive retention even though each running turn is bounded by `expireInSeconds`, leaving the surviving stream row orphaned. The guard is tracked in **TODO §2 "Startup reconciliation sweep"**: fail every non-terminal stream row with no live or queued job.

**Symptom.** `AgentRuntime.enqueue` returns a conversation-scoped durable `{ id, stream: watch(id) }`.
If the turn's queue job is deleted by pg-boss retention before it executes, the returned stream
**never emits a chunk and never goes terminal** — the caller's consumer hangs forever.
`observe().resume()` on that head behaves the same: non-terminal status, dead stream.

**Cause — two durable rows with different owners and lifetimes.** `enqueue` writes:

- a StreamStore row: `id` + status `queued`, **no `input`** (`AgentControlPlane.enqueue` registers it);
- a pg-boss job: carries the user message `input` (`queue.push({kind:'ask', …, input})`).

The user message content lives **only** in the pg-boss job. A still-`created` job is deleted on its
retention clock (`start_after + retentionSeconds`, ~14d). Zukhruf disables time deletion for
terminal jobs with `deleteAfterSeconds: 0`, so parked approvals are not exposed to this defect. The
StreamStore is **not** owned by pg-boss and has no TTL, so a retained status row stays `queued`
indefinitely after its created job disappears. The half that survives (status) cannot run the turn;
the half that could (content) is gone.

**Why nothing recovers it.** Retention deletion is a silent maintenance `DELETE` — no dead-letter and no `AgentRuntime` orphan callback (those fire only for crashed _running_ jobs). Nothing flips an orphaned `queued` stream to a terminal state.

**Repro sketch.** Enqueue a turn; before a worker executes it, delete its queue job (or let retention expire it). Hold the returned `watch(id)` stream → it never resolves. StreamStore status stays `queued`; the turn is un-runnable (no `input`).

**Reference.** pg-boss retention semantics (verified): drop query `plans.js:2004-2006`;
`keep_until = start_after + retentionSeconds` (`plans.js:1458`); defaults `retentionSeconds` 14d
(created/retry), `deleteAfterSeconds` 7d (terminal); no "never" for `created` jobs
(`retentionSeconds: 0` rejected). Zukhruf overrides only the terminal setting to zero.

**Fix direction.** The tracked direction is startup reconciliation; related options, none of which
move unexecuted content into the store, are:

- A reconciler/terminal-guard: when a consumer detects the backing queue job is gone, mark the orphaned `queued` stream terminal (e.g. `failed`) so `watch()`/`resume()` resolve instead of hanging.
- Make `watch()` on a non-executing turn status-aware / bounded rather than tailing forever.
- A sweep that fails StreamStore rows stuck at `queued` with no live job.
