# MockLanguageModelV3 Patterns

All patterns below have been reconciled against `ai/test` source in `node_modules/ai/dist/test/index.mjs` and the `LanguageModelV3*` type definitions in `@ai-sdk/provider/dist/index.d.ts`. If something here disagrees with those, trust the source.

## Table of contents

1. [Usage fixture](#1-usage-fixture)
2. [Static `doGenerate`](#2-static-dogenerate)
3. [Inspecting the prompt](#3-inspecting-the-prompt)
4. [Throwing model (error paths)](#4-throwing-model-error-paths)
5. [Sequencing multiple responses](#5-sequencing-multiple-responses)
6. [Tool calls (non-streaming)](#6-tool-calls-non-streaming)
7. [Streaming basics](#7-streaming-basics)
8. [AI SDK error classes](#8-ai-sdk-error-classes)
9. [Structured output (`generateObject`)](#9-structured-output-generateobject)

---

## 1. Usage fixture

Every result shape needs a `usage` object conforming to `LanguageModelV3Usage`. Declare it once per test file:

```ts
const testUsage = {
  inputTokens: {
    total: 3,
    noCache: 3,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 10, text: 10, reasoning: undefined },
} as const;
```

`as const` matters: it narrows `undefined` to the exact literal instead of `number | undefined`, which avoids spurious type errors on the mock.

---

## 2. Static `doGenerate`

Smallest possible mock — the model always returns the same response. Good for happy-path assertions about downstream behaviour (parsing, formatting, storage).

```ts
import { MockLanguageModelV3 } from 'ai/test';

const model = new MockLanguageModelV3({
  doGenerate: {
    finishReason: { unified: 'stop', raw: undefined },
    usage: testUsage,
    content: [{ type: 'text', text: JSON.stringify({ answer: 'Paris' }) }],
    warnings: [],
  },
});
```

Why the `content: [{ type: 'text', text }]` wrapper: the V3 protocol treats content as an ordered list of tagged parts, so that a single reply can mix text + tool calls + reasoning. Even a plain text response needs the wrapper.

---

## 3. Inspecting the prompt

You do **not** need a custom capturing wrapper — the mock records every call on `model.doGenerateCalls` automatically. Each entry is the full `LanguageModelV3CallOptions`, including `prompt`, `tools`, `temperature`, `abortSignal`, `providerOptions`, etc.

```ts
const model = new MockLanguageModelV3({
  doGenerate: {
    finishReason: { unified: 'stop', raw: undefined },
    usage: testUsage,
    content: [{ type: 'text', text: 'ok' }],
    warnings: [],
  },
});

await generateText({ model, prompt: 'What is the capital of France?' });

const call = model.doGenerateCalls[0];
assert.deepStrictEqual(
  {
    mentionsCapital: JSON.stringify(call.prompt).includes('capital'),
    calls: model.doGenerateCalls.length,
  },
  { mentionsCapital: true, calls: 1 },
);
```

This skill uses `assert.deepStrictEqual` for every check, even scalar ones — a single structured comparison beats a stack of `strictEqual`/`ok` calls because the diff on failure shows the whole expected shape at once.

---

## 4. Throwing model (error paths)

Function form + `throw` gives you control over whether the error is sync or async, and lets you pick the AI SDK error type the code under test expects.

```ts
import { APICallError } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';

const model = new MockLanguageModelV3({
  doGenerate: async () => {
    throw new APICallError({
      message: 'Rate limit exceeded',
      url: 'https://api.example.com',
      requestBodyValues: {},
      isRetryable: true,
      statusCode: 429,
    });
  },
});
```

Why this over returning `{ type: 'error' }` content: errors from `doGenerate` propagate as exceptions from `generateText` — that's the contract retry/repair logic is built on. An `{ type: 'error' }` inside `content` is for reporting provider-side errors without aborting the call, which is a different code path.

---

## 5. Sequencing multiple responses

When the code under test makes several calls (e.g. tool-call → repair → final response, or retry logic), you need each call to return something different.

**Preferred — function form with `doGenerateCalls.length`:**

```ts
const model = new MockLanguageModelV3({
  doGenerate: async () => {
    const n = model.doGenerateCalls.length; // 1 for first call, 2 for second, ...
    if (n === 1) {
      throw new APICallError({
        message: 'transient',
        url: 'x',
        requestBodyValues: {},
        isRetryable: true,
      });
    }
    return {
      finishReason: { unified: 'stop', raw: undefined },
      usage: testUsage,
      content: [{ type: 'text', text: 'succeeded on retry' }],
      warnings: [],
    };
  },
});
```

Why this is the preferred pattern: it's explicit, reads top-to-bottom like the scenario it describes, and keeps the counter in one place so you can assert on it at the end (`model.doGenerateCalls.length === 2`).

**Array form — use with care:**

```ts
const model = new MockLanguageModelV3({
  doGenerate: [
    undefined as any, // element 0 is NEVER returned — see gotcha
    firstResult,
    secondResult,
  ],
});
```

The runtime code does `calls.push(options); return array[calls.length]`, so on the first call it returns `array[1]`. Always pad the 0th slot. In practice, the function form avoids this entire class of confusion.

---

## 6. Tool calls (non-streaming)

Return a `tool-call` content part and set `finishReason.unified: 'tool-calls'`. The AI SDK will dispatch to your registered tool and include the tool-result in the next step — use `stopWhen: stepCountIs(1)` to short-circuit after the dispatch so your test asserts on the intermediate state.

```ts
import { generateText, stepCountIs, tool } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { z } from 'zod';

const model = new MockLanguageModelV3({
  doGenerate: {
    finishReason: { unified: 'tool-calls', raw: undefined },
    usage: testUsage,
    warnings: [],
    content: [
      {
        type: 'tool-call',
        toolCallId: 'call-1',
        toolName: 'search',
        input: JSON.stringify({ query: 'weather' }),
      },
    ],
  },
});

const result = await generateText({
  model,
  prompt: 'What is the weather?',
  stopWhen: stepCountIs(1),
  tools: {
    search: tool({
      inputSchema: z.object({ query: z.string() }),
      execute: async ({ query }) => `results for ${query}`,
    }),
  },
});

const toolResult = result.content.find(
  (p) => p.type === 'tool-result' && p.toolName === 'search',
);
assert.deepStrictEqual(
  { dispatched: Boolean(toolResult), toolName: toolResult?.toolName },
  { dispatched: true, toolName: 'search' },
);
```

Note: the `input` field is always a **stringified** JSON (per the V3 spec), even though you might be tempted to pass an object. The SDK parses it against your `inputSchema`.

---

## 7. Streaming basics

For any code that calls `streamText`, provide `doStream`. See [stream-chunks.md](stream-chunks.md) for the full chunk catalog; the minimal "say text and finish" looks like:

```ts
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';

const model = new MockLanguageModelV3({
  doStream: async () => ({
    stream: simulateReadableStream({
      chunks: [
        { type: 'text-start', id: 't1' },
        { type: 'text-delta', id: 't1', delta: 'Hello ' },
        { type: 'text-delta', id: 't1', delta: 'world' },
        { type: 'text-end', id: 't1' },
        {
          type: 'finish',
          finishReason: { unified: 'stop', raw: undefined },
          usage: testUsage,
        },
      ],
    }),
  }),
});
```

To consume the stream in your test without depending on SDK-specific iterators:

```ts
async function drain(stream: ReadableStream) {
  const reader = stream.getReader();
  while (true) {
    const { done } = await reader.read();
    if (done) break;
  }
}
```

If the code under test calls `streamText({ experimental_transform: smoothStream() })` or similar, pass `transform: () => new TransformStream()` when invoking it in the test. `smoothStream`'s internal timing assumes a real event loop and hangs under synthetic schedulers.

---

## 8. AI SDK error classes

All importable from `'ai'` (not `ai/test`). Use `ErrorClass.isInstance(err)` in assertions — it survives realm and dual-bundle boundaries where `instanceof` would fail.

```ts
import {
  APICallError,
  JSONParseError,
  NoContentGeneratedError,
  NoObjectGeneratedError,
  NoOutputGeneratedError,
  TypeValidationError,
} from 'ai';

new APICallError({
  message: 'Rate limit exceeded',
  url: 'https://api.example.com',
  requestBodyValues: {},
  isRetryable: true,
  statusCode: 429, // optional
  responseBody: '...', // optional
});

new JSONParseError({
  text: '{ bad json',
  cause: new SyntaxError('Unexpected token'),
});

new TypeValidationError({
  value: { invalid: true },
  cause: new Error('Expected string, got number'),
});

new NoObjectGeneratedError({
  response: { id: 'r1', timestamp: new Date(), modelId: 'test' },
  usage: { inputTokens: 10, outputTokens: 0, totalTokens: 10 },
  finishReason: 'error',
});

new NoOutputGeneratedError(); // no-arg
new NoContentGeneratedError(); // no-arg
```

All of these extend `Error`, so `err instanceof Error` is still `true` — but for precise type matching, use `isInstance`:

```ts
assert.deepStrictEqual(APICallError.isInstance(err), true);
```

---

## 9. Structured output (`generateObject`)

`generateObject` expects the model to return a single text content part whose text is valid JSON matching the provided schema. Return it exactly like a text response:

```ts
const model = new MockLanguageModelV3({
  doGenerate: {
    finishReason: { unified: 'stop', raw: undefined },
    usage: testUsage,
    content: [{ type: 'text', text: JSON.stringify({ name: 'Ada', age: 36 }) }],
    warnings: [],
  },
});

const result = await generateObject({
  model,
  schema: z.object({ name: z.string(), age: z.number() }),
  prompt: 'Tell me about Ada.',
});

assert.deepStrictEqual(result.object, { name: 'Ada', age: 36 });
```

To test schema repair / retry, combine with the sequencing pattern (section 5): first call returns malformed JSON → SDK throws `JSONParseError` → code under test retries → second call returns valid JSON.
