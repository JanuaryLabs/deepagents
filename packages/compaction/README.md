# @deepagents/compaction

Reduce an AI SDK conversation snapshot to a summary and recent history. This
package uses AI SDK v7 types directly and has no dependency on
`@deepagents/context` or Zukhruf. It owns no store, scheduler, or conversation state.

Implementation decisions and verification are recorded in the
[phase files](./plan/README.md).

```ts
import { compact } from '@deepagents/compaction';

const result = await compact({
  messages, // AI SDK ModelMessage[]
  model: summaryModel, // Your explicitly configured summarization model
  targetTokens: 20_000,
  keepLastMessages: 4, // Optional; defaults to 4
  instructions: 'Preserve exact customer commitments and record IDs.',
  abortSignal,
});

switch (result.status) {
  case 'compacted':
    // Persist the result and its source-message mapping before adopting it.
    // result.replacedRange contains half-open indices into the input snapshot.
    break;
  case 'cannot-fit':
    // result.reason explains the failure. result.messages still holds the input.
    break;
}
```

## Result contract

- `messages`: the prepared messages on success, otherwise an unchanged copy of
  the input array. Input messages and their provider metadata are never mutated.
- `tokens.before` / `tokens.after`: estimates for the input and returned messages.
- `usage`: native AI SDK `LanguageModelUsage` when summarization ran, including
  when its output was rejected; otherwise `undefined`.
- On `compacted`, `summary` contains the generated text and `replacedRange`
  identifies exactly `messages.slice(start, end)` from the input snapshot.
- On `cannot-fit`, `reason` is `no-safe-boundary`, `protected-history`,
  `incomplete-summary`, `empty-summary`, or `summary-too-large`.

Indices describe this call's input, not permanent history IDs. Callers map them to
their own stable identifiers, persist the mapping and summary together, and keep
the original transcript for display or retrieval. Retained message objects are
reused unchanged. Treat both input and output as immutable snapshots.

## What stays verbatim

Compaction replaces one contiguous older range with an ordinary user message
labelled `Previous conversation summary`. It never promotes historical content
to system instructions.

The last four messages are retained by default. `keepLastMessages` changes this
minimum, but the retained suffix expands to include unresolved tool calls/approvals
and complete tool/approval relationships crossing the proposed boundary. Completed
exchanges can be summarized within a user turn. When the latest user request falls
inside the replaced range, it is also replayed verbatim after the summary and
before the retained steps. Closed exchanges wholly inside the replaced range are
supplied together to the summarization model.

Leading system messages remain in place. Later system messages, files, media, and
opaque provider content protect the suffix starting at their position. They are
not converted into lossy text. If that protected history leaves no room for a
summary, the result is `cannot-fit`; the package never silently discards it.

## Budgets and model calls

`targetTokens` covers only the supplied messages. The caller must separately
allow for external instructions, tool definitions, provider overhead, and output
headroom. The default estimates serialized text messages at one token per four
characters, rounded up (zero for an empty array). This is a heuristic, not a
guarantee about any provider's tokenizer or billing.

For media or opaque provider content, supply a counter that understands the
selected conversation model. This also lets text-only callers use a more precise
provider-specific counter:

```ts
const result = await compact({
  messages,
  model: summaryModel,
  targetTokens: 20_000,
  countTokens: async (candidateMessages) => {
    return countForConversationModel(candidateMessages);
  },
});
```

`estimateTokens(messages)` exposes the same default text counter for callers that
need to check an automatic trigger before invoking `compact()`.

The counter receives complete candidate message arrays, including the summary
wrapper. It must return a non-negative safe integer and must not mutate its input.
The package checks the final result with the same counter before returning success.

One call makes at most one summarization request, with SDK retries disabled.
Its output allowance is the estimated remaining budget, capped at 2,048 tokens.
Empty, truncated, non-text-only, or over-budget summaries are not adopted.
Provider errors, invalid inputs/counters, and cancellation reject the promise.
The summarization model must itself support the serialized history's input size;
this package does not split an oversized history into multiple model calls.

## Ongoing conversations

The caller chooses when to compact. For example, a runtime may trigger at 60,000
estimated input tokens and pass an available message target of 20,000 tokens. A
higher trigger than target leaves room for subsequent turns.

