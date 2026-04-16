# Deep Research: The Anthropic Advisor Strategy

## Executive Summary

On April 9, 2026, Anthropic launched the **Advisor Strategy** — a server-side tool (`advisor_20260301`) that pairs a cost-efficient executor model (Claude Sonnet 4.6 or Haiku 4.5) with Claude Opus 4.6 as a strategic consultant within a single `/v1/messages` API call. The executor runs the task end-to-end; when it encounters decisions beyond its capability, it escalates to Opus for guidance (typically 400–700 tokens of advice), then resumes execution. This inverts the traditional orchestrator pattern where the expensive model drives everything, instead making the cheap model primary and the expensive model advisory.

Benchmarks demonstrate meaningful gains: Sonnet + Opus advisor scored **74.8% on SWE-bench Multilingual** (+2.7 points over Sonnet alone) while **reducing cost per agentic task by 11.9%** ([Claude Blog: Advisor Strategy](https://claude.com/blog/the-advisor-strategy 'The Advisor Strategy (Claude Blog, 2026-04-09)')). Haiku + Opus advisor achieved **41.2% on BrowseComp** (up from 19.7% solo — a >2x improvement) at **85% lower cost per task than Sonnet** ([Anthropic: Advisor API Docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/advisor-tool 'Advisor Tool Documentation (Anthropic, 2026-04-09)')). The tool is currently in beta, requiring the header `anthropic-beta: advisor-tool-2026-03-01`.

The strategic recommendation is clear: **if you run long-horizon agentic workloads with Sonnet or Haiku, adding the advisor tool is a near-zero-effort optimization** — a single tool definition change — that delivers frontier-class reasoning at dramatically lower cost. The pattern is strongest for coding agents, multi-step research pipelines, and computer-use agents where 95% of operations are mechanical but the remaining 5% require deep reasoning.

## Research Overview

- **Sub-Questions Analyzed**: 5
- **Queries Executed**: 15 queries across 2 iterations
- **Sources**: 12 total (8 authoritative / 67%, 10 recent / 83%)
- **Iterations**: 2

## Findings

### 1. What Is the Advisor Strategy and How Does It Work?

The advisor strategy is a **hierarchical multi-model architecture** where Opus serves as a selective consultant rather than the primary executor. This is a deliberate inversion of the traditional orchestrator-worker pattern: instead of the most expensive model running the show and delegating downward, the cheapest model does all the work and escalates upward only when needed.

When the executor invokes the advisor, the following happens server-side within a single API request ([Anthropic: Advisor API Docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/advisor-tool 'Advisor Tool Documentation (Anthropic, 2026-04-09)')): (1) The executor emits a `server_tool_use` block with `name: "advisor"` and empty input — the executor decides _when_ to escalate, but the server constructs the context. (2) Anthropic runs a separate inference pass on Opus, passing the executor's full transcript — system prompt, all tool definitions, all prior turns, and all tool results. (3) The advisor's response returns as an `advisor_tool_result` block. (4) The executor continues, informed by the advice. The advisor itself runs without tools and without context management; its thinking blocks are dropped before the result reaches the executor — only the advice text passes through.

A critical design decision is that the advisor sees **everything** the executor has seen. There is no manual context passing, no orchestration code, no routing logic on the developer's side. The entire mechanism is a single tool added to the `tools` array. As [BuildFastWithAI: Advisor Strategy](https://www.buildfastwithai.com/blogs/anthropic-advisor-strategy-claude-api 'Anthropic Advisor Strategy (BuildFastWithAI, 2026-04-09)') notes, this is "one config change — done."

**Key Insights**:

- The advisor pattern inverts the traditional orchestrator model — cheap model primary, expensive model advisory — which aligns cost with the actual distribution of task complexity [Claude Blog: Advisor Strategy](https://claude.com/blog/the-advisor-strategy 'The Advisor Strategy (Claude Blog, 2026-04-09)')
- All escalation happens server-side within a single `/v1/messages` request; no extra round-trips or orchestration logic required from the developer [Anthropic: Advisor API Docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/advisor-tool 'Advisor Tool Documentation (Anthropic, 2026-04-09)')
- The advisor generates only short strategic guidance (400–700 text tokens, 1,400–1,800 total including thinking), not the full output — this is the core mechanism behind the cost savings [Anthropic: Advisor API Docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/advisor-tool 'Advisor Tool Documentation (Anthropic, 2026-04-09)')

### 2. How Does It Perform? (Benchmarks)

The benchmarks tell a compelling story about quality uplift with cost reduction:

**Sonnet 4.6 + Opus 4.6 Advisor**:

- SWE-bench Multilingual: **74.8%** (vs 72.1% solo — +2.7 points)
- Cost per agentic task: **-11.9%** compared to Sonnet alone
- Terminal-Bench 2.0: Improved (exact numbers not published)

**Haiku 4.5 + Opus 4.6 Advisor**:

- BrowseComp: **41.2%** (vs 19.7% solo — >2x improvement)
- Cost per task: **85% less than Sonnet solo**
- However: 29% worse than Sonnet alone on absolute performance

The Sonnet configuration is the headline story: you get **better performance AND lower cost simultaneously**. This is because the advisor's strategic guidance reduces the number of tool calls and conversation turns needed to reach a solution, which more than offsets the Opus-rate tokens used for advice ([Claude Blog: Advisor Strategy](https://claude.com/blog/the-advisor-strategy 'The Advisor Strategy (Claude Blog, 2026-04-09)')). The Haiku configuration represents a different tradeoff — dramatically cheaper than Sonnet with a meaningful quality uplift, making it ideal for high-volume workflows where per-unit cost is the primary constraint ([MindStudio: Advisor Strategy](https://www.mindstudio.ai/blog/anthropic-advisor-strategy-cut-ai-agent-costs 'Anthropic Advisor Strategy (MindStudio, 2026-04-09)')).

An important nuance: the advisor actually _improves_ quality on hard tasks specifically because it allows Opus to focus exclusively on complex reasoning rather than being diluted across trivial steps ([MindStudio: Advisor Strategy](https://www.mindstudio.ai/blog/anthropic-advisor-strategy-cut-ai-agent-costs 'Anthropic Advisor Strategy (MindStudio, 2026-04-09)')).

**Key Insights**:

- Sonnet + Opus advisor achieves the rare combination of +quality AND -cost — driven by fewer total tool calls and shorter conversations [Claude Blog: Advisor Strategy](https://claude.com/blog/the-advisor-strategy 'The Advisor Strategy (Claude Blog, 2026-04-09)')
- Haiku + Opus advisor is the cost-optimal configuration for high-volume workflows, delivering >2x quality uplift at 85% lower cost than Sonnet [Claude Blog: Advisor Strategy](https://claude.com/blog/the-advisor-strategy 'The Advisor Strategy (Claude Blog, 2026-04-09)')
- Results are task-dependent — Anthropic explicitly recommends evaluating on your own workload before committing [Anthropic: Advisor API Docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/advisor-tool 'Advisor Tool Documentation (Anthropic, 2026-04-09)')

### 3. How to Implement It? (API Details)

Implementation is minimal. Add the advisor tool to your existing `tools` array and include the beta header:

```python
response = client.beta.messages.create(
    model="claude-sonnet-4-6",
    max_tokens=4096,
    betas=["advisor-tool-2026-03-01"],
    tools=[
        {
            "type": "advisor_20260301",
            "name": "advisor",
            "model": "claude-opus-4-6",
            "max_uses": 3,  # optional cap per request
            "caching": {"type": "ephemeral", "ttl": "5m"},  # optional
        }
    ],
    messages=[...]
)
```

**Tool parameters** ([Anthropic: Advisor API Docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/advisor-tool 'Advisor Tool Documentation (Anthropic, 2026-04-09)')):

| Parameter  | Required | Description                                                                                            |
| ---------- | -------- | ------------------------------------------------------------------------------------------------------ |
| `type`     | Yes      | Must be `"advisor_20260301"`                                                                           |
| `name`     | Yes      | Must be `"advisor"`                                                                                    |
| `model`    | Yes      | The advisor model (e.g., `"claude-opus-4-6"`)                                                          |
| `max_uses` | No       | Per-request cap on advisor calls. Excess calls return `max_uses_exceeded` error and executor continues |
| `caching`  | No       | `{"type": "ephemeral", "ttl": "5m" \| "1h"}` for advisor-side prompt caching                           |

**Valid model pairs**: Haiku 4.5 → Opus 4.6, Sonnet 4.6 → Opus 4.6, Opus 4.6 → Opus 4.6. Invalid pairs return `400 invalid_request_error`.

**Multi-turn conversations** require passing the full assistant content (including `advisor_tool_result` blocks) back verbatim. If you remove the advisor tool from `tools` on a follow-up turn while history still contains `advisor_tool_result` blocks, the API returns `400`. The workaround: strip all `advisor_tool_result` blocks from history when removing the tool.

**Streaming behavior**: The advisor does **not** stream. The executor's stream pauses during advisor inference, with SSE ping keepalives every ~30 seconds. The full advisor result arrives in a single `content_block_start` event.

**Response structure**:

- `server_tool_use` → `advisor_tool_result` with `content.type`:
  - `advisor_result` — contains `text` field with human-readable advice
  - `advisor_redacted_result` — contains `encrypted_content` (opaque blob, server decrypts on next turn)
- Error codes: `max_uses_exceeded`, `too_many_requests`, `overloaded`, `prompt_too_long`, `execution_time_exceeded`, `unavailable`

**Key Insights**:

- Implementation is a one-line-change-level integration — add the tool definition and beta header, everything else is handled server-side [Anthropic: Advisor API Docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/advisor-tool 'Advisor Tool Documentation (Anthropic, 2026-04-09)')
- `max_uses` is per-request, not per-conversation — for conversation-level caps, count client-side and strip `advisor_tool_result` blocks when removing the tool [Anthropic: Advisor API Docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/advisor-tool 'Advisor Tool Documentation (Anthropic, 2026-04-09)')
- Advisor-side prompt caching breaks even at ~3 calls per conversation; enable for long agent loops, skip for short tasks [Anthropic: Advisor API Docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/advisor-tool 'Advisor Tool Documentation (Anthropic, 2026-04-09)')

### 4. Cost Structure and Optimization

The billing model is straightforward but has nuances:

**Per-model token pricing** ([Anthropic: Pricing](https://platform.claude.com/docs/en/about-claude/pricing 'Pricing (Anthropic, 2026)')):

| Model      | Input/MTok | Output/MTok | Batch Input | Batch Output |
| ---------- | ---------- | ----------- | ----------- | ------------ |
| Opus 4.6   | $5.00      | $25.00      | $2.50       | $12.50       |
| Sonnet 4.6 | $3.00      | $15.00      | $1.50       | $7.50        |
| Haiku 4.5  | $1.00      | $5.00       | $0.50       | $2.50        |

Advisor tokens are billed at **Opus rates** and reported separately in `usage.iterations[]` (entries with `type: "advisor_message"`). They are **not** rolled into top-level usage totals. The top-level `max_tokens` applies only to executor output; it does not bound advisor tokens.

**Cost optimization levers**:

1. **Conciseness instruction**: Adding "The advisor should respond in under 100 words and use enumerated steps, not explanations" to the system prompt cut advisor output tokens by **35–45%** in Anthropic's internal testing ([Anthropic: Advisor API Docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/advisor-tool 'Advisor Tool Documentation (Anthropic, 2026-04-09)'))
2. **Effort settings**: Sonnet at medium effort + Opus advisor achieves comparable intelligence to Sonnet at default effort, at lower cost ([Anthropic: Advisor API Docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/advisor-tool 'Advisor Tool Documentation (Anthropic, 2026-04-09)'))
3. **Prompt caching**: Cached input tokens cost only 0.1x base rate; 5-min cache writes cost 1.25x, 1-hour writes cost 2x ([Anthropic: Pricing](https://platform.claude.com/docs/en/about-claude/pricing 'Pricing (Anthropic, 2026)'))
4. **Batch processing**: Supported, with `usage.iterations` reported per item — all models get 50% discount in batch mode

**Key Insights**:

- The conciseness system prompt instruction is the single highest-leverage cost optimization — 35–45% reduction in advisor output tokens with no quality loss [Anthropic: Advisor API Docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/advisor-tool 'Advisor Tool Documentation (Anthropic, 2026-04-09)')
- Cost savings come from advisor generating only short guidance while executor does bulk generation at cheaper rates — a typical consultation is 400–700 text tokens [Anthropic: Advisor API Docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/advisor-tool 'Advisor Tool Documentation (Anthropic, 2026-04-09)')
- Priority Tier does NOT extend from executor to advisor — you need it on each model separately [Anthropic: Advisor API Docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/advisor-tool 'Advisor Tool Documentation (Anthropic, 2026-04-09)')

### 5. Limitations, Tradeoffs, and Comparison to Alternatives

**Known limitations** ([Anthropic: Advisor API Docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/advisor-tool 'Advisor Tool Documentation (Anthropic, 2026-04-09)')):

- **Advisor output does not stream** — expect a visible pause in the UX during advisor inference
- **No built-in conversation-level cap** — must track client-side
- **`max_tokens` doesn't bound advisor tokens** — advisor can generate beyond the executor's cap
- **`clear_thinking` with non-`"all"` keep values** causes advisor-side cache misses
- **`clear_tool_uses` not yet fully compatible** with advisor blocks
- **Latency overhead**: Each advisor consultation adds an unmeasured but non-trivial pause. For real-time applications, test carefully ([BuildFastWithAI: Advisor Strategy](https://www.buildfastwithai.com/blogs/anthropic-advisor-strategy-claude-api 'Anthropic Advisor Strategy (BuildFastWithAI, 2026-04-09)'))

**When NOT to use** ([Anthropic: Advisor API Docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/advisor-tool 'Advisor Tool Documentation (Anthropic, 2026-04-09)')):

- Single-turn Q&A (nothing to plan)
- Pass-through model pickers where users choose their own cost/quality
- Workloads where every turn needs frontier-class reasoning
- Strict latency requirements

**Comparison to other multi-model patterns** ([Microsoft: Agent Orchestration Patterns](https://learn.microsoft.com/en-us/azure/architecture/ai-ml/guide/ai-agent-design-patterns 'AI Agent Design Patterns (Microsoft, 2026)'), [Kore.ai: Orchestration Patterns](https://www.kore.ai/blog/choosing-the-right-orchestration-pattern-for-multi-agent-systems 'Orchestration Patterns (Kore.ai, 2026)')):

| Pattern                        | Who drives?            | Escalation                   | Developer complexity         |
| ------------------------------ | ---------------------- | ---------------------------- | ---------------------------- |
| **Advisor** (Anthropic)        | Cheap executor         | Upward to expensive advisor  | Minimal (server-side)        |
| **Orchestrator** (traditional) | Expensive orchestrator | Downward to cheap workers    | High (routing logic)         |
| **Router** (OpenAI/external)   | Separate classifier    | Horizontal to best-fit model | Medium (classifier training) |
| **Cascading**                  | Cheapest model first   | Progressive escalation       | Medium (quality gates)       |

The advisor pattern is unique in its zero-orchestration-code requirement. Traditional orchestrator patterns require developers to build routing logic, manage context passing, and handle failure modes. The advisor handles all of this server-side.

**Key Insights**:

- The advisor pattern's key differentiator is zero developer-side orchestration — no routing logic, no context management, no failure handling code [Anthropic: Advisor API Docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/advisor-tool 'Advisor Tool Documentation (Anthropic, 2026-04-09)')
- Latency is the primary practical concern — the stream pauses during advisor inference with no progressive output [BuildFastWithAI: Advisor Strategy](https://www.buildfastwithai.com/blogs/anthropic-advisor-strategy-claude-api 'Anthropic Advisor Strategy (BuildFastWithAI, 2026-04-09)')
- For production systems needing maximum control over routing decisions, custom orchestrator patterns still offer more flexibility, but at significantly higher development cost [Microsoft: Agent Orchestration Patterns](https://learn.microsoft.com/en-us/azure/architecture/ai-ml/guide/ai-agent-design-patterns 'AI Agent Design Patterns (Microsoft, 2026)')

### 6. Suggested System Prompts (from Anthropic)

**Timing guidance** (prepend to executor system prompt for coding tasks):

```
You have access to an `advisor` tool backed by a stronger reviewer model. It takes NO parameters — when you call advisor(), your entire conversation history is automatically forwarded. They see the task, every tool call you've made, every result you've seen.

Call advisor BEFORE substantive work — before writing, before committing to an interpretation, before building on an assumption. If the task requires orientation first (finding files, fetching a source, seeing what's there), do that, then call advisor. Orientation is not substantive work. Writing, editing, and declaring an answer are.

Also call advisor:
- When you believe the task is complete. BEFORE this call, make your deliverable durable: write the file, save the result, commit the change. The advisor call takes time; if the session ends during it, a durable result persists and an unwritten one doesn't.
- When stuck — errors recurring, approach not converging, results that don't fit.
- When considering a change of approach.

On tasks longer than a few steps, call advisor at least once before committing to an approach and once before declaring done. On short reactive tasks where the next action is dictated by tool output you just read, you don't need to keep calling — the advisor adds most of its value on the first call, before the approach crystallizes.
```

**How to treat advice** (place directly after timing block):

```
Give the advice serious weight. If you follow a step and it fails empirically, or you have primary-source evidence that contradicts a specific claim (the file says X, the paper states Y), adapt. A passing self-test is not evidence the advice is wrong — it's evidence your test doesn't check what the advice is checking.

If you've already retrieved data pointing one way and the advisor points another: don't silently switch. Surface the conflict in one more advisor call — "I found X, you suggest Y, which constraint breaks the tie?" The advisor saw your evidence but may have underweighted it; a reconcile call is cheaper than committing to the wrong branch.
```

**Conciseness instruction** (cuts advisor output 35–45%):

```
The advisor should respond in under 100 words and use enumerated steps, not explanations.
```

## Synthesis

The advisor strategy represents a pragmatic answer to the cost-quality tradeoff in agentic AI. Rather than forcing developers to choose between expensive frontier models (quality) and cheap models (cost), it lets them combine both with near-zero integration effort. The pattern works because most agentic work is mechanical — file reads, tool calls, formatting — and only a small fraction requires deep reasoning. By concentrating Opus's capability on those critical moments, you get disproportionate quality improvement relative to the additional cost.

The most surprising finding is that Sonnet + Opus advisor is **cheaper than Sonnet alone** while being more capable. This happens because the advisor's strategic guidance reduces total conversation length and tool calls, meaning the cost of 2–3 Opus consultations is more than offset by the savings from a shorter, more efficient executor run. This is a genuinely rare case of "better and cheaper."

**Consensus** (3+ sources agree):

- Sonnet + Opus advisor delivers measurable quality uplift at lower total cost [Claude Blog: Advisor Strategy](https://claude.com/blog/the-advisor-strategy 'The Advisor Strategy (Claude Blog, 2026-04-09)'), [BuildFastWithAI: Advisor Strategy](https://www.buildfastwithai.com/blogs/anthropic-advisor-strategy-claude-api 'Anthropic Advisor Strategy (BuildFastWithAI, 2026-04-09)'), [MindStudio: Advisor Strategy](https://www.mindstudio.ai/blog/anthropic-advisor-strategy-cut-ai-agent-costs 'Anthropic Advisor Strategy (MindStudio, 2026-04-09)')
- The pattern is strongest for long-horizon agentic workloads (coding, research, computer use) [Claude Blog: Advisor Strategy](https://claude.com/blog/the-advisor-strategy 'The Advisor Strategy (Claude Blog, 2026-04-09)'), [Anthropic: Advisor API Docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/advisor-tool 'Advisor Tool Documentation (Anthropic, 2026-04-09)'), [BuildFastWithAI: Advisor Strategy](https://www.buildfastwithai.com/blogs/anthropic-advisor-strategy-claude-api 'Anthropic Advisor Strategy (BuildFastWithAI, 2026-04-09)')
- Latency during advisor calls is the primary practical limitation [BuildFastWithAI: Advisor Strategy](https://www.buildfastwithai.com/blogs/anthropic-advisor-strategy-claude-api 'Anthropic Advisor Strategy (BuildFastWithAI, 2026-04-09)'), [MindStudio: Advisor Strategy](https://www.mindstudio.ai/blog/anthropic-advisor-strategy-cut-ai-agent-costs 'Anthropic Advisor Strategy (MindStudio, 2026-04-09)'), [Anthropic: Advisor API Docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/advisor-tool 'Advisor Tool Documentation (Anthropic, 2026-04-09)')

**Contradictions**:

- None identified. All sources are consistent on the core claims, likely because the tool was released April 9, 2026 and all coverage draws from the same Anthropic blog post and API docs.

**Research Gaps**:

- **No independent third-party benchmarks** yet — all performance numbers come from Anthropic's internal evaluations. Independent validation on diverse workloads is pending.
- **Latency overhead not quantified** — no source provides millisecond-level measurements of the advisor pause duration.
- **No long-term production case studies** — the tool launched April 9, 2026, so real-world deployment experience is minimal.

## Recommendations

### Critical (Do First)

1. **Add the advisor tool to existing Sonnet-based agentic workflows** — This is the highest-ROI change: a single tool definition yields +2.7 points on SWE-bench-class tasks while _reducing_ cost by 11.9%. Start with `max_uses: 3` to limit cost exposure during evaluation. [Claude Blog: Advisor Strategy](https://claude.com/blog/the-advisor-strategy 'The Advisor Strategy (Claude Blog, 2026-04-09)'), [Anthropic: Advisor API Docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/advisor-tool 'Advisor Tool Documentation (Anthropic, 2026-04-09)')

2. **Add the conciseness system prompt instruction** — Prepend "The advisor should respond in under 100 words and use enumerated steps, not explanations" to your system prompt. This cuts advisor token costs 35–45% with no quality degradation — the single best cost optimization available. [Anthropic: Advisor API Docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/advisor-tool 'Advisor Tool Documentation (Anthropic, 2026-04-09)')

3. **Use Anthropic's suggested timing system prompt for coding tasks** — The timing guidance (call advisor before substantive work, when stuck, and before declaring done) produced the highest intelligence at near-Sonnet cost in Anthropic's internal coding evaluations. [Anthropic: Advisor API Docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/advisor-tool 'Advisor Tool Documentation (Anthropic, 2026-04-09)')

### Important (Do Next)

4. **Implement client-side conversation-level budget tracking** — Count advisor calls per conversation and strip `advisor_tool_result` blocks from history when removing the tool. The API has no built-in conversation cap. [Anthropic: Advisor API Docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/advisor-tool 'Advisor Tool Documentation (Anthropic, 2026-04-09)')

5. **Enable advisor-side prompt caching for conversations expecting 3+ advisor calls** — Set `caching: {"type": "ephemeral", "ttl": "5m"}` on the tool definition. Keep it off for short tasks (< 3 calls) where the cache write cost exceeds read savings. [Anthropic: Advisor API Docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/advisor-tool 'Advisor Tool Documentation (Anthropic, 2026-04-09)')

6. **Evaluate Haiku + Opus advisor for high-volume cost-sensitive workflows** — If you have pipelines doing legal extraction, data classification, or research at scale, this configuration offers >2x quality uplift at 85% lower cost than Sonnet. [Claude Blog: Advisor Strategy](https://claude.com/blog/the-advisor-strategy 'The Advisor Strategy (Claude Blog, 2026-04-09)'), [MindStudio: Advisor Strategy](https://www.mindstudio.ai/blog/anthropic-advisor-strategy-cut-ai-agent-costs 'Anthropic Advisor Strategy (MindStudio, 2026-04-09)')

### Optional (Consider)

7. **Test with `effort: "medium"` on the Sonnet executor** — Pairing medium-effort Sonnet with Opus advisor achieves comparable intelligence to default-effort Sonnet at lower cost. Only for cost-constrained environments willing to accept a slight quality tradeoff. [Anthropic: Advisor API Docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/advisor-tool 'Advisor Tool Documentation (Anthropic, 2026-04-09)')

8. **Monitor escalation frequency** — Track what percentage of requests trigger advisor calls. High rates (80%+) suggest the task is too complex for the executor; low rates (<1%) suggest you may not need the advisor at all. [MindStudio: Advisor Strategy](https://www.mindstudio.ai/blog/anthropic-advisor-strategy-cut-ai-agent-costs 'Anthropic Advisor Strategy (MindStudio, 2026-04-09)')

## References

### Official Documentation

- **Claude Blog: Advisor Strategy** (2026-04-09). "The Advisor Strategy: Give Sonnet an Intelligence Boost with Opus". https://claude.com/blog/the-advisor-strategy
- **Anthropic: Advisor API Docs** (2026-04-09). "Advisor Tool — Claude API Documentation". https://platform.claude.com/docs/en/agents-and-tools/tool-use/advisor-tool
- **Anthropic: Pricing** (2026). "Claude API Pricing". https://platform.claude.com/docs/en/about-claude/pricing

### Blog Posts & Articles

- **BuildFastWithAI: Advisor Strategy** (2026-04-09). "Anthropic Advisor Strategy: Smarter AI Agents". https://www.buildfastwithai.com/blogs/anthropic-advisor-strategy-claude-api
- **MindStudio: Advisor Strategy** (2026-04-09). "What Is the Anthropic Advisor Strategy? How to Cut AI Agent Costs Without Sacrificing Quality". https://www.mindstudio.ai/blog/anthropic-advisor-strategy-cut-ai-agent-costs
- **GIGAZINE: Advisor Tool** (2026-04-10). "Anthropic Has Unveiled a System That Combines Inexpensive and Expensive Claude Models". https://gigazine.net/gsc_news/en/20260410-anthropic-advisor-tool/
- **GadgetBond: Advisor Strategy** (2026-04-10). "Anthropic Just Showed Devs How to Stop Overpaying for Opus-Level AI". https://gadgetbond.com/anthropic-claude-opus-sonnet-haiku-advisor-tool/
- **AI Tools Recap: Advisor Strategy** (2026-04-09). "Anthropic Advisor Strategy: Get Opus Intelligence at Sonnet Prices". https://aitoolsrecap.com/Blog/anthropic-advisor-strategy-claude-opus-sonnet-haiku-2026

### Industry Analysis

- **Microsoft: Agent Orchestration Patterns** (2026). "AI Agent Design Patterns — Azure Architecture Center". https://learn.microsoft.com/en-us/azure/architecture/ai-ml/guide/ai-agent-design-patterns
- **Kore.ai: Orchestration Patterns** (2026). "Choosing the Right Orchestration Pattern for Multi-Agent Systems". https://www.kore.ai/blog/choosing-the-right-orchestration-pattern-for-multi-agent-systems
- **Blockchain News: Advisor Strategy Analysis** (2026-04-09). "Claude Advisor Strategy Beta: Latest Analysis on Anthropic's Agentic Workflow Play". https://blockchain.news/ainews/claude-advisor-strategy-beta-latest-analysis-on-anthropic-s-agentic-workflow-play-for-2026
