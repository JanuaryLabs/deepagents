---
name: agent-testing
description: Mocks for the Vercel AI SDK (`ai`/`ai/test`) are easy to hand-roll wrong — the V3 chunk protocol silently swallows `textDelta` instead of `delta`, bare-string finish reasons, flat usage shapes, and obsolete `rawCall` fields. Use this skill whenever the user is writing, fixing, or adding coverage for any test that imports from `ai`, `ai/test`, or calls `generateText`, `streamText`, `generateObject`, `streamObject`, `MockLanguageModelV3`, or `simulateReadableStream` — including loose phrasings like "test my agent", "mock the model", "fake the stream", "simulate a tool call", "test retry logic", "test the system prompt", "my streaming test hangs", or "empty result.text". Trigger even when the user doesn't name the SDK — if the file or code under test uses it, the skill applies. Erring toward invoking is correct because the mock-fixture shape is the single biggest source of bugs in these tests.
---

# Testing Vercel AI SDK code with `ai/test`

## Why a skill for this

The mocks in `ai/test` look simple but have sharp edges: V3 stream chunks require exact shapes, finish-reason objects have a specific structure, and the AI SDK silently does nothing when you pass a V2-looking chunk (`textDelta` instead of `delta`). Getting the fixtures right first time means tests pass on the first run instead of producing empty outputs you then debug.

The source of truth is `ai/test` itself — specifically `MockLanguageModelV3` and the `LanguageModelV3*` types in `@ai-sdk/provider`. When anything in this skill seems to disagree with those, trust the source.

## Setup

