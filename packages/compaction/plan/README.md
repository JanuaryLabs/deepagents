# Compaction token accounting plan

Status: complete; all four phases verified. Updated: 2026-09-22.

This directory is the canonical handoff for replacing the compaction package's
GPT-specific token estimate and adopting full-request accounting in Zukhruf.
The conversation and temporary research clones are not required to continue.
The user authorized implementation on 2026-09-22 and explicitly excluded native provider compaction.

## Start here after context loss

1. Read this file, then the first incomplete phase below.
2. Inspect the current checkout and the phase's source files before editing.
   The compaction package and its integration already exist in a dirty checkout;
   some files are untracked. Preserve all existing work. Do not reset, stage, or
   commit it without a separate user instruction.
3. When implementation is requested, reproduce the phase's motivating behavior
   against the real public API before changing production code. Record the probe
   and actual output in that phase's evidence section.
4. Run the phase's focused checks. Update its status, evidence, unresolved issues,
   and next action before moving to the next phase or handing off.
5. Mark a phase complete only when its acceptance checks pass. Record failures
   precisely; never substitute a plan checkbox for execution evidence.

| Phase                                                                    | Outcome                                                                             | Dependency | Status   |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- | ---------- | -------- |
| [1. Portable estimator](./phase-1-estimator.md)                          | Remove GPT-specific counting from compaction while retaining its reduction contract | None       | Complete |
| [2. Full-request budgets](./phase-2-request-budgets.md)                  | Instructions, tools, and messages participate in runtime triggers and targets       | Phase 1    | Complete |
| [3. Measured usage and durability](./phase-3-usage-baseline.md)          | Reuse valid request usage across steps, turns, and host restarts                    | Phase 2    | Complete |
| [4. DevTool and end-to-end proof](./phase-4-devtool-and-verification.md) | Show honest estimates and verify the complete demo flow                             | Phase 3    | Complete |

**Next action:** use the running demo or review the implementation; no planned phase remains.

## Accepted product decisions

- Use estimates by default. Do not require a provider counting API, new
  credentials, or an additional network request for token accounting.
- Remove `gpt-tokenizer` as compaction's universal default.
- The runtime owns observed usage, request identity, and the history baseline.
- The compaction package owns stateless reduction, trigger helpers, and the
  estimate used to evaluate candidate message arrays. Keep the existing optional
  `countTokens` override; do not build a provider-counter registry.
- Runtime `tokensExceed(n)` evaluates the full prepared input, including messages,
  instructions, and tool definitions. This intentionally changes its current
  message-only meaning.
- A trigger decides whether to attempt reduction. Being below `targetTokens`
  never cancels an already matched message-count, cache-age, or custom trigger.
- `targetTokens` is enforced against the selected estimate. It is not a guarantee
  about a provider's exact tokenizer, context occupancy, or billing.

## Planning decisions

These are concrete implementation defaults, distinguished from the user-approved
direction above. Change this section if the user steers the contract.

- **Runtime target scope:** budget the full prepared input, including instructions
  and tools. The user authorized implementation of this plan after review. Standalone `compact()`
  continues to budget only its supplied messages. The runtime subtracts the
  non-message estimate before calling it. No parallel public target option.
- **Output:** future output/reasoning headroom is outside this input budget. Keep
  the caller's existing model output settings. Do not infer context limits or
  reserve an invented percentage from a model catalog.
- **Fallback:** use `ceil(serialized JSON length / 4)` for supported textual
  content, with empty messages equal to zero. It is a cheap heuristic, not a
  cross-language or cross-model accuracy promise. Keep one character-to-token
  rule for message and request-envelope estimates; do not expose a configurable
  multiplier without a demonstrated need.
- **Explicit counter:** the existing `countTokens(messages)` override controls
  message estimates in both standalone and runtime use. Runtime adds the envelope
  estimate. Do not mix a custom message counter with an unrelated measured
  baseline; the explicit override takes precedence over baseline reuse.
