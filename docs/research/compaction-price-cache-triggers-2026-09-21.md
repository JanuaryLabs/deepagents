# Compaction price and prompt-cache triggers

Research date: 2026-09-21. Provider documentation, installed SDK source, current
runtime call sites, and two local SDK probes were checked. This note preceded
the first cache-trigger implementation: `cacheLikelyCold()` is now shipped,
while the price trigger remains a design suggestion.

## Recommendation

Keep the predicates in `@deepagents/compaction`; supply their evidence from the
runtime. Start with `inputCostExceeds(usd)` for estimated next-request input cost
and a cache trigger whose name acknowledges uncertainty, such as
`cacheLikelyCold()`. A universal `cacheExpired()` would promise knowledge most
providers do not expose.

For the price trigger, choose the meaning explicitly. A dollar threshold on the
next input is different from crossing a model's long-context pricing tier, and
both differ from cumulative conversation spend. The first is the recommended
starting point. Historical spend is already incurred, so it cannot establish
whether compaction will save money on the next request.

A cache miss is observed **after** a request. That request may already have
rebuilt the cache. Compacting immediately in response can discard the value of
the write just paid for. The useful pre-request signal is that an established
prefix is no longer reusable, or is outside its documented retention window.

## Provider differences

| Provider  | Before the request                                                                                                                                                                                                                                 | Evidence and pricing                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenAI    | No implicit-cache status lookup. Exact prefix matching and routing affect reuse. GPT-5.6+ documents a minimum 30-minute window since write/reuse; older models have different retention rules. Elapsed minimum retention is not proof of eviction. | Input usage distinguishes cached and cache-write tokens. GPT-5.6+ reads cost 0.1x normal input, writes 1.25x; older models differ. Compaction changes the prefix and can reduce reuse on the next request. [Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching).                                                                                                                                                                                                    |
| Anthropic | Cache breakpoints cover tools, system, and messages. Default retention is 5 minutes, optionally 1 hour; refresh timing starts with the request. These are minimum retention windows. No documented liveness lookup.                                | Separate uncached, cache-read, and cache-creation counts; creation also has 5-minute/1-hour buckets. Writes cost 1.25x/2x, reads usually 0.1x with model exceptions. Minimum eligible prefix length varies by model. [Caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching), [pricing](https://platform.claude.com/docs/en/about-claude/pricing).                                                                                                                    |
| Gemini    | Implicit caching offers no guaranteed hit or status lookup. Explicit `cachedContents` resources expose `expireTime`; their content/model are immutable, while expiry can be updated.                                                               | GenerateContent reports `usageMetadata.cachedContentTokenCount`; the Interactions API uses `usage.total_cached_tokens` and currently supports implicit caching only. Explicit caching adds storage charges. [Guide](https://ai.google.dev/gemini-api/docs/caching), [explicit API](https://ai.google.dev/api/caching), [pricing](https://ai.google.dev/gemini-api/docs/pricing).                                                                                                              |
| xAI       | Exact prefix reuse is best effort; routing and eviction can cause misses. Conversation/cache keys improve affinity. No documented TTL or cache-status lookup in the reviewed guide.                                                                | Cached token counts and model-specific cached-input pricing; `cost_in_usd_ticks` reports actual discounted request cost. Model, endpoint, tier, and context length can affect prices. [Caching](https://docs.x.ai/developers/advanced-api-usage/prompt-caching/how-it-works), [affinity](https://docs.x.ai/developers/advanced-api-usage/prompt-caching/maximizing-cache-hits), [pricing](https://docs.x.ai/developers/pricing), [cost tracking](https://docs.x.ai/developers/cost-tracking). |

Do not hardcode one TTL for all providers. For implicit caches, use states such
as unknown, likely reusable, and likely cold, with the reason recorded. For an
explicit Google resource, known expiry is stronger evidence; deletion or other
resource failures can still make it unavailable sooner.

Zero cached tokens alone does not distinguish a first request, an ineligible
short prefix, changed content, eviction, or routing. Partial reuse is normal:
changing a suffix does not necessarily invalidate the earlier stable prefix.

## Price calculation

Use disjoint token buckets and the active model, endpoint, and service tier:

```text
input USD = (uncached tokens * normal input USD/MTok
           + cache-read tokens * cache-read USD/MTok
           + cache-write tokens * cache-write USD/MTok) / 1,000,000
```

Split cache writes further where TTLs have different rates. Add explicit-cache
storage separately. A cold request is not necessarily all normal-rate input:
eligible tokens may incur a cache-write premium. Missing counters/rates are
unknown, not zero. Long-context price tiers need their own provider rules.

Before sending, these buckets are estimates. Keep the assumption visible: a
cold estimate, an expected-reuse estimate, or provider-confirmed explicit-cache
reuse. Do not silently apply the last request's hit percentage to a changed
prompt. A dollar threshold is a spending policy, not proof compaction pays off.

To claim savings, compare over an explicit reuse horizon:

```text
keep    = sum(expected input costs without compaction)
compact = summarizer input + summarizer output
        + sum(expected input costs after compaction)
        + incremental explicit-cache storage/creation costs
```

Future summary length/output and implicit cache hits are uncertain. If using a
hit probability, label it an assumption. The summarizer in this repository uses
a separate serialized prompt; it cannot be assumed to reuse the conversation's
cache. Subscription transports also require care: public API prices are only an
API-equivalent estimate, not the user's actual subscription charge.

## Verified repository wiring

- [Trigger context](../../packages/compaction/src/triggers.ts) contains
  messages, estimated tokens, and optional cache age/retention evidence. In
  standalone package use, `tokens` means the supplied messages. In Zukhruf, the
  runtime supplies estimated prepared input tokens, including messages,
  instructions, tools, and structured-output schema. The context still has no
  model, prices, or provider usage.
- [Runtime compaction](../../packages/experimental/src/zukhruf/runtime/compaction.ts)
  evaluates triggers sequentially with OR semantics before each model step.
  A matching trigger requests compaction even when the current estimate is below
  `targetTokens`; the target only validates the resulting bounded context. The
  saved checkpoint validates application history, not provider cache state.
- [The turn executor](../../packages/experimental/src/zukhruf/runtime/agent-turn-executor.ts)
  installs compaction through `prepareStep`.
  [ContextAgent](../../packages/context/src/lib/agent.ts) prepares context first,
  then invokes that override. Zukhruf also wires native `onStart`, `onStepStart`,
  and `onStepEnd` callbacks so request settings, tool definitions, per-step
  input usage, and prompt-cache evidence can update conversation metadata.
- Installed AI SDK v7 exposes per-step usage, provider metadata, and response
  model identity. A previous step is available at the next `prepareStep`, but
  the final step needs an end callback too. Its native callback is `onStepEnd`.
  `result.usage` already sums all steps; `totalUsage` is a deprecated alias.
- [Plugin telemetry](../../packages/experimental/src/zukhruf/runtime/plugin/plugin-manager.ts)
  can observe step/model-call events, but the SDK disables those integrations
  when `telemetry.isEnabled` is false. Required policy state must not depend
  solely on optional telemetry. Use native lifecycle callbacks or existing
  model middleware for the required observations.
- [Chat persistence](../../packages/context/src/lib/chat.ts) stores step usage;
  [the engine](../../packages/context/src/lib/engine.ts) accumulates aggregate
  usage. Summary-model usage enters that aggregate too. Price individual calls
  with their model/tier identity rather than pricing the combined total as one
  model.
- [ModelsRegistry](../../packages/context/src/lib/estimate.ts) already loads
  input/output/cache-read/cache-write rates from models.dev. It loads once and
  has no refresh API. Its `estimate()` computes plain text input cost only.
  The installed `tokenlens@1.3.1` can calculate cache costs with explicit usage
  mapping, but does not consume SDK v7's nested `inputTokenDetails` directly.
  Neither is a complete resolver for TTL tiers, storage, or subscription billing.
- Provider transforms matter after `prepareStep`:
  [Claude](../../packages/experimental/src/providers/claude/index.ts) adds system
  content and cache-control defaults;
  [Codex](../../packages/experimental/src/providers/codex/index.ts) uses a
  subscription transport and changes provider settings. Cache identity must
  reflect the effective request, including stable instructions/tools and
  relevant provider settings, not just the message-array hash.

## Smallest useful implementation boundary

1. **Compaction package:** predicate helpers and the small, optional evidence
   fields they consume. No provider HTTP calls or store access inside triggers.
2. **Runtime:** collect per-call usage/model identity, request start time, and
   effective prefix evidence; persist the latest relevant observation with the
   conversation/branch/cache scope. Supply the next-step snapshot to predicates.
3. **Provider/application configuration:** resolve applicable prices and cache
   policy. Reuse the existing catalog when sufficient; allow supplied rates.
   An SDK provider ID is not automatically the catalog provider ID.

External access is limited to refreshing a price catalog if desired, the
existing conversation store, and normal model responses. A clock and request
observations support implicit-cache inference. Explicit Google caching may use
its resource API. An extra model call to ask whether caching is live is neither
necessary nor reliable. Predicates can run entirely offline with supplied data.

Keep OR semantics in mind: a standalone cache predicate can request compaction
even below the dollar threshold. If the intended policy is “compact when cold
and expensive,” express that conjunction explicitly rather than adding two OR
entries. Retain the target-size guard. After compaction, establish a new cache
baseline from a subsequent real request; do not interpret the intentional
prefix change as another invalidation and create a repeated-compaction loop.

## Local probes and implementation checks

Two throwaway probes exercised installed public SDK APIs, without network or
paid model calls:

1. `createOpenAI` plus `generateText`, with a stubbed HTTP response, accepted
   `promptCacheKey`/`promptCacheOptions` and emitted the expected wire fields.
   Input 1,000, cache reads 800, and cache writes 100 normalized to 100 uncached
   tokens. Using synthetic rates of 3 / 0.3 / 3.75 USD per million for normal /
   read / write and 15 for output, with 20 output tokens, direct SDK usage fed
   into tokenlens returned $0.0033; explicit disjoint-bucket mapping returned
   $0.001215. These are fixture rates, not a current model price quote.
2. `generateText` with a public `MockLanguageModelV4` and a tool produced two
   steps. The second `prepareStep` received the first step's detailed usage;
   the first had no prior usage. Aggregate usage was 2,000 input tokens, while
   the last step alone was 1,000.

Implementation tests should drive the public runtime: price boundary and
missing rates; warm/cold/unknown evidence; first request and short prefixes;
append-only versus edited prefixes; final-step persistence; model/tier changes;
and no repeated compaction following an intentional prefix replacement. These
are proposed checks for implementation, not tests claimed to exist today.