After saving a successful result, reuse `result.messages` and append new messages.
Do not recompute a summary on every turn. A later compaction can consume the
previous summary along with newer history. Keep that summary unchanged between
compactions so replay remains stable; provider cache retention remains the
provider's responsibility.

## Zukhruf integration

Configure automatic compaction on the agent declaration, alongside its model and
instructions:

```ts
import {
  cacheLikelyCold,
  messagesExceed,
  tokensExceed,
} from '@deepagents/compaction';

const root = defineAgent({
  name: 'assistant',
  model,
  sandbox,
  instructions,
  compaction: {
    model: summaryModel,
    triggers: [tokensExceed(60_000), messagesExceed(100)],
    targetTokens: 20_000,
    keepLastMessages: 4,
  },
});
```

`defineAgent` comes from `@deepagents/experimental/zukhruf`. Supply the
summarization model explicitly. `triggers` is a non-empty array of predicates;
Zukhruf evaluates them in order and stops at the first match (OR). The threshold
helpers require a positive safe integer and match strictly above the threshold,
not at equality. `messagesExceed` counts all current model messages, including
summaries and tool messages, not user turns or the original stored transcript.

Triggers receive a read-only
`{ messages, tokens, cacheAgeMs, cacheRetentionMs }` snapshot after checkpoint
replay and context preparation. `tokens` estimates the complete model input:
messages, instructions, tool definitions, and any structured-output schema.
The runtime uses the same character heuristic for messages and the request envelope.
Provider framing, code-mode wrappers, and server tools remain approximate.
Custom predicates may return a boolean or a promise;
errors stop the turn before sampling. These helpers require no network access.

Use `cacheLikelyCold()` to compact when an observed prompt cache reaches the
retention window of the provider request:

```ts
import { cacheLikelyCold } from '@deepagents/compaction';

const triggers = [cacheLikelyCold()];
```

Zukhruf reads native SDK request metadata with `include.requestBody`, after model
middleware has applied its settings. It persists the inferred window alongside
the cache observation; no additional provider API call is needed.

