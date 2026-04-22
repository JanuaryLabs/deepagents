# End-to-end test recipes

Copy-paste-ready scenarios that combine primitives from [mock-patterns.md](mock-patterns.md) and [stream-chunks.md](stream-chunks.md). Each recipe names what it's asserting and points to the pattern it draws from.

## Recipe 1 — Retry on transient error, succeed on second attempt

**What it proves**: your retry wrapper catches retryable SDK errors and calls the model again.

```ts
import { generateText } from 'ai';
import { APICallError } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import assert from 'node:assert';
import { test } from 'node:test';

test('retries once on retryable APICallError', async () => {
  const model = new MockLanguageModelV3({
    doGenerate: async () => {
      if (model.doGenerateCalls.length === 1) {
        throw new APICallError({
          message: 'overloaded',
          url: 'x',
          requestBodyValues: {},
          isRetryable: true,
          statusCode: 529,
        });
      }
      return {
        finishReason: { unified: 'stop', raw: undefined },
        usage: testUsage,
        content: [{ type: 'text', text: 'finally' }],
        warnings: [],
      };
    },
  });

  const result = await withRetry(() =>
    generateText({ model, prompt: 'try me' }),
  );

  assert.deepStrictEqual(
    { text: result.text, calls: model.doGenerateCalls.length },
    { text: 'finally', calls: 2 },
  );
});
```

Pattern: sequencing via `doGenerateCalls.length` (mock-patterns §5).

---

## Recipe 2 — Tool dispatch with `stopWhen(stepCountIs(1))`

**What it proves**: your tool gets called with the parsed args and its result lands in `result.content`.

```ts
import { generateText, stepCountIs, tool } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { z } from 'zod';

const searchCalls: string[] = [];

const model = new MockLanguageModelV3({
  doGenerate: {
    finishReason: { unified: 'tool-calls', raw: undefined },
    usage: testUsage,
    warnings: [],
    content: [
      {
        type: 'tool-call',
        toolCallId: 'c1',
        toolName: 'search',
        input: JSON.stringify({ query: 'weather' }),
      },
    ],
  },
});

const result = await generateText({
  model,
  prompt: 'what is the weather?',
  stopWhen: stepCountIs(1),
  tools: {
    search: tool({
      inputSchema: z.object({ query: z.string() }),
      execute: async ({ query }) => {
        searchCalls.push(query);
        return { temp: 72 };
      },
    }),
  },
});

assert.deepStrictEqual(
  {
    searchCalls,
    dispatched: result.content.some(
      (p) => p.type === 'tool-result' && p.toolName === 'search',
    ),
  },
  { searchCalls: ['weather'], dispatched: true },
);
```

Pattern: tool calls non-streaming (mock-patterns §6).

---

## Recipe 3 — Streaming text with abort

**What it proves**: your code forwards the caller's `AbortSignal` to the model, and the stream ends cleanly.

```ts
import { streamText } from 'ai';
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';

const model = new MockLanguageModelV3({
  doStream: async ({ abortSignal }) => {
    assert.deepStrictEqual(abortSignal instanceof AbortSignal, true);
    return {
      stream: simulateReadableStream({
        chunks: [
          { type: 'text-start', id: 't1' },
          { type: 'text-delta', id: 't1', delta: 'hi' },
          { type: 'text-end', id: 't1' },
          {
            type: 'finish',
            finishReason: { unified: 'stop', raw: undefined },
            usage: testUsage,
          },
        ],
      }),
    };
  },
});

const controller = new AbortController();
const result = streamText({
  model,
  prompt: 'hi',
  abortSignal: controller.signal,
  experimental_transform: () => new TransformStream(), // bypass smoothStream
});

await result.consumeStream();
assert.deepStrictEqual(await result.text, 'hi');
```

Pattern: streaming basics (mock-patterns §7), stream-chunks.md text section.

---

## Recipe 4 — Structured output with schema repair

**What it proves**: your code handles `NoObjectGeneratedError` by retrying with feedback.

