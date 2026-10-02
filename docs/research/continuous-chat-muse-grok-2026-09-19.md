# Continuous chat in Meta Muse and xAI Grok Bot

**Research date:** 2026-09-19

**Scope:** public first-party material. “Documented” below means a product claim or published architecture fact; it is not a reconstruction of private model runtime.

## Findings

Muse and Grok Bot both make a durable agent the primary object rather than a durable chat transcript. Muse has one long main conversation with persisted memory and side chats when a project needs separate context.[1] xAI calls chats disposable and makes the named Bot—with identity, memory, runtime, tools, and computer—the durable unit.[4] This supports a product design of a stable agent owner with separate conversational views; it does not imply one unbounded model prompt.

| Concern              | Meta Muse: documented                                                                                                 | xAI Grok Bot: documented                                                                                                            |
| -------------------- | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Memory               | Persists across conversations; users can read and directly edit Memory files, and ask Muse to forget a fact.[1][2][3] | Retains stable preferences, role context, important facts, and summaries of prior work.[5]                                          |
| Durable data         | A dedicated VM is the system of record. Durable application state is in Postgres outside the agent runtime cell.[2]   | A Bot keeps memory, files, browser sessions, and preferences across sessions on a persistent cloud computer.[5]                     |
| Background work      | Work continues on schedules and relevant events; Muse decides whether a result is worth surfacing.[1]                 | Bots run routines and continue work while the user's device is closed.[4][5]                                                        |
| Isolation / transfer | Muse can run concurrent subagents, but its memory or handoff protocol is not published.[2]                            | Learned context and conversations are per Bot. Shared files, browser sessions, direct messages, and group chats move context.[5][6] |

## Meta Muse: what the technical disclosure does and does not say

Meta's security post is the concrete architecture disclosure. A dedicated VM is the system of record. The harness, workspace filesystem, and executable tools run in an isolated `systemd-nspawn` cell; durable application state is in a separate Postgres database, and credentials are a separate service.[2] Meta says users can inspect, edit, and download files, generated outputs, and Muse's memory; VM data is continuously backed up.[3]

This demonstrates durable state outside the active model context window. It does **not** say how that state enters a prompt. The launch material gives no public memory schema or lifecycle beyond user-directed forgetting, no periodic consolidation, summary/chunk format, retrieval or ranking method, compaction, context-window size, prompt layout, provider cache/KV-cache persistence, prefill, cache-hit rate, or token economics.[1][2][3] “Long context” and “lots of context” are product claims, not implementation evidence.

## xAI Grok Bot: persistent-role contract, not runtime mechanics

Grok Bot's public contract is specific: stable working preferences, important facts, and work summaries keep a role over time “without replaying every prior message.”[5] It explicitly treats mutable facts as belonging in the source system and advises reopening current data for consequential work.[5][6] Its design post assigns memory and routines to the Bot; prompts can be one-off, saved as Skills, or automatically triggered as Routines.[4]

The searched official Bot sources do **not** disclose the memory data model, retention period, extraction/writing trigger, summary generation, retrieval/ranking, context budget/compaction, cache/prefill strategy, cache hits, or inference price. Bot access is plan-based with weekly usage resets, which is product packaging rather than an explanation of internal inference economics.[5]

## Related xAI API mechanisms, separately

xAI's developer API exposes mechanics that a provider adapter can use, but there is no evidence that Grok Bot internally uses them:

- **Prefix caching:** the API automatically reuses an exactly matching initial message prefix. `x-grok-conv-id` and `prompt_cache_key` route a conversation to the same server because cache entries are per-server. Cache hits lower time-to-first-token and use the cached-input price, but cache eviction and routing make hits non-guaranteed.[7][8]
- **Compaction:** `POST /v1/responses/compact` returns an opaque encrypted item that stands in for the system prompt, attachments, prior reasoning, and compacted conversation. The next request must send it unchanged as its head; compaction itself consumes tokens and only works before the conversation exceeds context.[9]

These solve separate problems: unchanged prefixes can be cached; compaction reduces later model-visible history. A compaction becomes a new prefix, so it will ordinarily start a new cache chain. That last statement is an inference from xAI's documented exact-prefix and continuation rules, not a published claim about Grok Bot.[7][9]

## Grok Build is a different product

Grok Build has a materially stronger public implementation disclosure, but it must not be attributed to Grok Bot. After each completed turn, background capture writes durable conventions, decisions, and project facts as one-topic Markdown notes at project and global scope; relevant notes are read before related work. It deliberately excludes task state, tentative conclusions, secrets, and facts already in the repo or docs.[10] Its changelog says a resumed-session memory-injection fix preserves a byte-stable prompt prefix and the KV cache.[11]

This is evidence for Grok Build's file-backed capture/retrieval and cache-preservation constraint only. It does not establish Bot's internals, provider prefill behavior, cache duration, price, or savings.

## Why caching helps, and why it does not make history free

The product transcript, the model's current input, and the provider's KV cache have different lifetimes. Store the transcript durably; choose a bounded input from it; treat the provider cache as an optimization. A KV cache reuses computation for an identical prefix. It does not provide unlimited context, permanent memory, or free output generation.[12][13]

