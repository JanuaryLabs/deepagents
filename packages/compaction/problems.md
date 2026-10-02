# Compaction problems

Recorded on 2026-09-20 after comparing this package with Vercel Eve and LangChain
JavaScript. These are open findings, not implemented changes. The runtime probes
used this package's public API and installed `langchain@1.5.3`; upstream source
links below point to moving branches. Status updates distinguish resolved findings
from the remaining limitations.

## 1. The latest user turn prevents compaction of completed tool work

**Status:** Addressed during Zukhruf integration. Completed exchanges may now be
summarized within a turn, and the latest user request is replayed verbatim before
the retained steps. The original limitation and reproduction are recorded below.

**Original behavior:** `replacementRange()` in [messages.ts](./src/messages.ts)
protects the latest user message and every message after it. A long-running agent
can accumulate many completed tool exchanges within that single turn, but none
of those exchanges can be summarized.

**Evidence:** A deterministic probe with one user request and six completed
tool-call/result cycles returned `cannot-fit` with `no-safe-boundary` and made no
summarizer call. LangChain summarized the older cycles and retained the latest
call/result pair. With earlier conversation history available, our package can
still return `protected-history` when the current turn alone exceeds the budget.

**Required outcome:** Allow compaction within a user turn while preserving the
active request, unresolved tool calls and approvals, and complete tool exchanges
that remain in context. Protecting unfinished work must not pin all completed
work from the same turn.

**Verification:** Exercise a single user request with enough completed tool cycles
to exceed the budget. Compaction should succeed when a valid summary and retained
history can fit, and the next native AI SDK request must contain valid tool pairs
and the active request.

## 2. Recent-history retention is based on message count

**Current behavior:** `keepLastMessages` establishes a minimum retained suffix.
Boundary protection can expand that suffix, but selection does not allocate a
token budget to recent history. Four messages can be tiny or contain enormous
tool outputs. If the selected suffix leaves no summary space, the call fails
without trying a smaller safe suffix.

**Required outcome:** Select recent history using a token budget with space
reserved for the summary and its wrapper. Define how that budget interacts with
explicit retention requirements. Preserve unresolved exchanges and the final
combined-size check; do not satisfy the budget by silently breaking guarantees.

**Verification:** Use histories with uneven message sizes and assert that the
selected history plus summary fits the configured estimate whenever a permitted
boundary allows it. Irreducible protected history must still return `cannot-fit`.

## 3. The summarization request has no input budget

**Current behavior:** [compact.ts](./src/compact.ts) serializes the entire selected
prefix into one prompt. The output allowance is capped at 2,048 tokens, but the
input has no size check or reduction policy. A large conversation can therefore
overflow the summarization model even when the requested compacted result is
small. A different summarization model may have a smaller context window than
the conversation model.

**Comparison:** Eve renders and reduces oversized transcript payloads while
passing the previous checkpoint separately. LangChain defaults to trimming the
history supplied to its summarizer to approximately 4,000 tokens. These reductions
can omit evidence; neither approach should be copied without an explicit policy
for information loss.

**Required outcome:** Budget the actual summarizer input, including its
instructions and transcript formatting, with output headroom. Define what happens
when it cannot fit, how any reduction is reported, and how previous-summary facts
are preserved. Provider failures must continue to reject without adopting a
replacement history.

**Verification:** Supply a source history larger than the summarizer's allowed
input. Assert that no oversized request is submitted and that the documented
failure or reduction behavior occurs without silently discarding source history.

## 4. Summary quality across repeated compaction is unverified

**Current behavior:** Integration tests use deterministic model responses. They
prove message structure, budget handling, preservation boundaries, provenance,
and failure behavior. They do not establish whether a real summarizer preserves
the information needed to continue after repeated compaction.

**Risk:** A summary can fit the budget while losing completed work, constraints,
identifiers, or the distinction between verified results and assumptions. A
continuing agent may repeat completed actions or act on an incorrect task state.

**Required outcome:** Evaluate real-model summaries over several compaction cycles
using conversations with known facts, completed work, changed decisions, and
remaining tasks. Check continuation behavior as well as summary text.

**Verification:** Measure preservation of critical facts and exact identifiers,
correct handling of superseded decisions, and unnecessary repetition of completed
work. Report semantic quality separately from deterministic test results.

## Boundaries and guarantees to retain

- Keep the package standalone and AI SDK-native. Runtime triggering, persistence,
  atomic adoption, and task-state restoration remain caller responsibilities.
- Preserve input messages on failure. Do not turn provider errors into summaries:
  the LangChain probe returned a history replacement containing the provider error
  text, and the inspected upstream implementation has the same catch behavior.
- Keep the final combined token check and explicit `cannot-fit` outcomes. A target
  is an estimate under the supplied counter, not a provider billing guarantee.

## Comparison sources

- [Eve compaction implementation](https://github.com/vercel/eve/blob/main/packages/eve/src/harness/compaction.ts)
- [Eve summary prompt and transcript reduction](https://github.com/vercel/eve/blob/main/packages/eve/src/harness/compaction-prompt.ts)
- [Eve compaction lifecycle](https://github.com/vercel/eve/blob/main/docs/concepts/default-harness.md)
- [LangChain JavaScript summarization middleware](https://github.com/langchain-ai/langchainjs/blob/main/libs/langchain/src/agents/middleware/summarization.ts)
