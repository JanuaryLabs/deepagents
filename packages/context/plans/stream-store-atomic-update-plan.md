# Stream Store Atomic Update Plan

## Goal

Remove the application-shaped `claimStream` and `cancelStream` methods from
`StreamStore` without weakening stream lifecycle concurrency guarantees.

## Evidence from the previous implementation

The previous `StreamManager.persist()` implementation performed a separate
read, eligibility check, and status write:

1. `getStream(streamId)`
2. accept both `queued` and `running` as non-terminal
3. `updateStreamStatus(streamId, 'running')`
4. begin consuming the model stream

A live two-worker reproduction made both callers proceed (`[true, true]`). A
second live reproduction cancelled after the worker's eligibility read and the
worker still sampled once. The old unconditional status SQL also allowed late
writes to move `cancelled -> completed -> failed`.

The required behavior is therefore an atomic conditional state update, not the
two application-specific method names.

## Replacement API

Add one generic transactional store primitive:

```ts
type StreamUpdater = (stream: StreamData) => StreamUpdate | undefined;

abstract updateStream(
  streamId: string,
  update: StreamUpdater,
): Promise<{ stream: StreamData; updated: boolean }>;
```

Returning `undefined` aborts the update. `updated` identifies whether this
caller performed the transition, which cannot be inferred from the final
status when another worker may already have moved the stream to `running`.

`StreamManager` owns the lifecycle policy:

- execution claim: update only from `queued`
- cancellation: update only from `queued` or `running`

Adapters own transaction/locking mechanics:

- SQLite: `BEGIN IMMEDIATE`, read, updater, write, commit
- PostgreSQL: transaction plus `SELECT ... FOR UPDATE`

## Tasks

- [x] Add integration tests proving concurrent generic updates have one winner.
- [x] Add `StreamUpdate`, `StreamUpdater`, and `StreamUpdateResult` types.
- [x] Add abstract `updateStream` and remove abstract `claimStream` / `cancelStream`.
- [x] Implement transactional `updateStream` in SQLite.
- [x] Implement transactional `updateStream` in PostgreSQL.
- [x] Move claim and cancellation transition policy into `StreamManager`.
- [x] Convert test stores to the generic updater.
- [x] Preserve terminal-state protection for late completion, failure, and error chunks.
- [x] Run focused SQLite, PostgreSQL, and Zukhruf integration tests.
- [x] Run `nx run @deepagents/context:typecheck`.
- [x] Run `nx run @deepagents/experimental:typecheck`.
- [x] Finish the full context and experimental test suites and record unrelated
      baseline failures separately.

## Verification

- SQLite stream integration: 84 passed, 0 failed.
- PostgreSQL concurrent generic update: passed; exactly one caller updated.
- PostgreSQL late-cancellation protection: passed.
- Zukhruf cancellation-before-claim integration: passed with zero model calls.
- Experimental full suite: 129 passed, 0 failed.
- Context full suite: 1500 passed, 5 failed. None of the failures touch stream
  storage: two are Agent OS sandbox abort-output timing failures, and three are
  the existing user-ownership reconnect expectation mismatch across SQLite,
  PostgreSQL, and SQL Server.
- Context and experimental typechecks: passed.

## Non-goals

- No compatibility aliases for `claimStream` or `cancelStream`.
- No process-local mutex; it cannot coordinate independent processes or hosts.
- No Zukhruf-specific methods in `StreamStore`.