```ts
import { JSONParseError, NoObjectGeneratedError, generateObject } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { z } from 'zod';

const model = new MockLanguageModelV3({
  doGenerate: async () => {
    if (model.doGenerateCalls.length === 1) {
      return {
        finishReason: { unified: 'stop', raw: undefined },
        usage: testUsage,
        content: [{ type: 'text', text: '{ "name": "Ada", age: ' }], // malformed
        warnings: [],
      };
    }
    return {
      finishReason: { unified: 'stop', raw: undefined },
      usage: testUsage,
      content: [
        { type: 'text', text: JSON.stringify({ name: 'Ada', age: 36 }) },
      ],
      warnings: [],
    };
  },
});

const result = await generateWithRepair({
  model,
  schema: z.object({ name: z.string(), age: z.number() }),
  prompt: 'tell me about ada',
});

assert.deepStrictEqual(
  { object: result.object, calls: model.doGenerateCalls.length },
  { object: { name: 'Ada', age: 36 }, calls: 2 },
);
```

Pattern: sequencing + structured output (mock-patterns §5, §9).

---

## Recipe 5 — Multi-step tool chain

**What it proves**: the model can call a tool, receive its result, and respond with final text.

```ts
const model = new MockLanguageModelV3({
  doGenerate: async () => {
    if (model.doGenerateCalls.length === 1) {
      return {
        finishReason: { unified: 'tool-calls', raw: undefined },
        usage: testUsage,
        warnings: [],
        content: [
          {
            type: 'tool-call',
            toolCallId: 'c1',
            toolName: 'lookup',
            input: JSON.stringify({ id: 42 }),
          },
        ],
      };
    }
    return {
      finishReason: { unified: 'stop', raw: undefined },
      usage: testUsage,
      warnings: [],
      content: [{ type: 'text', text: 'Order 42 shipped 2024-01-01.' }],
    };
  },
});

const result = await generateText({
  model,
  prompt: 'where is order 42?',
  stopWhen: stepCountIs(5),
  tools: {
    lookup: tool({
      inputSchema: z.object({ id: z.number() }),
      execute: async ({ id }) => ({
        id,
        status: 'shipped',
        date: '2024-01-01',
      }),
    }),
  },
});

assert.deepStrictEqual(
  {
    mentionsShipped: result.text.includes('shipped'),
    calls: model.doGenerateCalls.length,
  },
  { mentionsShipped: true, calls: 2 },
);
```

In the second call, inspect `model.doGenerateCalls[1].prompt` to verify the tool result was included in the conversation handed back to the model — this is the specific invariant multi-step chains depend on.

---

## Recipe 6 — Streaming with reasoning channel

**What it proves**: your consumer reads `result.reasoning` separately from `result.text`.

```ts
const model = new MockLanguageModelV3({
  doStream: async () => ({
    stream: simulateReadableStream({
      chunks: [
        { type: 'reasoning-start', id: 'r1' },
        {
          type: 'reasoning-delta',
          id: 'r1',
          delta: 'The user asked about X. ',
        },
        { type: 'reasoning-delta', id: 'r1', delta: 'I should look up Y.' },
        { type: 'reasoning-end', id: 'r1' },

        { type: 'text-start', id: 't1' },
        { type: 'text-delta', id: 't1', delta: 'The answer is 42.' },
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

Pattern: reasoning stream (stream-chunks.md reasoning section).

---

## Recipe 7 — Asserting exact prompt content

**What it proves**: your system prompt template renders correctly under inputs.

```ts
const model = new MockLanguageModelV3({
  doGenerate: {
    finishReason: { unified: 'stop', raw: undefined },
    usage: testUsage,
    content: [{ type: 'text', text: 'ok' }],
    warnings: [],
  },
});

await callMyAgent({ model, userName: 'Ada', task: 'summarize X' });

const prompt = model.doGenerateCalls[0].prompt;
// prompt is an array of messages; system message is typically first
const system = prompt.find((m) => m.role === 'system');
assert.deepStrictEqual(
  {
    greetsUser: system?.content.includes('Ada') ?? false,
    describesTask: system?.content.includes('summarize') ?? false,
  },
  { greetsUser: true, describesTask: true },
);
```

Pattern: prompt inspection via built-in capture (mock-patterns §3).
