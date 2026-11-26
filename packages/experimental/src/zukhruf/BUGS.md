# Zukhruf — Known Bugs

> Tracked defects in the runtime. Each entry: symptom → cause → why nothing recovers it → repro →
> fix direction. Codex parity work and intentional divergences belong in TODO.md and DESIGN.md, not
> in this defect ledger.

## 1. `watch()` stream hangs forever when a pending turn's queue job is deleted by retention

**Status:** Resolved. Parked and completed turns never lose their job: `deleteAfterSeconds: 0` plus commit-driven GC in `pg-boss.turn-queue.ts` (`pg-boss.turn-queue.retention.test.ts`). A `created` job is still deleted once it outlives `retentionSeconds` (14d, which cannot be zero); the turn is then unrecoverable, so the first `work()` after the gap fails its stream instead of letting it hang (agent-backlog #682, DESIGN.md "Lost turns"). Its `watch()` and `observe().resume()` end with the error `turn lost: its queue job was deleted before it ran`.

**Symptom.** `AgentHost.enqueue` returns a conversation-scoped durable `{ id, stream: watch(id) }`.
If the turn's queue job is deleted by pg-boss retention before it executes, the returned stream
**never emits a chunk and never goes terminal** — the caller's consumer hangs forever.
`observe().resume()` on that head behaves the same: non-terminal status, dead stream.

**Cause — two durable rows with different owners and lifetimes.** `enqueue` writes:

- a StreamStore row: `id` + status `queued`, **no message payload**
  (`AgentControlPlane.enqueue` registers it);
- a pg-boss job: carries the complete UI message
  (`queue.push({kind:'message', …, message, trigger})`).

The user message content lives **only** in the pg-boss job. A still-`created` job is deleted on its
retention clock (`start_after + retentionSeconds`, ~14d). Zukhruf disables time deletion for
terminal jobs with `deleteAfterSeconds: 0`, so parked approvals are not exposed to this defect. The
StreamStore is **not** owned by pg-boss and has no TTL, so a retained status row stays `queued`
indefinitely after its created job disappears. The half that survives (status) cannot run the turn;
the half that could (content) is gone.

**Why it could not run again.** Retention deletion is a silent maintenance `DELETE` — no dead-letter and no `AgentRuntime` orphan callback (those fire only for crashed _running_ jobs) — and the deleted job held the only copy of the message.

**Repro sketch.** Enqueue a turn; before a worker executes it, delete its queue job (or let retention expire it). Hold the returned `watch(id)` stream → it never resolves. StreamStore status stays `queued`; the turn is un-runnable (no message payload).

**Reference.** pg-boss retention semantics (verified): drop query `plans.js:2004-2006`;
`keep_until = start_after + retentionSeconds` (`plans.js:1458`); defaults `retentionSeconds` 14d
(created/retry), `deleteAfterSeconds` 7d (terminal); no "never" for `created` jobs
(`retentionSeconds: 0` rejected). Zukhruf overrides only the terminal setting to zero.

**Fix.** `AgentRuntime.work()` sweeps queued streams once its consumer is registered: a stream older than the queue's retention that has no turn-queue job in any state and no pending dead-letter job (a completed or failed one is done, #5870) is moved `queued` → `failed` by a compare-and-set on its row. Pinned by the `runtime.integration.test.ts` retention scenarios and `lost-turns.postgres.integration.test.ts`.
