# zukhruf — convergence with Limerence's background layer

> Goal: make "replace Limerence's `core/background/` with zukhruf" a boring mechanical
> migration. Ordered cheapest-evidence-first. See DESIGN.md for decided semantics.

## 1. Evidence (no behavior changes)

- [ ] Run the TurnQueue contract suite against **real Postgres** (withPostgresContainer), not just PGlite.
- [x] **Process-kill crash test** — SHIPPED (`queue/crash-recovery.integration.test.ts`, docker-gated): real child worker SIGKILLed mid-turn on real Postgres; heartbeat lapse → monitor fails job → DLQ → `onOrphaned` flips stream `failed` (with error) → chat unblocks → next turn runs; crashed turn never re-ran. ~16s.
- [ ] Multi-process contract run: two workers on one Postgres — serialization + concurrency cap hold across processes. (The crash test partially covers this: parent + child workers shared one queue.)
- [ ] Adapt Limerence's queue layer (`requestChatRun` / worker) into a TurnQueue-shaped harness and run the contract suite against it — find real behavioral divergence, give Limerence regression insurance for free.

## 2. Hardening (known gaps vs Limerence)

- [ ] **Startup reconciliation sweep**: non-terminal stream rows with no live/queued job → `failed` (covers register→push orphans beyond the retried-ask self-heal; Limerence's `stream-recovery.ts` is the reference).
- [ ] **Cancel, both fixes**: cancel the queue job too (free the FIFO slot immediately, not on claim); guard terminal statuses against late-error overwrite (`cancelled` must never become `failed`).
- [ ] **Per-queue retry policy**: interactive turns `retryLimit: 0`; automated/scheduled turns retryable (Limerence automations use `retryLimit: 2`).
- [ ] Persist the user message before sandbox acquisition in `executeTurn` (ask survives setup failure — Limerence does this deliberately).

## 3. Structural blocker A — re-runs. APPROVAL-RESUME SHIPPED (regenerate deferred)

- [x] SDK-native approval verified (probe): needsApproval pauses through agent()/chat() untouched;
      approval-responded → SDK executes tool on continuation; deny → output-denied.
- [x] Runtime `approve()`/`deny()` verbs (idempotent reattach; benign-race reopen catch).
- [x] `executeTurn` gate (park before chain/sandbox) + continuation path; TurnRef ask/continuation union.
- [x] Port: `ConsumeContext.park()` + `TurnQueue.resumeParked(chatId)`; pg-boss self-cancel/resume,
      continuation `priority: 1`; two contract tests (park/revive order; continuation outranks).
- [x] 5 runtime integration tests (pause, approve, deny, queue-behind order, double-approve). 25/25 green.
- [x] `defineTool` = AI SDK tool() passthrough; `AgentDeclaration.tools`.
- [x] ~~Approval TTL / auto-deny — MANDATORY before production~~ **RESOLVED by Option A** (no TTL
      needed): the turns queue uses `deleteAfterSeconds: 0` so a parked (cancelled) job is never
      time-deleted, and **commit-driven GC** deletes a job only once its turn commits to the chain
      (`pg-boss.turn-queue.ts`). A parked turn awaits its approval indefinitely, zero loss, no
      auto-deny. Accepted consequence: an abandoned approval keeps its parked job forever (bounded;
      folds into per-chat sandbox GC below). Pinned by `pg-boss.turn-queue.retention.test.ts` (incl.
      a real-time load-bearing proof via `timebox`) + 5 runtime scenario tests.
- [ ] Cancel-of-paused-turn = deny? (paused stream is terminal; cancel currently no-ops). Current
      no-op behavior is now **characterization-tested** (`runtime.integration.test.ts`: "cancelling a
      paused turn is currently a no-op"), so changing it to mean deny is a deliberate, visible break.
- [ ] Sandbox-bound approval tools (approve-before-bash) — needs per-turn tool factories.
- [ ] run.ts approval showcase.
- [ ] Regenerate (attempt-level identity split, branches-as-attempts): deferred; design when needed.

## 4. Structural blocker B — turn payload + multi-agent

- [ ] `TurnRef.input: string` → rich message (UIMessage-shaped: parts, attachments-as-references) + host context (agentId, modelId, surface context, tools, elements).
- [ ] Port stays payload-opaque: contract requires JSON-round-trip fidelity only.
- [ ] Decide multi-agent shape: parameterized single declaration (per-turn variance via payload → fragments) vs declaration registry vs runtime-per-agent + queue-per-agent.

## 5. Migration mechanics (last)

- [ ] Product decision: 409 + client queueing vs durable server FIFO for mid-turn messages.
- [ ] pg-boss bump for Limerence (^12.12 → 12.24+: heartbeatSeconds, key_strict_fifo).
- [ ] Queue policy cutover plan (policy is immutable — new queue + drain old).
- [ ] Client contract migration: resume endpoints, `getResumableStreamId` semantics, stop() wiring.

## Independent (not migration-gated)

- [ ] Per-chat sandbox GC policy (nothing reclaims dead chats' containers).
- [ ] Queued-turn visibility for observers (resume() can't see unstarted turns).
- [ ] CI: nothing runs zukhruf's test suites automatically.
