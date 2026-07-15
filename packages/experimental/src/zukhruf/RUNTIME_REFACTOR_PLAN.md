# Zukhruf runtime refactor plan

> Status: completed on 2026-07-14. All eight implementation slices passed the package typecheck
> and test target before the next slice began; final verification is recorded after the last slice.
>
> Goal: split `runtime.ts` into cohesive domain and runtime classes without changing Zukhruf's
> durable-turn, approval, mailbox, routing, or independent-agent behavior.

## Refactor contract

This work changes structure in small, reviewable slices. Every slice must leave the package usable
and verified before the next slice starts.

The runtime behavior that must remain invariant:

- enqueue deterministically scopes a caller-supplied idempotency key to the conversation, registers
  that durable turn id, and returns it before pushing the turn;
- `TurnQueue` remains the durable execution scheduler and FIFO authority;
- `MailboxStore` remains the durable pending-message authority;
- mailbox payloads never move into `TurnQueue`;
- root metadata is initialized by worker execution, not enqueue;
- root and child agents retain independent conversation and queue identities;
- queue-only mail does not wake an idle target;
- trigger-turn mail is stored before its payload-free wake is scheduled;
- active-turn mailbox delivery retains its safe-step and serialized-fallback behavior;
- successful child completion produces queue-only `FINAL_ANSWER` mail for the direct parent;
- approval and denial remain idempotent and preserve parked-turn ordering;
- cancel, observe, stream replay, crash reconciliation, and sandbox lifetime remain unchanged.

The source-level API is class-based: path operations belong to the `AgentPath` value object and the
host lifecycle belongs to `AgentRuntime`.

All other externally observable behavior is preserved.

## Target ownership

```text
AgentRuntime
├── AgentTurnExecutor
├── ApprovalController
└── AgentControlPlane
    ├── AgentTurnId
    ├── AgentDeclarationRegistry
    ├── AgentStatusProjector
    ├── AgentDirectory
    │   ├── AgentThread
    │   └── AgentPath
    └── MailboxCoordinator
        ├── MailboxStore
        └── TurnQueue
```

### Boundary rules

- `AgentControlPlane` owns multi-agent coordination, not model execution.
- `AgentControlPlane` must not import `agent`, `chat`, `ContextEngine`, or sandbox factories.
- `AgentStatusProjector` owns transcript-backed list status and terminal-result projection.
- `AgentTurnExecutor` owns one model turn and must not scan agent trees or create child chats.
- `AgentDirectory` is backed by the existing `ContextStore`; no new thread store or repository port.
- `MailboxCoordinator` composes the existing `MailboxStore` and `TurnQueue`; it replaces neither.
- Helper behavior belongs to the class whose invariant it protects. Do not introduce static-only
  utility classes merely to hide floating functions.
- Dependencies flow from `AgentRuntime` into collaborators. Collaborators never import or construct
  `AgentRuntime`.

## Slice 0 — establish the baseline

### Purpose

Prove the current dirty checkout is green before moving code. This is evidence only; no production
structure changes.

### Work

- Record the current Zukhruf-related diff and preserve all staged and unstaged user work.
- Run the current experimental package tests and typecheck through Nx.
- Confirm that existing integration coverage exercises:
  - declaration validation;
  - root metadata initialization;
  - independent child dispatch and spawn;
  - sibling messaging and follow-up wakes;
  - agent listing and status projection;
  - mailbox durability and active-turn delivery;
  - approvals, cancellation, observation, crash handling, and FIFO ordering.
- Add a characterization integration test only if an invariant above is not already observable.

### Verification

```sh
nx run @deepagents/experimental:typecheck
nx run @deepagents/experimental:test
```

### Exit criteria

- The baseline result is known before any extraction.
- No implementation file changed unless a missing characterization test was required.
- Nothing is staged or committed unless explicitly requested.

## Slice 1 — extract `AgentDeclarationRegistry`

### Purpose

Move immutable declaration-graph compilation and lookup out of `runtime.ts` first. This is the
lowest-risk boundary because it is synchronous, construction-time behavior.

### Work

- Add `agent-declaration-registry.ts` containing `AgentDeclarationRegistry`.
- The constructor recursively indexes declarations and rejects blank or duplicate names.
- Expose narrow methods such as `root`, `get(name)`, and direct-subagent lookup.
- Replace `compileDeclarationGraph` and direct map access in `runtime.ts`.
- Keep the registry independent of stores, streams, queues, and model execution.

