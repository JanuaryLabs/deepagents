# Zukhruf — production-readiness backlog

> Remaining evidence and product hardening for Zukhruf itself. Ordered cheapest-evidence-first.
> See DESIGN.md for decided semantics.

## 1. Evidence (no behavior changes)

- [ ] Run the TurnQueue contract suite against **real Postgres** (withPostgresContainer), not just PGlite.
- [x] **Process-kill crash test** — SHIPPED (`queue/crash-recovery.integration.test.ts`, docker-gated): real child worker SIGKILLed mid-turn on real Postgres; heartbeat lapse → monitor fails job → DLQ → `onOrphaned` flips stream `failed` (with error) → chat unblocks → next turn runs; crashed turn never re-ran. ~16s.
- [ ] Multi-process contract run: two workers on one Postgres — serialization + concurrency cap hold across processes. (The crash test partially covers this: parent + child workers shared one queue.)

## 2. Hardening

- [x] **Conversation ownership gate**: the stored chat owner is authoritative. Directory lookup,
      execution, observation, explicit cancellation, host delivery, and approval reject a
      caller-supplied `userId` mismatch.
- [x] **Conversation-scoped turn identity**: the caller's idempotency key is deterministically
      scoped by `(userId, chatId)`. The returned durable stream ID cannot be replayed or explicitly
      cancelled through another conversation.
- [x] **Topology validation**: reserved metadata fails closed; non-root threads require an existing
      same-user, same-tree immediate parent, self-parenting is rejected, and persisted paths must
      already be canonical.
- [x] **Root metadata initialization CAS**: worker initialization preserves a concurrent host
      metadata write and retries against the fresh snapshot.
- [ ] **Startup reconciliation sweep**: non-terminal stream rows with no live/queued job → `failed`
      (covers register→push orphans beyond the retried-ask self-heal).
- [ ] **Host cancel, remaining queue fix**: `interrupt_agent` now cancels the exact queue job and
      removes queued copies immediately while active work retains FIFO ownership through handler
      exit, but `AgentObservation.cancel()` still cancels only the durable stream. Wire that
      existing host-facing path to the TurnQueue capability separately.
- [x] **Terminal stream transitions are monotonic**: completion, failure, error chunks, and
      cancellation update only queued/running rows. A committed cancellation cannot be overwritten
      by a late completion or failure.
- [x] **Cancel/setup race closed**: after sandbox acquisition the executor rechecks durable stream
      status before constructing the agent or calling the model, so a cancellation that lands while
      setup is blocked never starts sampling. Pinned in `root-metadata.integration.test.ts`.
- [x] **Cancel/execution claim race closed**: queued-to-running claim and queued/running-to-cancelled
      are atomic StreamStore transitions. A cancellation that wins cannot be overwritten by
      `persist()` and model sampling never starts.
- [x] **Cancel/provider-setup race closed**: after the execution claim, cancellation observation
      starts before `chat()` begins provider setup. Same-process cancellation signals active
      monitors immediately, while the durable watcher covers cross-process cancellation.
- [x] Persist the user message and assistant placeholder before sandbox acquisition in
      `AgentTurnExecutor`, so the ask remains in durable history when setup fails.
- [x] **Orphan cleanup split**: the DLQ worker deletes the failed source job in `finally`, so strict
      FIFO unblocks even when retryable terminal projection fails.
- [x] **Attempt-scoped orphan reconciliation**: mailbox activity is owned by `streamId`, so a stale
      callback cannot end a successor turn; stale retries also cannot rewind the thread's
      `lastTurnId`. Latest-turn metadata writes use transactional `updateChat`, and terminal projection reads
      the matching assistant turn instead of the current conversation head.

## 3. Structural blocker A — re-runs. APPROVAL-RESUME SHIPPED (regenerate deferred)

- [x] SDK-native approval verified (probe): needsApproval pauses through agent()/chat() untouched;
      approval-responded → SDK executes tool on continuation; deny → output-denied.
- [x] Runtime `approve()`/`deny()` verbs (idempotent reattach; benign-race reopen catch).
- [x] `AgentTurnExecutor` gate (park before chain/sandbox) + continuation path; TurnRef ask/continuation union.
- [x] Port: `ConsumeContext.park()` + `TurnQueue.resumeParked(chatId)`; pg-boss self-cancel/resume,
      continuation `priority: 1`; two contract tests (park/revive order; continuation outranks).
- [x] Runtime integration coverage for pause, approve, deny, queue-behind ordering, and concurrent/double approval.
- [x] Make approval response → stream reopen → continuation push → parked-turn revival an
      idempotently repairable transition. A retry repairs failures after the durable response claim.
- [x] Serialize concurrent approve-versus-deny with the required Zukhruf `ApprovalMutex` and wait for every approval in
      the last step before scheduling one continuation.
- [x] Keep the assistant message as the sole durable decision record while the mutex protects its
      complete read–validate–rewrite transition. Concurrent decisions for different sibling tool
      calls are both retained, and the SQLite mutex excludes independent processes.
- [x] Suppress child terminal projection while an approval remains unresolved, report Codex V2's
      model-facing `running`, and prove exactly one post-continuation `FINAL_ANSWER`.
- [x] A failed or cancelled continuation overrides approval-pause projection: parents receive the
      terminal result and `list_agents` reports `errored` or `interrupted`, never stale `running`.
- [x] A failed or cancelled continuation settles approved `approval-responded` parts to
      `output-error`, preserves denied siblings as `output-denied`, and resumes parked turns. The
      same reconciliation runs for normal settlement, orphan cleanup, and already-terminal replay,
      so later asks cannot remain stranded behind a dead approval.