An append-only conversation is a good cache workload while the entry survives. Changing an early summary, injecting different retrieval results ahead of the history, or sliding out the oldest message changes the prefix from that position onward. A later unchanged suffix cannot independently reuse its old prefix cache. This is why continuously rewriting a running summary can be more expensive than occasionally replacing a larger block.[7][12]

Provider distinctions checked on September 19, 2026:

- **OpenAI GPT-5.6 and later:** the documented minimum cache lifetime is 30 minutes after a write/reuse; cache writes cost 1.25 times ordinary input and reads 0.1 times. Earlier models have different retention and write pricing. The installed OpenAI adapter already maps `promptCacheOptions` and `contextManagement` to the wire. These are available capabilities, not proof Zukhruf uses compaction.[12]
- **Anthropic:** default cache lifetime is five minutes, with a paid one-hour option. A hit refreshes lifetime. For Sonnet 4.6, five-minute writes cost $3.75 per million tokens and reads $0.30, versus ordinary input at $3. These are public API rates, not subscription accounting or Muse/Grok Bot internal costs.[14]
- **xAI:** public API caching has no retention guarantee; routing and eviction can cause misses.[7][15]

Provider-managed conversation state also does not erase input billing: OpenAI explicitly says previous input in a `previous_response_id` chain remains billable.[16] Cached pricing can apply, but a smaller request body is not itself a smaller model context.

Even with perfect hits, an ever-growing history keeps increasing the billed cached-input tokens. If each turn adds a fixed amount, total history-token billing across N turns grows quadratically at the cached rate. This is billing arithmetic, not a claim that cached prefill computation is quadratic. Bounding the working context changes that growth to approximately linear, plus compaction and retrieval costs.

## A concrete cost comparison

Illustrative arithmetic at the Sonnet 4.6 rates above. These are the costs of the historical prefix alone on one request; exclude new suffix tokens, output/reasoning, tools, retrieval, and summary generation. This is not a live paid-model benchmark.

| Historical prefix sent | Warm cache read | Cold request writing a five-minute cache |
| ---------------------- | --------------: | ---------------------------------------: |
| 100,000 tokens         |          $0.030 |                                   $0.375 |
| 20,000 tokens          |          $0.006 |                                   $0.075 |

A smaller context cuts both repeated reads and the cold-start cost. For a warm 100k context, compacting to 20k saves $0.024 per subsequent warm request. You first pay summary generation plus the new cache write. With an **assumed** $0.10 summarization cost, seven calls retaining 100k cost $0.210; seven calls after compaction cost $0.211. At eight calls, the totals are $0.240 versus $0.217. This simplified calculation holds prefix size constant to isolate the tradeoff.

In general, compact for cost when expected future savings exceed summary generation plus incremental rebuilding cost, or earlier when correctness/context limits require it. Do not compact every turn just to minimize token count. Do not keep an enormous context solely to preserve a high hit percentage. Measure dollars and latency. A user returning tomorrow should trigger an affordable bounded cold request; continuity must not require keeping their GPU cache alive overnight.

## Verified Zukhruf behavior

The inspected Zukhruf source path is:

1. [`AgentTurnExecutor`](../../packages/experimental/src/zukhruf/runtime/agent-turn-executor.ts) constructs a new `ContextEngine` for the existing conversation, adds instructions/skills, and invokes `chat(agent(...))`.
2. [`ContextEngine.getMessages()`](../../packages/context/src/lib/engine.ts) reads the entire active branch through `getMessageChain`, merges pending updates, and filters empty assistant placeholders. `resolve()` returns that history alongside rendered system fragments. There is no token-budget selection or semantic compaction in this path.
3. [`Agent.#createRawStream()`](../../packages/context/src/lib/agent.ts) converts those resolved messages and sends them to `streamText`. `ChainSummaryBuilder` computes reminder counters and reply groupings; it is not an LLM history summary.
4. [`chat()`](../../packages/context/src/lib/chat.ts) also uses `getMessages()`
   for UI stream reconciliation. Zukhruf's model-context compaction must remain
   a request projection and must not silently truncate the canonical history used
   there.

An in-process probe of the installed public `@deepagents/context` package, resolving to `packages/context/dist/index.js`, stored 100 synthetic user/assistant pairs. A fresh engine with the same chat returned all 200 messages; adding the next question produced 201 messages. `resolve()` preserved the previous system prompt and all 200 messages exactly. This confirms the inspected unbounded-history behavior and append stability for this text-only case; it does **not** measure provider cache hits or prove all tool/multimodal requests preserve their wire prefix.

The same probe retrieved the first answer using existing `ContextStore.searchMessages`. [`SqliteContextStore.searchMessages`](../../packages/context/src/lib/store/sqlite.store.ts) already uses SQLite FTS5. Zukhruf does not currently wire this operation into an agent history-recall tool. Initial recall does not require introducing a vector database; lexical search quality should be evaluated before adding semantic retrieval. Existing search is scoped by chat ID, so branch visibility and user authorization must be enforced when exposing it to a model.