### Behavioral proof

- Existing declaration-graph integration tests pass unchanged in meaning.
- Unknown metadata declaration names still fail with the same useful diagnostic.

### Exit criteria

- No declaration traversal remains in `runtime.ts`.
- No second declaration index exists elsewhere.

## Slice 2 — introduce `AgentPath` and `AgentThread`

### Purpose

Give agent addressing and durable thread identity explicit domain owners.

### Work

- Replace the branded-string path helpers with an `AgentPath` value object.
- `AgentPath` owns parsing, root creation, descendant resolution, prefix membership, root detection,
  and string serialization.
- Add `AgentThread` for one durable agent instance:
  - `ConversationId`;
  - tree id;
  - canonical `AgentPath`;
  - parent chat id;
  - declaration name.
- `AgentThread` owns conversion to and from the reserved ContextStore metadata shape.
- Preserve plain strings at persistence, tool-input, tool-output, and model-message boundaries.
- Remove `conversationKey`-style identity formatting from the domain model; infrastructure classes
  may keep private key methods where required for in-memory maps.

### Behavioral proof

- Existing agent-path integration tests cover absolute, relative, invalid, and prefix cases.
- Existing root-metadata tests prove unrelated chat metadata is still preserved.
- Stored metadata remains byte-for-byte equivalent in shape.

### Exit criteria

- No floating path parser, resolver, or prefix matcher remains.
- No code outside `AgentThread` knows the reserved metadata encoding.

## Slice 3 — extract `AgentDirectory`

### Purpose

Centralize durable agent-instance discovery and mutation without inventing another store.

### Work

- Add `agent-directory.ts` backed directly by `ContextStore`.
- Move these operations into `AgentDirectory`:
  - initialize or load the root thread;
  - load a thread by conversation identity;
  - list one agent tree;
  - resolve a canonical or relative target within the sender's tree;
  - verify path uniqueness;
  - create an independent child thread.
- Absorb the implementation currently split across `agent-router.ts`, `agent-metadata.ts`,
  `spawn-agent.ts`, `list-agents.ts`, and `runtime.ts` metadata scans.
- Keep status projection out of the directory; it returns agent threads, not UI/tool status objects.

### Behavioral proof

- Root initialization still happens only when the worker resolves the first root turn.
- Paths cannot cross user or tree boundaries.
- Duplicate child paths still fail before queueing a child turn.
- Child chats retain separate ids, histories, mailboxes, and TurnQueue keys.

### Exit criteria

- `ContextStore.listChats()` tree scans occur only inside `AgentDirectory`.
- Runtime and collaboration tools no longer read or merge Zukhruf metadata directly.

## Slice 4 — extract `MailboxCoordinator`

### Purpose

Give mailbox delivery and wake coordination one owner while preserving the store/scheduler split.

### Work

- Add `mailbox/coordinator.ts` containing `MailboxCoordinator`.
- Move into it:
  - validate-and-store delivery;
  - queue-only versus trigger-turn policy;
  - store-before-wake ordering;
  - mailbox wake coalescing;
  - wake stream registration and push-failure status handling;
  - active-turn tracking and serialized fallback wakes;
  - FIFO drain access used by turn execution.
- Make `conversationKey` a private coordinator method.
- Keep `MailboxStore` and `TurnQueue` as existing caller-supplied ports.
- Remove the floating receive orchestration once all callers use the coordinator.

### Behavioral proof

- Mailbox store contract and SQLite durability tests remain green.
- Mailbox runtime and defect suites preserve queue-only, trigger-turn, safe-boundary, fallback-wake,
  duplicate-wake, and accepted failure-window semantics.

### Exit criteria

- Runtime contains no mailbox wake maps or active-mailbox-turn maps.
- `MailboxStore` remains free of execution scheduling concerns.
- `TurnQueue` still carries no communication payload.

## Slice 5 — introduce `AgentControlPlane`

### Purpose

Create the agreed application-level class after its durable primitives have concrete owners.

### Work

- Add `agent-control-plane.ts` containing `AgentControlPlane`.
- Compose `AgentDeclarationRegistry`, `AgentDirectory`, `MailboxCoordinator`, and
  `AgentStatusProjector`.
