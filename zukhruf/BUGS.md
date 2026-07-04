# zukhruf — Known Bugs

> Tracked defects in the runtime. Each entry: symptom → cause → why nothing recovers it → repro → fix direction.

## 1. `watch()` stream hangs forever when a pending turn's queue job is deleted by retention

**Status:** Practically resolved by Option A (`deleteAfterSeconds: 0` + commit-driven GC, `pg-boss.turn-queue.ts`), test-pinned by `pg-boss.turn-queue.retention.test.ts` (incl. a real-time load-bearing proof) + the runtime scenario tests. A **parked** turn's job is `cancelled` and, with `deleteAfterSeconds: 0`, is **never deleted** — so it can no longer disappear out from under its stream row. Commit-GC only deletes a job _after_ its turn has committed (stream already terminal), so it never strands a `queued` stream either. **Remaining (theoretical):** a `created`/queued job is still governed by `retentionSeconds` (14d, can't be 0), so a turn left queued behind a running turn for >14d would still orphan. Unreachable in practice — turns are bounded by `expireInSeconds`, and a gated follow-up becomes `cancelled` (parked), not `created`. The general guard is tracked as **TODO §2 "Startup reconciliation sweep"** (fail a non-terminal stream row with no live/queued job).

**Symptom.** `enqueue` returns `{ id, stream: watch(id) }` (`runtime.ts:208`). If the turn's queue job is deleted by pg-boss retention before it executes, the returned stream **never emits a chunk and never goes terminal** — the caller's consumer hangs forever. `observe().resume()` on that head behaves the same: non-terminal status, dead stream.

**Cause — two durable rows with different owners and lifetimes.** `enqueue` writes:

- a StreamStore row: `id` + status `queued`, **no `input`** (`manager.register(id)`, `runtime.ts:200`);
- a pg-boss job: carries the user message `input` (`queue.push({kind:'ask', …, input})`).

The user message content lives **only** in the pg-boss job. pg-boss deletes that job on its retention clock (`created` turn: `start_after + retentionSeconds`, ~14d; parked/`cancelled` turn: `deleteAfterSeconds`, ~7d — see `reference` below). The StreamStore is **not** owned by pg-boss and has no TTL, so its row stays at `queued` indefinitely. The half that survives (status) can't run the turn; the half that could (content) is gone.

**Why nothing recovers it.** Retention deletion is a silent maintenance `DELETE` — no dead-letter, no `onOrphaned` (those fire only for crashed _running_ jobs, `runtime.ts:257-264`). Nothing flips an orphaned `queued` stream to a terminal state.

**Repro sketch.** Enqueue a turn; before a worker executes it, delete its queue job (or let retention expire it). Hold the returned `watch(id)` stream → it never resolves. StreamStore status stays `queued`; the turn is un-runnable (no `input`).

**Reference.** pg-boss retention semantics (verified): drop query `plans.js:2004-2006`; `keep_until = start_after + retentionSeconds` (`plans.js:1458`); defaults `retentionSeconds` 14d (created/retry), `deleteAfterSeconds` 7d (terminal); no "never" for `created` jobs (`retentionSeconds: 0` rejected).

**Fix direction (not yet decided).** Options, none of which move un-executed content into the store:

- A reconciler/terminal-guard: when a consumer detects the backing queue job is gone, mark the orphaned `queued` stream terminal (e.g. `failed`) so `watch()`/`resume()` resolve instead of hanging.
- Make `watch()` on a non-executing turn status-aware / bounded rather than tailing forever.
- A sweep that fails StreamStore rows stuck at `queued` with no live job.