The simple demo currently declares `openai('gpt-5.6-luna')` for the main model
and `openai('gpt-5.6-terra')` for summarization. It now enables automatic
compaction when estimated input tokens exceed 24,000, model messages exceed 40,
or prompt-cache evidence reaches its inferred retention window. The separate
Claude adapter installs automatic ephemeral caching defaults, which likewise does
not bound history by itself. Source and probe inspection were read-only; this note now
records the shipped Zukhruf compaction path instead of the earlier pre-compaction
state.

## Proposed Zukhruf approach, not a claim about private implementations

Keep one persistent chat ID and its complete transcript. Give the model a separate, bounded working view:

```text
User-visible transcript: all messages and events, retained in storage

Model request:
  fixed instructions and tool definitions
  fixed summary / relevant durable-memory snapshot
  unchanged recent exchanges accumulated since that snapshot
  current input and newly fetched evidence
```

Between compactions, append new material; keep earlier rendered inputs unchanged. Persist injected model-only evidence so subsequent requests can replay it identically. Updating a memory file need not rewrite an early prompt block immediately: new corrections can enter as appended context, with the consolidated snapshot refreshed at the next deliberate boundary.

At a measured token budget, compact older completed exchanges into a durable snapshot and keep a recent verbatim tail. For illustration, allow working context to grow from 16k to 32k, then shrink it; these are tuning examples, not known Muse/Grok settings or a recommendation for every workload. Record which message the snapshot covers, scoped to the active branch. Commit it durably before switching the model view, retain the originals for retrieval, and preserve pending tool calls/results and approvals together. Enforce headroom at sampling boundaries because one tool loop can grow past the budget inside a single user turn.

Maintain a small set of durable facts, decisions, active commitments, and references that remain useful after repeated compactions. Summaries are lossy: an exact old detail should be retrieved from source messages, not reconstructed from an increasingly compressed summary. Retrieved messages remain evidence, not higher-priority instructions. Anthropic independently documents compaction, persistent notes, and on-demand retrieval as techniques for long-running agents.[17]

The shipped first compaction path reuses the existing store, keeps the complete
transcript, and adds a durable bounded model view with checkpoint replay. Recall
through `ContextStore.searchMessages` is still separate work. Provider-native
compaction remains a separate design choice: the installed OpenAI adapter exposes
controls, but correct persistence and replay through Zukhruf's UIMessage flow
still need verification. Do not assume setting one provider option implements
durable portable memory.

Evaluate the result using old-detail recall, corrected preferences, interrupted/restarted compaction, pending approvals, topic switches, and cold returns. Track total input, cache reads/writes, output, compaction cost, and time to first token over many turns. The target is stable cost and useful recall as the stored transcript grows, with ordinary cache misses remaining affordable.

## Sources

1. Meta, [How We Designed Muse](https://introducing.muse.ai/), September 8, 2026.
2. Meta AI Research, [How We Built Safety Into Muse](https://research.meta.ai/blog/security-and-safety-for-ai-agents-our-approach-with-muse), September 8, 2026.
3. Meta, [Introducing Muse: The World's First Personal AI Agent Built for Everyone](https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/), September 8, 2026.
4. xAI, [Designing Grok Bot for a world of persistent agents](https://x.ai/news/designing-grok-bot), September 3, 2026.
5. xAI Docs, [Grok Bot overview](https://docs.x.ai/grok-bot/overview) and [Create and manage Bots](https://docs.x.ai/grok-bot/bots), accessed September 19, 2026.
6. xAI Docs, [Grok Bot FAQ](https://docs.x.ai/grok-bot/faq), accessed September 19, 2026.
7. xAI Docs, [Prompt caching](https://docs.x.ai/developers/advanced-api-usage/prompt-caching), [How it works](https://docs.x.ai/developers/advanced-api-usage/prompt-caching/how-it-works), and [Maximizing cache hits](https://docs.x.ai/developers/advanced-api-usage/prompt-caching/maximizing-cache-hits), accessed September 19, 2026.
8. xAI Docs, [Prompt-caching usage and pricing](https://docs.x.ai/developers/advanced-api-usage/prompt-caching/usage-and-pricing), accessed September 19, 2026.
9. xAI Docs, [Context compaction](https://docs.x.ai/developers/advanced-api-usage/context-compaction), updated September 2, 2026.
10. xAI, [Memory in Grok Build](https://x.ai/news/grok-build-memory), September 16, 2026.
11. xAI, [Grok Build changelog](https://x.ai/build/changelog), accessed September 19, 2026.
12. OpenAI, [Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching), accessed September 19, 2026.
13. vLLM, [Automatic prefix caching](https://docs.vllm.ai/en/v0.15.0/features/automatic_prefix_caching/), prefill-versus-decoding distinction; versioned implementation documentation.
14. Anthropic, [Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching), accessed September 19, 2026.
15. xAI Docs, [Caching best practices and FAQ](https://docs.x.ai/developers/advanced-api-usage/prompt-caching/best-practices), accessed September 19, 2026.
16. OpenAI, [Conversation state](https://developers.openai.com/api/docs/guides/conversation-state), accessed September 19, 2026.
17. Anthropic, [Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents), September 29, 2025.
