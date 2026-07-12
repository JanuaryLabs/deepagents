---
name: agent-testing
description: Test code built on AI SDK v7 using its real `ai/test` utilities and V4 provider protocol. Use whenever writing, fixing, reviewing, or migrating tests around AI SDK agents, `generateText`, `streamText`, structured output, tools, embeddings, image/speech/transcription/reranking/video models, provider registries, or simulated streams. Trigger for phrases such as "test my agent", "mock the model", "fake the stream", "simulate a tool call", "test retry logic", "inspect the system prompt", "my streaming test hangs", or "empty result.text", even when the user does not explicitly name AI SDK. This skill is v7-only: remove V3 fixtures and custom helpers that duplicate `ai/test`.
---

# Test AI SDK v7 agents

Use AI SDK v7's public test surface as the source of truth. Inspect the installed `ai/test` exports and `@ai-sdk/provider` V4 types before inventing fixtures; v7 changes can make plausible older examples silently wrong.

## Repository test contract

- Reproduce a bug live against the real API before writing the regression test.
- Prefer integration tests that exercise the complete agent flow.
- Run tests with `nx run <project>:test`; use `node --test --no-warnings path/to/file.test.ts` only for the narrow reproduction or filtered test.
- Run type checks with `nx run <project>:typecheck`, never raw `tsc`.
- Import the package under test by its package specifier, not a relative source path.
- Use `node:assert` and group related observations in `assert.deepStrictEqual` when that makes the failure easier to read.

## v7-only rules

1. Use V4 mocks (`MockLanguageModelV4`, `MockEmbeddingModelV4`, and the other `*V4` classes). Do not preserve V3 compatibility.
2. Import test models and helpers from `ai/test`. Import `simulateReadableStream` from `ai`; its `ai/test` re-export is deprecated.
3. Use the built-ins instead of local substitutes:
   - sequential return values: `mockValues(...)`
   - deterministic IDs: `mockId({ prefix })`
   - stream collection: `convertReadableStreamToArray(stream)`
   - stream construction: `convertArrayToReadableStream(values)` or `simulateReadableStream(...)`
   - async iterable construction: `convertArrayToAsyncIterable(values)`
   - language prompt/settings capture: `model.doGenerateCalls` and `model.doStreamCalls`
   - embedding call capture: `model.doEmbedCalls`
4. `MockLanguageModelV4` accepts a function, one result, or an array of results for `doGenerate` and `doStream`. Arrays are zero-indexed and return item 0 on the first call.
   A fixed `doStream` result contains one `ReadableStream` and is therefore single-use. Use function form to construct a fresh stream when the same mock can be called more than once, or provide an array containing a distinct stream per expected call.
5. Do not add `rawCall`; it is not part of `LanguageModelV4StreamResult`.
6. Do not cast fixtures to `any` or `never` to hide protocol errors. Use `satisfies LanguageModelV4GenerateResult`, `LanguageModelV4StreamResult`, or `LanguageModelV4StreamPart[]` so drift fails at compile time.

## Default language-model fixture

```ts
import type { LanguageModelV4GenerateResult } from '@ai-sdk/provider';
import { generateText } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import assert from 'node:assert';
import { test } from 'node:test';

const usage = {
  inputTokens: { total: 3, noCache: 3, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 4, text: 4, reasoning: 0 },
} as const;

const response = {
  content: [{ type: 'text', text: 'A short summary.' }],
  finishReason: { unified: 'stop', raw: 'stop' },
  usage,
  warnings: [],
} satisfies LanguageModelV4GenerateResult;

test('returns the generated summary', async () => {
  const model = new MockLanguageModelV4({ doGenerate: response });
  const result = await generateText({ model, prompt: 'Summarize X' });

  assert.deepStrictEqual(
    { text: result.text, calls: model.doGenerateCalls.length },
    { text: 'A short summary.', calls: 1 },
  );
});
```

## Choose the smallest built-in

| Need                           | Use                                                                                     |
| ------------------------------ | --------------------------------------------------------------------------------------- |
| Fixed generation               | `new MockLanguageModelV4({ doGenerate: result })`                                       |
| Ordered generations            | `doGenerate: [first, second]` or `doGenerate: mockValues(first, second)`                |
| Inspect/branch on call options | function-form `doGenerate(options)` plus captured call arrays                           |
| Streaming                      | `doStream` + `simulateReadableStream({ chunks, ...delays })`                            |
| Collect a raw stream           | `convertReadableStreamToArray`                                                          |
| Deterministic generated IDs    | pass `generateId: mockId({ prefix: 'test' })` where the public API accepts `generateId` |
| Test a provider registry       | `MockProviderV4` with named V4 models                                                   |
| Non-language modality          | the matching V4 mock from the catalog below                                             |

Do not wrap language or embedding mocks merely to record options or maintain a call counter; they already capture calls. The other V4 model mocks expose their operation directly without call arrays, so use Node's `mock.fn(...)` when the test must inspect those calls. Function-form language-model behavior may inspect `model.doGenerateCalls.length`; `mockValues` is better when only the return value changes.

## Streaming protocol essentials

- Text and reasoning use `*-start`, zero or more `*-delta`, then `*-end`, sharing one `id`.
- Delta payloads use `delta`, never `textDelta`.
- Tool arguments are stringified JSON in the final `tool-call.input`.
- A stream ends with `finish`, whose `finishReason` is `{ unified, raw }` and whose `usage` has the V4 nested token shape.
- Return `{ stream }` from `doStream`; add only typed `request` or `response` metadata when the test observes it.
- Use `initialDelayInMs: null` and `chunkDelayInMs: null` for immediate deterministic delivery; use numeric delays only when timing is the behavior under test.

See [references/stream-chunks.md](references/stream-chunks.md) for typed V4 chunks and [references/recipes.md](references/recipes.md) for full flows.

Use TypeScript's `satisfies LanguageModelV4StreamPart[]` for compile-time field validation. When debugging chunks extracted as JSON, use [scripts/validate-chunks.mjs](scripts/validate-chunks.mjs) for lifecycle and ordering checks that the SDK silently ignores. Keep this script: v7 has stream construction and collection helpers, but no public semantic chunk validator.

## Complete `ai/test` v7 catalog

Read [references/test-api.md](references/test-api.md) when the task is not a basic language-model test. It covers:

- `MockLanguageModelV4`, `MockEmbeddingModelV4`, `MockImageModelV4`
- `MockSpeechModelV4`, `MockTranscriptionModelV4`, `MockRerankingModelV4`, `MockVideoModelV4`
- `MockProviderV4`
- `mockValues`, `mockId`
- `convertArrayToAsyncIterable`, `convertArrayToReadableStream`, `convertReadableStreamToArray`
- `simulateReadableStream` from `ai`

## Other references

- [references/mock-patterns.md](references/mock-patterns.md): fixed, sequential, throwing, tool-call, streaming, and provider patterns.
- [references/stream-chunks.md](references/stream-chunks.md): V4 stream part shapes and ordering.
- [references/recipes.md](references/recipes.md): end-to-end retry, tool, structured-output, and stream examples.
- [assets/test-template.ts](assets/test-template.ts): minimal typed V4 integration-test template.
- [scripts/validate-chunks.mjs](scripts/validate-chunks.mjs): V4 JSON chunk lifecycle validator for ordering and matching IDs; use only where static typing cannot help.

When installed types disagree with these files, update the skill to match the installed package rather than adding a compatibility shim.
