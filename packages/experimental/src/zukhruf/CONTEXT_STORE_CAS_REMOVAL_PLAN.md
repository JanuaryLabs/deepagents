# Remove Application CAS From ContextStore

> Status: implemented; focused and package-level verification complete
>
> Updated on 2026-07-23: approval coordination is a queue-native command flow.
> The API only reads ContextEngine and enqueues a deterministic approval job;
> the worker owns the persisted decision and direct original-turn resumption.
>
> This file is the durable execution record for removing the staged
> `compareAndSetChatMetadata` and `compareAndSetMessageData` APIs without
> regressing concurrent behavior.

## Clean-break rule

- No backward-compatibility overloads.
- No legacy aliases, deprecated methods, fallback paths, or compatibility shims.
- Delete superseded code, tests, exports, schema, and documentation together.
- Preserve observable behavior, not the staged implementation.

## Proven pre-change defects

Both failures were reproduced against the real, unchanged blind-write store
methods with deterministic barriers forcing callers to read the same snapshot.

### Approval decision race

The pre-change runtime read an assistant message, blindly rewrote the same
message ID, and only then raced to reopen the stream. The probe produced:

```json
{
  "calls": [
    { "operation": "approve", "fulfilled": true, "scheduled": true },
    { "operation": "deny", "fulfilled": true, "scheduled": false }
  ],
  "finalStoredDecision": false,
  "continuationWasScheduledBy": "approve"
}
```

Both API calls fulfilled, `approve` scheduled the continuation, but the same
assistant message ultimately contained a denial.

### Usage accumulation race

The pre-change `trackUsage` implementation re-read the chat and then blindly
replaced its metadata. Two concurrent increments expected to total 330 stored
only 220:

```json
{
  "expectedTotal": 330,
  "stored": {
    "inputTokens": 200,
    "outputTokens": 20,
    "totalTokens": 220
  }
}
```

This contradicted the documented guarantee that concurrent `trackUsage` calls
are safe.

## Required invariants

### Chat updates

- Concurrent usage increments are both accumulated.
- Concurrent metadata patches preserve unrelated keys.
- Initial metadata never erases a concurrent host update.
- Missing chats still fail explicitly.
- Callers can abort an update without writing.

### Approvals

- The existing assistant message remains the canonical and model-facing state.
- The API process never mutates the assistant message.
- Repeated identical decisions are idempotent.
- Concurrent conflicting commands address one deterministic job ID; the first
  queued command becomes the durable winner.
- A conflict is immediate only after the opposite decision is persisted.
- Concurrent decisions for different sibling tool calls are both retained.
- The final sibling approval job resumes the original turn exactly once.
- Parked turns retain their order behind approval commands.
- Queue/revival failures remain retry-repairable.
- Failed or cancelled continuations settle approval parts and unblock the chat.
- Coordination works across independent runtime processes, not only within one
  JavaScript process.

## Chosen design

### Atomic chat mutation through the existing operation

Delete `compareAndSetChatMetadata` and the concrete `updateChatMetadata` retry
helper. Change the existing `ContextStore.updateChat` contract into a
synchronous updater that each adapter executes while holding its native
transactional write lock:

```ts
updateChat(
  chatId: string,
  update: (chat: StoredChatData) =>
    | Partial<Pick<ChatData, 'title' | 'metadata'>>
    | undefined,
): Promise<StoredChatData>;
```

- SQLite: `BEGIN IMMEDIATE`, read, update, commit.
- PostgreSQL: transaction plus `SELECT ... FOR UPDATE`.
- SQL Server: transaction plus `UPDLOCK, HOLDLOCK`.

The updater is synchronous so arbitrary asynchronous work is never performed
while a database row lock is held. This is a generic atomic chat mutation, not
a Zukhruf-specific primitive.

### Queue-native approval commands

Delete `compareAndSetMessageData`. Approval decisions continue to live in the
same assistant message, but only the turn worker mutates them.

- The API reads `approval.id` from the persisted tool part.
- The queue job ID is
  `uuidv5("approval:" + approvalId, conversationNamespace)`.