- [x] An orphaned approval continuation gets one automatic replay only when every approved tool
      declares `recovery: 'idempotent'`; replay preserves the SDK `toolCallId`, while unsafe tools
      retain the no-retry `output-error` behavior.
- [x] `defineTool` preserves AI SDK tool() inference and adds the typed idempotent-recovery opt-in;
      `AgentDeclaration.tools` carries the extended tool set.
- [x] ~~Approval TTL / auto-deny — MANDATORY before production~~ **RESOLVED by Option A** (no TTL
      needed): the turns queue uses `deleteAfterSeconds: 0` so a parked (cancelled) job is never
      time-deleted, and **commit-driven GC** deletes a job only once its turn commits to the chain
      (`pg-boss.turn-queue.ts`). A parked turn awaits its approval indefinitely, zero loss, no
      auto-deny. Accepted consequence: an abandoned approval keeps its parked job forever (bounded;
      folds into per-chat sandbox GC below). Pinned by `pg-boss.turn-queue.retention.test.ts` (incl.
      a real-time load-bearing proof via `timebox`) and the runtime approval scenarios.
- [ ] Cancel-of-paused-turn = deny? (paused stream is terminal; cancel currently no-ops). Current
      no-op behavior is now **characterization-tested** (`runtime.integration.test.ts`: "cancelling a
      paused turn is currently a no-op"), so changing it to mean deny is a deliberate, visible break.
- [ ] Sandbox-bound approval tools (approve-before-bash) — needs per-turn tool factories.
- [ ] run.ts approval showcase.
- [ ] Regenerate (attempt-level identity split, branches-as-attempts): deferred; design when needed.

## 4. Turn payload + multi-agent

- [x] First-class independent-thread mailbox foundation: caller-owned durable `MailboxStore`,
      Codex-shaped communication envelope, queue-only/trigger-turn delivery, FIFO runtime
      consumption, transactional cross-worker active-turn handoff, conversation-scoped wake IDs,
      and SQLite contention handling.
- [x] Root-tree topology + canonical paths: `new AgentRuntime(root, options)` compiles the
      declaration graph, `AgentThread` persists tree/path/parent/declaration identity, and
      `AgentDirectory` confines lookup to the sender's user and tree. No separate thread store is
      needed.
- [x] Model-facing independent-thread tools: direct AI SDK `spawn_agent`, `send_message`,
      `followup_task`, and `list_agents` tools receive runtime state through tool context;
      every terminal non-root turn forwards idempotent queue-only `FINAL_ANSWER` mail to its direct
      parent with completed, failed, or cancelled status.
- [x] `list_agents` derives the current tree from ContextStore metadata, persisted stream state, and
      required TurnQueue activity, supports relative/absolute path-prefix filtering, and reports
      canonical paths, queued follow-ups, completion text, and the last persisted task without adding
      a registry.
- [x] Model-facing `wait_agent` observes only the caller's durable mailbox without consuming it,
      returns a host-configurable bounded timeout result, releases across runtime instances, and
      aborts with its turn. Live steer is intentionally absent because Zukhruf has no in-turn steer
      channel.
- [x] Model-facing `interrupt_agent` resolves relative/canonical paths, rejects root/self, cancels
      running or oldest queued work across runtime instances, projects one terminal parent message,
      returns the previous status, and leaves the target reusable. Terminal and approval-paused
      targets no-op; no broader close/resume/shutdown lifecycle was added.
- [x] Port Codex V2 host configuration for separate root/subagent guidance, spawn usage text,
      validated OpenAI Responses tool namespaces, and wait bounds. Keep collaboration tools on the
      direct model surface when `nonCodeModeOnly` is true.
- [ ] Add a nested code-mode executor before accepting `nonCodeModeOnly: false`; current Zukhruf has
      no `functions.exec`-equivalent surface, so the unsupported value fails explicitly.
- [x] Match Codex V2 collaboration output/status contracts: canonical `{task_name}` spawn output,
      empty send/follow-up success text, strict list/wait/interrupt output schemas, approval pauses
      as `running`, and missing interrupt targets as `not_found`. `shutdown` is accepted by the
      compatibility status schema but has no producer until Zukhruf gains a shutdown lifecycle.
- [x] Mailbox consumption follows the simpler Codex queue shape: FIFO drain consumes pending mail;
      no claim/ack/lease/redelivery protocol or startup crash reconciliation.
- [x] Migrate `demo/zukhruf-durable-turns` from blocking `agent.asTool()` composition to a durable
      independent specialist chat and asynchronous `FINAL_ANSWER` consumption.
- [ ] `TurnRef.input: string` → rich message (UIMessage-shaped: parts, attachments-as-references) + host context (agentId, modelId, surface context, tools, elements).
- [ ] Port stays payload-opaque: contract requires JSON-round-trip fidelity only.
- [x] Multi-agent shape: public `defineAgent({name, subagents})` with a required stable name, one
      runtime/TurnQueue, internal declaration lookup, deterministic path-derived child identities,
      and dynamic chat topology persisted in existing `ContextStore` metadata.
- [x] Reject padded declaration names so persisted and model-facing identities are canonical.

## 5. Remaining independent work

- [x] Keep runtime-owned wiring classes and injected collaboration-tool implementations internal.
      Customers compose through `AgentRuntime`, the DSL, and the store/queue adapters.
- [ ] Per-chat sandbox GC policy (nothing reclaims dead chats' containers).
- [ ] Queued-turn visibility for observers (resume() can't see unstarted turns).
- [ ] CI: affected tests run, but `continue-on-error: true` means failures do not block merging.