- OpenAI GPT-5.6 and later use the documented 30-minute policy. Earlier models
  with explicit `in_memory` or `24h` settings use conservative upper bounds of
  one hour or 24 hours. An omitted older-model policy is unknown because the
  organization can determine the default. [OpenAI cache lifetime](https://developers.openai.com/api/docs/guides/prompt-caching#cache-lifetime).
- Anthropic (including the local Claude provider) uses the request's cache
  controls: five minutes when `ttl` is omitted or `5m`, one hour for `1h`.
  Observed cache-write usage distinguishes five-minute and one-hour writes.
  Mixed breakpoints without enough usage evidence have an unknown window;
  requesting a longer TTL does not establish that its prefix was cached.
  [Anthropic cache durations](https://platform.claude.com/docs/en/build-with-claude/prompt-caching#1-hour-cache-duration).
- OpenRouter uses the reported upstream provider and resolved response model.
  OpenAI and Anthropic routes use those policies. Unrecognized upstreams remain
  unknown; the model's vendor prefix alone is insufficient.

Unrecognized providers, missing request bodies, unsupported policies, and Gemini
implicit caching have no inferred retention window. The trigger remains inactive.
For a custom provider, an explicit override is available:
`cacheLikelyCold({ retentionMs: yourProviderRetentionMs })`. The override must be a
positive safe integer in milliseconds. Equality matches.

Zukhruf records the request-start time when the main model reports a positive
cache read or write, including the final step. A write with zero reads establishes
a fresh baseline. Recording works with telemetry disabled and survives a fresh
host. A successful response without positive cache counters clears the baseline.

`cacheAgeMs` is undefined without matching evidence: the branch, model,
instructions, tool definitions, SDK request settings, and previously sent message
prefix must still match, and the clock must not have moved backward. Appending
messages preserves prefix evidence.
The helper returns false when evidence or retention is unknown. It estimates
expiry; it does not query provider cache status or predict routing changes.
It does not configure provider caching. No trigger requires network access.

A matching trigger decides to compact. `targetTokens` caps the resulting context;
it never suppresses a match. Direct calls to `compact()` also attempt reduction,
even when the input already fits the target.
Set token thresholds above the target to leave headroom between compactions.
In Zukhruf, both the token trigger and target cover estimated full input. The
runtime subtracts the instruction/tool envelope from `targetTokens` before calling
`compact()`, then adds it back to the reported result. If the envelope alone
exhausts the target, the turn fails with `request-overhead` before summarization.
Standalone `compact()` still budgets only its supplied messages. Reserve output
headroom separately and supply `countTokens` for media.

The runtime persists successful per-step input usage under
`chat.metadata.zukhruf.inputUsage`, independently of telemetry. With the same
model, branch, instructions, tools, settings, and unchanged projected message
prefix, the next estimate is that measured input plus the estimated appended
messages. Cached input remains included; output and summary-model usage are not
added again. The association survives host restarts and checkpoint restoration.
Changed settings/prefixes or applied summaries invalidate it. Missing or invalid
usage and native-compaction/aggregate iteration usage fall back to a fresh estimate;
they are never treated as reliable context occupancy. Native provider compaction
is not enabled by this feature.

An explicit `countTokens(messages)` takes precedence over measured usage. Runtime
then adds the estimated envelope; standalone calls use only that custom count.
Neither approach promises an exact model-token cap. No counting endpoint or model
catalog is contacted.

Zukhruf checks before each model step, after mailbox input and context reminders.
It persists a checkpoint in conversation metadata before adopting the compacted
messages. The original UI transcript remains intact. Later turns and fresh hosts
reuse the checkpoint only when its source prefix still matches; a rewind or edit
that changes that prefix makes it inapplicable. Failed compaction stops the turn
without replacing history. Summarization usage is included in conversation usage.

### Lifecycle events

Zukhruf emits AI SDK `data-compaction` chunks on the turn stream. Their typed
payload, `CompactionEvent`, is exported from `@deepagents/experimental/zukhruf`.
Events with the same `id` belong to one evaluation:

| `data.status` | Meaning                                                    | Details                                                                   |
| ------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------- |
| `started`     | A trigger matched; compaction is being attempted           | Zero-based `triggerIndex`, `tokensBefore`, `targetTokens`, `messageCount` |
| `completed`   | The summary passed validation and its checkpoint was saved | `tokens.before/after`, `replacedRange`, summarization `usage`             |
| `failed`      | Evaluation, reduction, or checkpoint persistence failed    | `phase` and `reason`; the turn stops without adopting a new summary       |
| `restored`    | A compatible saved checkpoint was applied                  | `sourceMessages`, `replacementMessages`                                   |

New `started` and `completed` events include `tokenScope: "request"`; DevTool
labels their counts as estimated input tokens. Historical events without this
marker retain their message-estimate meaning.

For example, 41 short messages with total estimated input of 2,000 tokens match
`messagesExceed(40)` even with a 4,000-token target: `started` is followed by
`completed` when a valid summary fits and its checkpoint is saved. Safe
boundaries and output validation still apply: an empty or fully protected history
returns `cannot-fit`, as does an oversized summary. Unmatched triggers emit no
compaction attempt.

These are native persistent data parts. Each chunk ID combines its evaluation ID
and status, so replay preserves one saved part per status. AI SDK `onData` still
receives them; the normal UI transcript saves them for reopening. The SDK excludes
data parts from model input without a custom converter. DevTool groups matching
evaluation IDs into an expandable inline entry with token counts and checkpoint
details.
Data chunks flush promptly even while summarization is waiting. Cancellation
uses the existing durable turn status (`cancelled`); a started attempt without
a terminal event appears interrupted when its turn is no longer streaming.
No summary text or raw provider error is included in the lifecycle payload.

## Verification

```sh
npx nx run @deepagents/compaction:typecheck
npx nx run @deepagents/compaction:test
```

Integration tests use the public package export and AI SDK v7's V4 model fixtures.
They exercise budget outcomes, downstream SDK generation, provenance, repeated
compaction, trigger thresholds, protected tool/approval boundaries, media counters,
errors, and aborts. Zukhruf's integration tests additionally exercise either
trigger during tool loops, checkpoint replay, async decisions, and trigger errors.