- `singletonKey = chatId` preserves conversation-wide serialization.
- pg-boss job-ID uniqueness chooses the first concurrently queued decision.
- Different sibling approval IDs create different jobs.
- The worker rechecks ContextEngine before applying the decision.
- `approval-responded` remains the permanent idempotency record after queue
  cleanup.
- The final sibling job reopens and resumes the original turn directly.
- Recovery-only continuation jobs repair a worker crash after persistence.

## Execution tasks

### Slice 1 — durable plan and proof

- [x] Record the clean-break constraint.
- [x] Record the deterministic approval lost-update reproduction.
- [x] Record the deterministic usage lost-update reproduction.
- [x] Keep public integration tests that prove both invariants without exposing
      internal classes through test-only exports.

### Slice 2 — atomic `updateChat`

- [x] Replace the `ContextStore.updateChat` signature with the updater contract.
- [x] Implement transactional updater semantics in SQLite.
- [x] Implement transactional updater semantics in PostgreSQL.
- [x] Implement transactional updater semantics in SQL Server.
- [x] Move `ContextEngine` initial metadata merge, public metadata updates, and
      usage accumulation onto the atomic updater.
- [x] Move `AgentDirectory` root initialization and latest-turn updates onto the
      same generic updater.
- [x] Remove `compareAndSetChatMetadata` and `updateChatMetadata` everywhere.
- [x] Replace CAS-specific tests with public concurrent-update behavior tests.
- [x] Run `nx run context:typecheck` and the focused context integration tests.

### Slice 3 — Zukhruf approval commands

- [x] Add approval turns to `TurnQueue`.
- [x] Derive deterministic queue identity from the persisted approval ID.
- [x] Keep `AgentRuntimeOptions` free of a separate approval coordinator.
- [x] Make API approval calls read-only except for queue insertion.
- [x] Put approval read–validate–rewrite and direct resumption in the worker.
- [x] Retain a recovery-only continuation path for crash reconciliation.
- [x] Remove `compareAndSetMessageData` from `ContextStore` and all adapters.
- [x] Remove message-CAS fixtures and adapter contract tests.
- [x] Replace CAS-barrier runtime tests with public concurrent approval tests
      driven through `AgentRuntime`.
- [x] Run `nx run experimental:typecheck` and focused Zukhruf integration tests.

### Slice 4 — cleanup and final verification

- [x] Remove stale CAS language from `DESIGN.md`, `TODO.md`, and the completed
      runtime refactor plan.
- [x] Keep demos on the standard queue construction path.
- [x] Verify no CAS symbols remain outside this historical plan with `rg`.
- [x] Run `nx run context:test` (1495/1499 pass; four unrelated existing tests
      fail: one Agent OS abort timing assertion and three stored-owner
      reconnection expectations).
- [x] Run `nx run experimental:test` (129/129 pass).
- [x] Run both package typecheck targets.
- [x] Inspect the final diff for unrelated or compatibility-only code.

## Progress log

- 2026-07-14: Plan created. Pre-change approval and usage races reproduced.
  Clean-break design selected: transactional `updateChat` plus a
  Zukhruf-owned approval mutex around mutations of the same assistant message
  (superseded on 2026-07-23 by queue-native approval commands).
- 2026-07-14: Transactional chat updater implemented in all three adapters;
  chat-specific CAS APIs and tests removed. Focused context concurrency tests
  pass 4/4.
- 2026-07-14: Initial Zukhruf approval mutex implemented; message CAS removed
  from every context adapter. Approval runtime tests pass 29/29, and a separate
  integration test proves SQLite exclusion across independent OS processes. This
  mutex path was later removed when approval coordination moved into the turn
  queue.
- 2026-07-14: Full experimental suite passes 129/129. Full context suite passes
  1495/1499; its four failures are outside this change and the focused context
  concurrency suite passes 4/4. Both package typechecks pass.
- 2026-07-23: Caller-side approval coordination was replaced by deterministic
  queue-native approval commands. Cross-process approval races now converge on
  one pg-boss job, while ContextEngine remains the permanent result.