- **Media and opaque content:** retain current preservation rules and the need
  for an appropriate counter where the default cannot estimate content. Never
  treat a URL, base64 length, or encrypted compaction item as its model token cost.
- **Baseline safety:** reuse measured usage only for the same request settings
  and a verified unchanged prefix. Reset on changed instructions/tools/settings,
  model, branch, edited prefix, or applied summary. This is deliberately stricter
  than Eve's positive envelope-growth adjustment and needs fewer assumptions.
- **Existing persisted events:** new runtime events identify request-token scope;
  events without that marker remain historical message counts. Preserve their
  meaning and keep old chats readable without rewriting stored transcripts.

## Ownership and accounting

| Location                                                  | Responsibility                                                                                                                 |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `packages/compaction`                                     | Message estimate, optional counter, safe replacement, summary generation, candidate budget validation, pure trigger predicates |
| `packages/experimental/src/zukhruf/runtime/compaction.ts` | Full-request estimate, usage observation, baseline validity/persistence, checkpoint projection, lifecycle events               |
| Existing context/SDK hook composition                     | Deliver the effective prepared request to the runtime; only change when a focused probe proves data is missing                 |
| DevTool                                                   | Display estimated request counts and their scope; do not recalculate usage or own another accounting state                     |

Use these definitions consistently:

```text
M(messages) = chosen message estimate
E(request)  = estimated instructions + normalized model-visible tool definitions
              + other model-visible request material available at the SDK boundary

without a valid baseline:
  trigger tokens = M(current messages) + E(current request)

with a valid baseline and unchanged envelope/settings:
  trigger tokens = previous request input tokens + M(appended messages)

runtime message target = runtime targetTokens - E(current request)
after compaction        = M(candidate messages) + E(current request)
```

Do not add the unchanged envelope twice: provider input usage already includes it.
Do not add output usage and estimate the same appended assistant message again.
Cached input still occupies context. Aggregate conversation/turn usage belongs
to cost/accounting and must never become a prompt-size baseline.

The fallback covers application-visible input approximately; unknown provider
framing, server tools, and middleware changes cannot be counted exactly. Measured
usage can improve the baseline only while its association with the request is
valid. A new summary invalidates that measurement and is estimated afresh.

If the envelope consumes the target, stop with an explicit budget failure before
calling the summarizer. Do not silently raise the target, remove tools, or drop
instructions. After a summary is produced, validate the combined estimate before
saving/adopting its checkpoint.

## Current implementation map

Updated from the implementation on 2026-09-22.

- [messages.ts](../src/messages.ts): `estimateTokens` uses serialized characters / 4,
  rejects unsupported opaque/media input; `replacementRange` protects history.
- [compact.ts](../src/compact.ts): message-only `TokenCounter`, target validation,
  one summary call, safe candidate composition, explicit `cannot-fit` results.
- [triggers.ts](../src/triggers.ts): `tokens` estimates full prepared input, including instructions and
  tools; ordered OR evaluation lives in the runtime.
- [runtime compaction](../../experimental/src/zukhruf/runtime/compaction.ts):
  already has `onStart`, `prepareStep`, `onStepStart`, `onStepEnd`, prefix hashing,
  checkpoint metadata, cache observations, and persistent `data-compaction`.
  It persists inputUsage with a verified prefix and request scope.
- [turn executor](../../experimental/src/zukhruf/runtime/agent-turn-executor.ts):
  composes declaration/plugin/collaboration tools; forwards native SDK callbacks.
- [context agent](../../context/src/lib/agent.ts): `#withPrepareStep` applies
  context/mailbox/reminder changes before the compaction preparation callback.
- [DevTool entry](../../devtool/host/ui/src/routes/chat-compaction.tsx): labels
  new events as estimated input tokens and historical events as message estimates.
- [demo declaration](../../../demo/zukhruf-simple/agent.ts): token threshold
  24,000; message threshold 40; cache-age trigger; target 16,000; keep four messages.
  A real sandbox/MCP probe observed 11,411 estimated input tokens for a greeting.

## Research evidence and limits