- **Runner**: `node --test path/to/file.test.ts` (Node's built-in runner, no framework)
- **Assertions**: `import assert from 'node:assert'`
- **Mocks**: `import { MockLanguageModelV3 } from 'ai/test'`
- **Streams**: `import { simulateReadableStream } from 'ai'`
- **Imports under test**: use the package specifier (`@deepagents/text2sql`), not a relative source path. Mixing built-package and source-file imports creates two incompatible copies of the same class because private fields (`#field`) are nominal per declaration.

## The 30-second mental model

`MockLanguageModelV3` gives you two hooks: `doGenerate` (non-streaming) and `doStream` (streaming). Each accepts three shapes:

| Shape                             | When to use                                                                       |
| --------------------------------- | --------------------------------------------------------------------------------- |
| Plain object                      | Single fixed response. Use for the common "model returns X" test.                 |
| `async (options) => ...` function | You need to inspect `options`, branch on call count, or throw.                    |
| Array of objects                  | Sequential responses across calls (but prefer the function form — see gotcha #7). |

Every call to the mock is captured in `model.doGenerateCalls` / `model.doStreamCalls`. You almost never need to write your own "capturing" wrapper — the arrays already have the full `LanguageModelV3CallOptions` (prompt, settings, abort signal, tools…) for each call.

## Canonical example: non-streaming text response

Copy this as the default starting point. It exercises the three most-gotten-wrong fields: `finishReason` (object, not string), `usage` (nested shape), and `content` (array of tagged parts).

```ts
import { generateText } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import assert from 'node:assert';
import { test } from 'node:test';

const testUsage = {
  inputTokens: {
    total: 3,
    noCache: 3,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 10, text: 10, reasoning: undefined },
} as const;

test('summarizes to a single sentence', async () => {
  const model = new MockLanguageModelV3({
    doGenerate: {
      finishReason: { unified: 'stop', raw: undefined },
      usage: testUsage,
      content: [{ type: 'text', text: 'A short summary.' }],
      warnings: [],
    },
  });

  const result = await generateText({ model, prompt: 'Summarize X' });

  assert.deepStrictEqual(
    { text: result.text, calls: model.doGenerateCalls.length },
    { text: 'A short summary.', calls: 1 },
  );
});
```

Assertion style: this skill uses `assert.deepStrictEqual` for every check, even one-field ones. Collapse multiple `strictEqual`/`ok` calls into a single structured comparison — failure messages are more informative (full object diff) and the intent of the test reads as one expected shape rather than a series of scalars.

## Decision rules

1. **Need to assert on the prompt or settings?** Don't wrap the mock — read `model.doGenerateCalls[i].prompt` after the call.
2. **Testing `streamText()`?** You must provide `doStream` — `doGenerate` is not auto-simulated as a stream. See [references/stream-chunks.md](references/stream-chunks.md) for the chunk protocol.
3. **Using `smoothStream()` in your code under test?** Pass `transform: () => new TransformStream()` to the call under test to bypass smoothing, which hangs under the synthetic scheduler. The skill's [gotchas section](#gotchas) explains why.
4. **Simulating retries / error paths?** Throw from the function-form `doGenerate`, or include error chunks in `doStream`. Import error classes from `'ai'` (not from `ai/test`). See [references/mock-patterns.md#errors](references/mock-patterns.md).
5. **Tool calls?** Return a `tool-call` content part with `finishReason.unified: 'tool-calls'`. Combine with `stopWhen: stepCountIs(1)` to stop before the model would be invoked again.

## Gotchas (ranked by how often they bite)

1. **`delta`, not `textDelta`.** V3 stream chunks use `delta: string`. `textDelta` is V2 and produces empty output silently.
2. **Text chunks need `id`.** `text-start` / `text-delta` / `text-end` all carry the same `id`, and they must come in that order.
3. **`finishReason` is an object**: `{ unified: 'stop' | 'length' | 'tool-calls' | 'error' | 'content-filter' | 'other', raw: string | undefined }`. A bare string silently breaks downstream consumers.
4. **`rawCall` is NOT part of `LanguageModelV3StreamResult`.** Older docs and existing repo code include `rawCall: { rawPrompt, rawSettings }` — it's legacy noise. Return just `{ stream }` (plus optional `request`/`response`).
5. **`doGenerate` and `doStream` are independent.** Code that calls `streamText()` won't exercise your `doGenerate` mock — provide `doStream` instead. Conversely, if the code under test only calls `generateText()`/`generateObject()`, defining `doStream` is dead weight and a code-review smell.
6. **`smoothStream()` hangs in tests.** Its default delay uses `setTimeout` with a non-deterministic scheduler. Bypass with `transform: () => new TransformStream()` on the call under test.
7. **Array form of `doGenerate` is effectively 1-indexed.** The mock pushes the call _then_ reads `array[calls.length]`, so `doGenerate[0]` is never returned. Prefer the function form with explicit `doGenerateCalls.length` indexing, or pad the array.
8. **`totalUsage` uses `inputTokens` / `outputTokens` / `totalTokens`.** The old `promptTokens` / `completionTokens` names no longer exist on the top-level result.
9. **Prefer `ErrorClass.isInstance(err)` over `instanceof`.** All AI SDK error classes expose a symbol-marker `isInstance` that survives dual-bundle situations; `instanceof` can fail across realm / build boundaries.
10. **Build packages before running tests that import them.** `node --test` resolves `@scope/pkg` via `package.json#exports`, which usually points into `dist/`.

## Bundled resources

- [references/mock-patterns.md](references/mock-patterns.md) — Full pattern catalog: static response, throwing model, call-count sequencing, tool calls, multi-response with the function form, error class constructors, structured output.
- [references/stream-chunks.md](references/stream-chunks.md) — Every `LanguageModelV3StreamPart` variant: text, reasoning, tool-input streaming, tool-call, tool-result, source, file, stream-start, response-metadata, finish, error, raw. Copy-paste chunk snippets.
- [references/recipes.md](references/recipes.md) — Seven end-to-end scenarios (retry, tool dispatch, streaming abort, schema repair, multi-step tool chain, reasoning, prompt assertions). Each recipe is copy-paste-ready and names the invariant it proves.
- [assets/test-template.ts](assets/test-template.ts) — Minimum viable test skeleton. Copy when starting a new `.test.ts` file — it has the usage fixture, the static `doGenerate`, and one prompt-inspection assertion wired up so you're not reinventing boilerplate.
- [scripts/validate-chunks.mjs](scripts/validate-chunks.mjs) — Stream-chunk linter. Validates the V3 protocol (ordering, required fields, finish reason shape, V2 leftovers like `textDelta`). When a streaming test produces unexpected empty output, extract the chunks and pipe them through the linter:
  ```sh
  node .claude/skills/agent-testing/scripts/validate-chunks.mjs chunks.json
  # or from stdin:
  echo '[...]' | node .claude/skills/agent-testing/scripts/validate-chunks.mjs -
  ```
  Exits 0 if clean, 1 with one diagnostic per problem. Useful both as a debugging tool and as a way to test-first the fixture before wiring it into a real test.
