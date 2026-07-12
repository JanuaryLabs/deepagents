# AI SDK v7 integration-test recipes

These recipes assume the typed `usage` and `textResult` fixtures from [mock-patterns.md](mock-patterns.md).

## Retry then succeed

```ts
import { APICallError, generateText } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';

const model = new MockLanguageModelV4({
  doGenerate: async () => {
    if (model.doGenerateCalls.length === 1) {
      throw new APICallError({
        message: 'overloaded',
        url: 'https://example.test',
        requestBodyValues: {},
        statusCode: 529,
        isRetryable: true,
      });
    }
    return textResult('finally');
  },
});

const result = await askWithRetry(model, 'try me');
assert.deepStrictEqual(
  { text: result.text, calls: model.doGenerateCalls.length },
  { text: 'finally', calls: 2 },
);
```

## Two model steps without a manual counter

```ts
import { MockLanguageModelV4, mockValues } from 'ai/test';

const model = new MockLanguageModelV4({
  doGenerate: mockValues(toolCallResult, textResult('Order shipped.')),
});
```

Use this for tool-call then final-answer flows. Use the constructor's array form when repeating the last result after exhaustion would hide an unexpected extra call.

For a complete multi-step tool flow, let `generateText` feed the tool result into the second model call:

```ts
const model = new MockLanguageModelV4({
  doGenerate: [toolCallResult, textResult('Order shipped.')],
});

const result = await generateText({
  model,
  prompt: 'Where is order 42?',
  stopWhen: stepCountIs(2),
  tools: {
    lookup: tool({
      inputSchema: z.object({ id: z.number() }),
      execute: async ({ id }) => ({ id, status: 'shipped' }),
    }),
  },
});

assert.deepStrictEqual(
  { text: result.text, calls: model.doGenerateCalls.length },
  { text: 'Order shipped.', calls: 2 },
);
```

Inspect `model.doGenerateCalls[1].prompt` when the invariant is that the tool result reached the second step.

## Stream text immediately

```ts
import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { simulateReadableStream, streamText } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';

const chunks = [
  { type: 'text-start', id: 'text-1' },
  { type: 'text-delta', id: 'text-1', delta: 'hello' },
  { type: 'text-end', id: 'text-1' },
  {
    type: 'finish',
    finishReason: { unified: 'stop', raw: 'stop' },
    usage,
  },
] satisfies LanguageModelV4StreamPart[];

const model = new MockLanguageModelV4({
  doStream: {
    stream: simulateReadableStream({
      chunks,
      initialDelayInMs: null,
      chunkDelayInMs: null,
    }),
  },
});

const result = streamText({ model, prompt: 'say hello' });
assert.deepStrictEqual(await result.text, 'hello');
```

## Assert the rendered prompt

```ts
await callMyAgent({ model, userName: 'Ada', task: 'summarize' });

const [{ prompt }] = model.doGenerateCalls;
const system = prompt.find((message) => message.role === 'system');
assert.deepStrictEqual(
  {
    containsName: system?.content.includes('Ada') ?? false,
    containsTask: system?.content.includes('summarize') ?? false,
  },
  { containsName: true, containsTask: true },
);
```

## Structured output

AI SDK v7 deprecates `generateObject`; use `generateText` with `Output.object`:

```ts
import { Output, generateText } from 'ai';
import { z } from 'zod';

const model = new MockLanguageModelV4({
  doGenerate: textResult(JSON.stringify({ name: 'Ada', age: 36 })),
});

const result = await generateText({
  model,
  prompt: 'Describe Ada',
  output: Output.object({
    schema: z.object({ name: z.string(), age: z.number() }),
  }),
});

assert.deepStrictEqual(result.output, { name: 'Ada', age: 36 });
```

Sequence malformed then valid JSON when the application owns repair; do not mock the parser or schema validator separately.

## Tool dispatch

```ts
import { generateText, stepCountIs, tool } from 'ai';
import { z } from 'zod';

const searchCalls: string[] = [];
const model = new MockLanguageModelV4({ doGenerate: toolCallResult });

const result = await generateText({
  model,
  prompt: 'What is the weather?',
  stopWhen: stepCountIs(1),
  tools: {
    search: tool({
      inputSchema: z.object({ query: z.string() }),
      execute: async ({ query }) => {
        searchCalls.push(query);
        return { temperature: 22 };
      },
    }),
  },
});

assert.deepStrictEqual(
  { searchCalls, toolResults: result.toolResults.length },
  { searchCalls: ['weather'], toolResults: 1 },
);
```

## Reasoning and text channels

Stream a `reasoning-start`/`reasoning-delta`/`reasoning-end` group followed by a text group and `finish`. Assert `(await result.finalStep).reasoningText` separately from `await result.text`; the top-level `reasoningText` alias is deprecated in v7. Type the chunks with `satisfies LanguageModelV4StreamPart[]`.

## Timing, aborts, and transforms

- Assert forwarded signals from `model.doGenerateCalls[0].abortSignal` or `doStreamCalls[0].abortSignal`:

  ```ts
  const controller = new AbortController();
  const result = streamText({
    model,
    prompt: 'hello',
    abortSignal: controller.signal,
  });
  await result.consumeStream();

  assert.deepStrictEqual(model.doStreamCalls[0].abortSignal, controller.signal);
  ```

- Use numeric `simulateReadableStream` delays only for timeout/abort behavior.
- Use `null` delays for ordinary deterministic tests.
- If a production transform is the behavior under test, keep it. If the caller supports injecting transforms, inject an identity `TransformStream` only when testing surrounding behavior rather than the transform itself.