- Installed `ai@7.0.85` and its `LanguageModelV4` contract expose no common
  preflight counter. Public `asSchema(...).jsonSchema` normalizes tool schemas.
  `prepareTools` exists internally but is not a public `ai` export: do not deep
  import it or copy its entire implementation.
  A 2026-09-22 local ESM probe confirmed `ai.asSchema` and `ai/test`'s
  `MockLanguageModelV4` are public, normalized a real Zod object to JSON Schema,
  and confirmed no `countTokens` export on `ai`.
- SDK `onStart` exposes tools/settings; `prepareStep` exposes effective messages,
  instructions and model; `onStepStart` runs later and also exposes effective
  tools/settings; `onStepEnd` supplies native step usage. The Phase 2 source/probe review confirmed context preparation supplies messages
  before compaction, with tools/settings available through existing callbacks.
- Eve 0.63.0 at `dea2ced59e8c7ed5a41b9a1c432f5fcd080999d9` uses
  [JSON length / 4](https://github.com/vercel/eve/blob/dea2ced59e8c7ed5a41b9a1c432f5fcd080999d9/packages/eve/src/harness/token-estimate.ts),
  [usage plus appended-message estimates](https://github.com/vercel/eve/blob/dea2ced59e8c7ed5a41b9a1c432f5fcd080999d9/packages/eve/src/harness/compaction.ts),
  and [an instruction/tool envelope](https://github.com/vercel/eve/blob/dea2ced59e8c7ed5a41b9a1c432f5fcd080999d9/packages/eve/src/harness/request-envelope.ts).
  Its summary replacement clears the baseline. This plan borrows that accounting
  approach, not its tool-result truncation or its entire harness.
- A fixture-backed probe through installed `generateText` proved OpenAI and
  Anthropic native compaction options and replay. A separate `streamText` probe
  observed OpenAI `custom` / `openai.compaction` and Anthropic `text-start` with
  compaction metadata. These were intercepted responses, not paid provider calls.
- The Anthropic fixture reported 60,385 compaction input tokens plus 682 answer
  input tokens, normalized by AI SDK to 61,067. That normalized sum is not the
  remaining context size. Source: installed
  `node_modules/@ai-sdk/anthropic/src/convert-anthropic-usage.ts`; upstream
  [fixture](https://github.com/vercel/ai/blob/4e8c387622ee1bb0d55841664416d38754d5c9a3/packages/anthropic/src/__fixtures__/anthropic-compaction.1.json).
  Reject ambiguous/aggregate native usage as a baseline; use the fallback. Do not
  build provider-specific iteration adapters in these phases.
- Model catalogs and TokenLens provide capacities/pricing, not prompt tokenizers.
  Provider-native counting APIs exist but are outside this default estimate path.

## Boundaries

Do not add automatic native provider compaction, provider counting clients, model
catalog discovery, pricing triggers, a new middleware framework, or another store.
Do not solve summary-quality evaluation, transcript splitting, or recent-history
selection redesign here; see [existing problems](../problems.md).

The older `packages/context/src/lib/estimate.ts` GPT-default issue is separately
captured as backlog **#1958**. Removing the compaction dependency does not authorize
removing `gpt-tokenizer` from remaining legitimate consumers or fixing that API.
The existing demo shutdown issue is separately tracked as **#1952**.

## Handoff record

- All four phases complete. Verification: 22 compaction + 18 runtime + 27 context
  - 4 UI tests = 71 passed; affected typechecks and DevTool build passed.
- Added one required context initialization correction after a live reproduction:
  load the active branch name with its branch record, so restart keeps usage scope.
- Demo running at http://127.0.0.1:4317/devtool/history; browser history page verified
  and left open. The real sandbox/MCP envelope was measured with a mocked model.
- No native provider compaction, no paid model calls for these checks, no staging
  or commit. Existing dirty/untracked work preserved.
- [Phase 4](./phase-4-devtool-and-verification.md) records exact commands, probe
  results, test-runner Docker limitation, temporary logs, and the removal audit.
- No remaining implementation action; estimates retain the documented model and
  provider-framing limitations.
