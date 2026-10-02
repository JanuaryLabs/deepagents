# Phase 2 — full-request triggers and targets

Status: complete. Dependency: [Phase 1](./phase-1-estimator.md).
Next phase: [usage baseline](./phase-3-usage-baseline.md).

## Outcome

Zukhruf evaluates the complete application-visible input instead of just message
history. This phase uses fresh estimates; measured baseline reuse arrives in
Phase 3. The [plan index](./README.md) owns the target-scope decision.

## Owned files

- `packages/experimental/src/zukhruf/runtime/compaction.ts` and its existing
  `compaction.integration.test.ts`.
- `packages/experimental/src/zukhruf/agent.ts` for the runtime contract.
- `packages/compaction/src/triggers.ts` for trigger-context documentation.
- `packages/context/src/lib/agent.ts` and its preparation integration test only
  if the public-hook probe demonstrates missing effective settings.
- `packages/experimental/src/zukhruf/runtime/agent-turn-executor.ts` only for
  necessary wiring; preserve its ownership boundaries.

## Work

1. Reproduce the gap through the public runtime: a small history with a large
   instruction/tool payload currently fails to cross a message-only token trigger.
2. Probe actual SDK callback ordering with `MockLanguageModelV4` from `ai/test`.
   Capture messages, instructions, tools/settings, and the model call. Verify
   mailbox input, reminders, sandbox tools and dynamic descriptions are visible
   before compaction decides. `onStepStart` observes the prepared request but
   cannot return a replacement prompt; it is not a replacement for `prepareStep`.
3. Extend the existing preparation path only as needed to provide the effective
   settings before the decision. `prepareStep` does not include a tools field;
   merely forwarding its arguments cannot solve missing tools/overrides.
   Prefer existing closure state and SDK types over a new public request DTO.
4. Estimate external instructions and the effective model-visible tool definitions.
   Use public `asSchema(...).jsonSchema`; include names, resolved descriptions,
   schemas, examples, and provider-tool identity/arguments as applicable. Match
   actual SDK tool-selection behavior, not an assumed interpretation of
   `activeTools`. Exclude execute functions, credentials, callbacks and unrelated
   runtime state. Do not import SDK-private `prepareTools`.
5. Count leading system messages in message history exactly once. Do not also
   count a duplicate representation of those messages in the envelope. Include
   structured-output instructions/schema when this path actually sends them.
6. Set trigger-context `tokens = message estimate + envelope estimate` after
   checkpoint restoration and context preparation. Leave ordered OR evaluation,
   strict `>` thresholds, `messagesExceed`, and cache-age semantics unchanged.
7. For a full-input runtime target, subtract the envelope estimate to obtain the
   message budget passed to standalone `compact()`. Reject an exhausted budget
   explicitly before a summary call. After reduction, check message + envelope
   estimates before checkpoint persistence. Keep the user's configured target
   in lifecycle events, not the derived message allowance.
8. Keep package `CompactResult.tokens` message-only. Runtime events report
   full-request estimates with an explicit scope marker. Update affected event
   consumers/typechecks in the same change; the final UI wording and historical
   rendering proof belong to Phase 4. Do not mislabel old persisted events.

## Acceptance checks

- [x] Large instructions alone, then tool schemas alone, can cross a token
      threshold despite short message history; the summary call is observable.
- [x] The same prompt hits at threshold + 1 and does not hit at equality.
- [x] First-step and later-step input uses final context/mailbox/reminder content.
- [x] Actual per-step settings and dynamic tool descriptions affect the estimate;
      unused internal tool implementation code does not.
- [x] Example: target 4,000 with a 1,500-token envelope leaves a 2,500-token
      message allowance; successful combined output estimates at most 4,000.
- [x] An envelope at/above target fails clearly, makes no summary call, and saves
      no new checkpoint. Failed final validation also adopts no replacement.
- [x] A message/cache trigger still requests reduction below the target.
- [x] Standalone `compact()` still knows only its supplied messages and counter.
- [x] Explicit custom message counters are used consistently; envelope accounting
      remains clearly an estimate and does not call a provider counting endpoint.
- [x] Existing cache-age observations and checkpoint replay retain their behavior.

## Verification

```sh
npx nx run @deepagents/compaction:typecheck
npx nx run @deepagents/compaction:test
npx nx run @deepagents/experimental:typecheck
npx nx run @deepagents/experimental:test --args="--test-timeout=60000 src/zukhruf/runtime/compaction.integration.test.ts"
```

If context preparation changed, also run its typecheck and focused integration
target with the same Nx test runner:

```sh
npx nx run @deepagents/context:typecheck
npx nx run @deepagents/context:test --args="--test-timeout=60000 src/lib/prepare-step-input.integration.test.ts"
```

Confirm Nx forwarded the requested test path and timeout. Adjust runner arguments
if its configuration changed; never silently run a different suite as proof.

## Evidence and handoff

- Reproduced with a public runtime scratch flow: short history reported 18 tokens
  despite 49,352 serialized prepared-prompt characters and nine tools. The new
  instructions/tools integration test failed before the change and passed after.
- Used existing SDK onStart/prepareStep callbacks and public asSchema. Context
  preparation returns messages only and is already composed before compaction;
  no new hook, DTO, middleware, or private SDK import was needed.
- Dynamic descriptions use current toolsContext/sandbox. Active tools follow the
  installed SDK's filterActiveTools semantics. Tool-caller wrapper framing is an
  estimate; original schemas/catalog descriptions are included, private binding
  logic is not copied. Existing context preparation tests cover mailbox/reminders.
- New events mark tokenScope=request; an exhausted envelope fails with
  request-overhead before summarization and leaves the old checkpoint unchanged.
- Experimental typecheck passed. Full runtime suite: 12/14 passed initially; the
  two tool-loop fixtures reserved only 4,000 message tokens before this contract
  changed. Their 2,500-character retained result plus roughly 1,709-token envelope
  exceeded that target. Setting the full-input fixture target to 6,000 restored
  both flows, including repeated compaction, HTTP replay and fresh-host restore.
- Strict token threshold equality remains covered by package integration tests.
  Custom-counter, below-target trigger, cache and checkpoint checks passed.
- Logs: /tmp/compaction-phase2-red.log, /tmp/compaction-phase2-suite.log,
  /tmp/compaction-phase2-typecheck.log, /tmp/compaction-phase3-red.log.
- The repository's global test setup requires Docker even for this PGlite suite.
  Docker is unavailable. Run the focused suite through the existing Nx test target
  with its command override, retaining dependency builds:

```sh
NX_DAEMON=false npx nx run @deepagents/experimental:test --command="node ../../tools/src/run-node-tests.ts ../../test-results/experimental-compaction.xml --experimental-test-module-mocks --test-timeout=60000 src/zukhruf/runtime/compaction.integration.test.ts"
```

- Next action: Phase 3, measured input usage. Reproduction already showed a
  provider's 10,800 input tokens being ignored: next request estimated 1,765.
