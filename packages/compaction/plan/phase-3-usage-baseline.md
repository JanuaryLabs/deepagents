# Phase 3 — measured usage with a durable baseline

Status: complete. Dependency: [Phase 2](./phase-2-request-budgets.md).
Next phase: [DevTool and verification](./phase-4-devtool-and-verification.md).

## Outcome

Provider-reported input usage improves the next estimate when it describes a
known unchanged prompt prefix. The association survives host restart and is
discarded when invalid. See the [accounting definitions](./README.md).

## Owned files

- `packages/experimental/src/zukhruf/runtime/compaction.ts`.
- `packages/experimental/src/zukhruf/runtime/compaction.integration.test.ts`.
- Existing runtime/context call sites only if a reproduced lifecycle gap requires
  a change. No new persistence service, database, or usage middleware.

## Work

1. Reproduce the missed trigger: short serialized text receives a high
   provider-reported input count, then another message is appended. Show why
   recounting only the characters loses the provider measurement.
2. Capture the exact projected prompt identity in `onStepStart` and match it to
   the corresponding successful `onStepEnd`. Use native call/step identifiers if
   overlap or retries require them; never assign usage to the original transcript
   merely because it has the same number of messages.
3. Store the minimum baseline in the existing conversation metadata beside
   compaction/cache state: input count, prompt prefix length/hash, branch and
   model/settings identity, and a format discriminator if needed for validation.
   Reuse existing hash/scope logic only where its inputs cover this contract.
   Do not store raw prompts, duplicate transcripts, auth headers, or tool schemas.
4. Reuse a finite non-negative input count only if request settings are unchanged
   and the current projected messages retain its exact prefix. Add the estimate
   of new messages; do not recount the envelope, subtract cached input, or add
   output tokens already represented by the appended assistant message.
5. Use per-step input usage, never `totalUsage`, conversation usage, or summary
   model usage. Inspect native raw/metadata/content signals for multiple provider
   iterations or server-side compaction. When usage cannot be associated with the
   active prompt safely, clear it and use Phase 2's fallback. Do not infer context
   occupancy from an aggregate billing total.
6. Reset on prefix edits/rewinds, branch changes, model/routing changes that are
   observable, instruction/tool/settings changes, or history replacement. For
   unobservable provider-side routing/framing, keep the result explicitly an
   estimate; do not promise a guarantee that the transport cannot supply.
7. Persist the final successful step even when no compaction fires and telemetry
   is disabled. Missing/invalid usage on a completed step clears the previous
   baseline. Old chats with no baseline use the fallback. Malformed optional
   baseline data is discarded without damaging valid checkpoints or cache state.
8. Save a successful summary checkpoint and invalidate its old baseline in the
   same metadata update. A restored checkpoint may reuse a later baseline only
   if the resulting projected prefix/settings match. Failure or cancellation
   never associates new usage with an unsent prompt or adopts an uncommitted
   summary. Keep existing persistence-error behavior explicit.
9. An explicit custom `countTokens` override takes precedence: use its message
   count plus the envelope rather than combining two different counting methods.

## Acceptance checks

- [x] Provider input 10,800 plus appended estimate 1,500 yields 12,300 with an
      unchanged envelope; a 12,000 threshold fires.
- [x] Cached input remains part of the baseline; output/messages are not counted
      twice; summarizer usage remains in cost accounting only.
- [x] A real multi-step tool flow uses the prompt that was actually sent, not UI
      transcript length or total step usage. Final-step usage seeds the next turn.
- [x] Closing/recreating the public runtime over the same store preserves a valid
      baseline and its decision, including when telemetry is off.
- [x] Changed instructions, schemas, model, settings, branch, edited prefix, and
      applied summaries each invalidate stale evidence and use a fresh estimate.
- [x] An unchanged projected prefix after checkpoint restore can reuse a matching
      post-compaction baseline. An old pre-compaction baseline cannot.
- [x] Reproduce the Anthropic fixture's 60,385 + 682 = 61,067 normalized input;
      it is not reused as post-compaction occupancy. Include OpenAI opaque compaction
      detection as applicable to the installed adapter. No live paid call is required.
- [x] Absent usage, non-finite/negative values, aggregated native iterations, and
      malformed saved baseline never produce a false measured count.
- [x] High measured usage cannot be dismissed because fresh characters fit the
      target: once a trigger matches, reduction is still attempted.
- [x] Existing checkpoint persistence, cache-age tracking, failed-summary,
      cancellation, and concurrent metadata-field preservation tests remain green.

Drive runtime behavior through `AgentRuntime.deliver`/`work` and public exports,
using existing integration fixtures. Add no test-only exports for private hooks.

## Verification

```sh
npx nx run @deepagents/experimental:typecheck
npx nx run @deepagents/experimental:test --args="--test-timeout=60000 src/zukhruf/runtime/compaction.integration.test.ts"
```

Run any additional focused suite whose actual persistence/hook implementation
changed. Inspect captured request and event data, not just final summary text.

## Evidence and handoff

- Public runtime reproduction: provider reported 10,800 input tokens; trigger
  estimates remained 1,727 then 1,765. The new durable regression initially failed
  because inputUsage did not exist (/tmp/compaction-phase3-red.log).
- Runtime now saves inputUsage = {scope, prefixLength, prefixHash, inputTokens}
  alongside promptCache. The scope covers branch/model/instructions and normalized
  tools/settings. No raw prompt or duplicated schema is persisted. Existing SDK
  step callbacks are sequential and associate each measurement with its sent prompt.
- Restart/checkpoint test proves 10,800 (including 6,000 cached tokens) plus only
  appended-message estimates crosses 12,000. Output usage of 9,000 is not added.
  Summary usage never becomes the baseline. Explicit custom counters take precedence.
- Tool-loop test proves the first step's 10,800 plus appended tool results, then
  the final step's 2,000 input seeds the next turn instead of summed turn usage.
- Dynamic description/schema/instruction/model changes, rewind and malformed
  metadata all discard stale measurements and establish a new usable baseline.
- That flow exposed a required context fix: reopening main-v2 loaded its messages
  but ContextEngine.branch still returned main. Public scratch reproduction printed
  { originalBranch: main-v2, reopenedBranch: main, persistedBranch: main-v2 }.
  Initializing #branchName from the loaded branch fixes the source of the mismatch.
  Existing SQLite branching coverage now reopens that engine and checks its name.
- Missing, negative, NaN/infinite usage, Anthropic iterations and compaction text,
  and OpenAI opaque compaction content are rejected as baseline evidence.
- A public createAnthropic + generateText fixture (intercepted fetch, no network)
  reproduced 60,385 + 682 = 61,067 input tokens. onStepEnd.usage.raw.iterations
  preserves the native breakdown; runtime rejects it rather than using billing
  totals as prompt occupancy. Native compaction is never enabled by our code.
- First whole runtime pass: 16/17 passed; the branch-name bug was the sole failure.
  After its fix, both targeted baseline/step tests passed. Context branching and
  preparation suites passed 27/27. Experimental and demo dependency typechecks passed.
- Logs: /tmp/compaction-phase3-suite.log, /tmp/compaction-phase3-focused.log,
  /tmp/compaction-context-test.log, /tmp/compaction-final-typecheck.log.
  Phase 4 records the final whole-suite run after this context fix.
- Limits: request formatting and middleware/provider routing changes invisible to
  public callbacks remain estimates. No provider-specific occupancy adapter,
  counting endpoint, registry, native compaction option, or new persistence layer.
- Next action: Phase 4 UI/demo proof and final documentation.