- Move these operations behind control-plane methods:
  - resolve the declaration and thread for an executing conversation;
  - enqueue an initial turn for a thread;
  - spawn an independent child agent;
  - send queue-only mail;
  - send a waking follow-up task;
  - list agents and project their current statuses;
  - project successful child completion to its parent.
- Derive public ask stream IDs with `AgentTurnId`, scoped by conversation ownership, before stream
  registration or queueing.
- Replace the raw-store-heavy `AgentToolContext` with:
  - the control plane;
  - an actor/execution context describing the current thread, declaration, and turn.
- Keep the AI SDK tool exports as thin schema-and-description adapters that immediately delegate to
  control-plane methods.
- Remove collaboration-tool injection duplication between `defineAgent` and turn execution while
  retaining the same model-visible tool set.

### Behavioral proof

- The existing control-plane integration suite remains end-to-end: the model calls actual tools,
  tools delegate through their AI SDK context, and durable stores/queues show the result.
- Spawn still returns before the child runs.
- Successful child completion still reaches only the direct parent as queue-only mail.
- Listing retains canonical paths, subtree filtering, task text, results, and statuses.

### Exit criteria

- Collaboration tools receive no raw `ContextStore`, `StreamStore`, enqueue callback, or delivery
  callback.
- `AgentControlPlane` contains no model sampling, `ContextEngine`, or sandbox code.

## Slice 6 — extract `AgentTurnExecutor`

### Purpose

Separate the execution/data plane from host lifecycle and multi-agent coordination.

### Work

- Add `agent-turn-executor.ts` containing `AgentTurnExecutor`.
- Move the current `executeTurn` and `executeTurnImpl` flow into the class.
- The executor owns:
  - terminal-stream idempotency checks;
  - approval gating and parking checks;
  - ContextEngine construction and instruction seeding;
  - ask, mailbox, and continuation chain preparation;
  - mailbox-to-UIMessage rendering as private methods;
  - sandbox acquisition;
  - atomic StreamStore execution claim after sandbox acquisition and before model construction;
  - collaboration-tool injection;
  - AI SDK `agent()` and `chat()` construction;
  - safe-step mailbox preparation;
  - worker-abort wiring;
  - stream persistence;
  - reporting successful completion to `AgentControlPlane`.
- Bind the queue consumer to `executor.execute` without a floating adapter function.

### Behavioral proof

- Runtime background-executor tests remain green across asks, continuations, mailbox turns,
  cancellation, observation, duplicate delivery, FIFO, and cross-chat concurrency.
- Crash-recovery behavior remains unchanged.
- The executor never creates child threads or resolves routing targets itself.

### Exit criteria

- `runtime.ts` contains no `agent()`, `chat()`, sandbox, prompt rendering, or abort-controller code.
- `AgentTurnExecutor` has one public behavior: execute one queued turn.

## Slice 7 — extract `ApprovalController`

### Purpose

Isolate the durable approval continuation state machine from the runtime façade.

### Work

- Add `approval-controller.ts` containing `ApprovalController`.
- Move pending-tool lookup, approval/denial mutation, chain continuation, stream reopening,
  continuation queueing, benign race reattachment, and parked-turn revival into it.
- Make pending-tool classification a private method owned by the controller.
- Expose explicit `approve(conversation, input)` and `deny(conversation, input)` methods.

### Behavioral proof

- Approval, denial, double approval, queue-behind, cancellation, and concurrent-approval tests remain
  green.
- Tool output and denial message shapes remain unchanged.

### Exit criteria

- Runtime contains no UI tool-part state mutation.
- Approval behavior has one owner and no duplicate queue-continuation logic.

## Slice 8 — introduce the `AgentRuntime` host façade

### Purpose

Finish with a thin host-facing composition root after all meaningful behavior already lives in named
collaborators.

### Work

- Add `AgentRuntime` in `agent-runtime.ts` and remove `runtime.ts`.
- Constructor: `new AgentRuntime(rootDeclaration, options)`.
- Construct and wire the registry, directory, mailbox coordinator, control plane, executor, stream
  manager, and approval controller.
- Keep the public host lifecycle intentionally small:
  - `enqueue`;
  - `deliver`;
  - `observe`;
  - `approve`;
  - `deny`;
  - `work`.
- Keep `AgentControlPlane` and the other runtime-owned collaborators internal. Callers receive the
  correctly wired behavior through `AgentRuntime` rather than assembling its dependencies manually.
- Replace all package tests and demos with `new AgentRuntime(...)`.
- Export `AgentRuntimeOptions` and update package exports and docs.

### Behavioral proof

- Every existing Zukhruf integration suite passes through the class API.
- All runnable demos build against the new constructor surface.
- Package declarations expose the intended customer classes and no runtime wiring or deleted
  floating factory functions.

### Exit criteria

- `AgentRuntime` is a small composition/lifecycle façade, not a second god class.
- No duplicate runtime construction path remains.
- No production file contains an orphaned helper whose behavior belongs to one of the extracted
  classes.

## Per-slice working discipline

For every implementation slice:

1. inspect the current staged and unstaged diff before editing;
2. change only the files needed for that slice;
3. use package module specifiers in tests;
4. run the focused integration coverage while iterating;
5. run the full experimental typecheck and test target before declaring the slice complete;
6. inspect `git diff` for accidental generated or unrelated churn;
7. leave changes unstaged unless staging or committing is explicitly requested.

Required final commands for every slice:

```sh
nx run @deepagents/experimental:typecheck
nx run @deepagents/experimental:test
```

## Completion definition

The refactor is complete when:

- `runtime.ts` no longer exists;
- `AgentRuntime` is the host-facing façade;
- `AgentControlPlane` owns multi-agent coordination and no execution logic;
- `AgentStatusProjector` is the only control-plane collaborator that reads transcripts for status
  and terminal-result projection;
- `AgentTurnExecutor` owns model-turn execution and no topology logic;
- durable agent identity is represented by `AgentThread` and `AgentPath`;
- all metadata access routes through `AgentDirectory`;
- all mailbox wake policy routes through `MailboxCoordinator`;
- all approval continuation behavior routes through `ApprovalController`;
- existing runtime semantics and integration suites remain green;
- docs and demos describe the new class-based API accurately.

## Post-completion review hardening

- Stored chat ownership is authoritative across enqueue, host delivery, execution, observation,
  explicit cancellation, and approval.
- Approval decisions use the assistant message as their sole durable record. A required
  Zukhruf-owned mutex serializes its read–validate–rewrite transition, sibling decisions wait for
  one another, and failed continuation handoffs remain repairable on completion or retry.
- Approval-paused children report model-facing `running` and project one final answer only after
  continuation. Failed or cancelled continuations project their terminal status instead of remaining
  visibly paused.
- DLQ cleanup releases strict FIFO even when orphan projection fails.
- Mailbox activity and orphan reconciliation are attempt-scoped, so a stale callback cannot clear a
  successor's activity or rewind its `lastTurnId`; latest-turn metadata writes use transactional `updateChat`,
  and terminal projection addresses the matching assistant message rather than the current head.
- Caller turn keys are conversation-scoped before becoming stream/message IDs, preventing
  cross-conversation replay and explicit cancellation.
- Mailbox wakes use the same conversation-scoped identities, so their owner can reconnect or cancel.
- Reserved metadata and parent topology fail closed, including non-canonical paths, self-parenting,
  and skipped ancestors. Root initialization uses transactional `updateChat` and preserves concurrent
  host writes.
- Cancellation during blocked sandbox setup is rechecked after sandbox acquisition, then ordered
  against model construction by an atomic queued-to-running claim. Cancellation observation starts
  before provider setup, and terminal status updates cannot overwrite an earlier terminal decision.
- Failed or cancelled approval continuations settle approved responses to `output-error`, preserve
  denied siblings as `output-denied`, and revive parked turns during normal settlement, terminal
  replay, and orphan reconciliation.
- Declaration names reject surrounding whitespace.
- Runtime wiring and injected tool implementations are hidden from the customer barrel;
  `AgentRuntime.deliver()` is the host-facing mailbox entry point.

## Completion record

- Slices 0 through 8 were completed in order, with the package typecheck and test target run after
  every implementation slice.
- Initial refactor verification on 2026-07-14: `nx run @deepagents/experimental:typecheck` and
  `nx run @deepagents/experimental:test` passed. The post-review regression run also passed the full
  experimental test target with 0 failures.
- The completed source has no `runtime.ts`; `AgentRuntime` is the sole host construction path.
