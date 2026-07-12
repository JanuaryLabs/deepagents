# AI SDK v7 mock patterns

All examples target the V4 provider protocol.

## Shared typed fixtures

```ts
import type {
  LanguageModelV4GenerateResult,
  LanguageModelV4StreamPart,
} from '@ai-sdk/provider';

const usage = {
  inputTokens: { total: 3, noCache: 3, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 4, text: 4, reasoning: 0 },
} as const;

const textResult = (text: string) =>
  ({
    content: [{ type: 'text', text }],
    finishReason: { unified: 'stop', raw: 'stop' },
    usage,
    warnings: [],
  }) satisfies LanguageModelV4GenerateResult;
```

## Fixed and sequential results

Use the constructor's built-in fixed and array forms:

```ts
import { MockLanguageModelV4 } from 'ai/test';

const fixed = new MockLanguageModelV4({ doGenerate: textResult('ok') });
const sequence = new MockLanguageModelV4({
  doGenerate: [textResult('first'), textResult('second')],
});
```

The array is zero-indexed. The first call returns element 0.

`mockValues` expresses the same sequence and repeats its final value if calls continue:

```ts
import { MockLanguageModelV4, mockValues } from 'ai/test';

const model = new MockLanguageModelV4({
  doGenerate: mockValues(textResult('first'), textResult('second')),
});
```

## Throwing and option-dependent behavior

Use function form only when behavior must throw, inspect options, or branch on captured state:

```ts
import { APICallError } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';

const model = new MockLanguageModelV4({
  doGenerate: async (options) => {
    if (model.doGenerateCalls.length === 1) {
      throw new APICallError({
        message: 'rate limited',
        url: 'https://example.test',
        requestBodyValues: {},
        statusCode: 429,
        isRetryable: true,
      });
    }
    return textResult(JSON.stringify({ ok: true }));
  },
});
```

The mock records the options before invoking the function, so `doGenerateCalls.length` is 1 during the first call. Assert prompts, tools, provider options, and abort signals from `doGenerateCalls`/`doStreamCalls`; do not build a capturing wrapper.

## Non-streaming tool call

```ts
const toolCall = {
  content: [
    {
      type: 'tool-call',
      toolCallId: 'call-1',
      toolName: 'search',
      input: JSON.stringify({ query: 'weather' }),
    },
  ],
  finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
  usage,
  warnings: [],
} satisfies LanguageModelV4GenerateResult;
```

Keep `input` stringified. Let `generateText` parse and validate it against the tool schema.

## Streaming and collection

`ReadableStream` instances are single-consumption. A fixed `doStream: { stream }` result is valid only for a model that will be called once. Reusable models need function form so every call constructs a new stream; fixed multi-step scenarios need an array with a distinct stream in every result.

```ts
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV4, convertReadableStreamToArray } from 'ai/test';

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
  doStream: async () => ({
    stream: simulateReadableStream({
      chunks,
      initialDelayInMs: null,
      chunkDelayInMs: null,
    }),
  }),
});

const observed = await convertReadableStreamToArray(
  simulateReadableStream({
    chunks,
    initialDelayInMs: null,
    chunkDelayInMs: null,
  }),
);
```

In real integration tests, consume the public `streamText` result. Use `convertReadableStreamToArray` when the object under test exposes a raw `ReadableStream`; do not write a local drain loop.

## Deterministic IDs

```ts
import { mockId } from 'ai/test';

const generateId = mockId({ prefix: 'message' });
// message-0, message-1, ...
```

Inject this function only through a public `generateId` option. Do not patch global randomness.

## Capturing calls for other model types

Language and embedding mocks have call arrays. Image, speech, transcription, reranking, and video mocks do not. Use the Node runner's built-in spy:

```ts
import { MockImageModelV4 } from 'ai/test';
import { mock } from 'node:test';

const doGenerate = mock.fn(async (options) => imageResult);
const model = new MockImageModelV4({ doGenerate });

await generateImage({ model, prompt: 'a lighthouse' });
assert.deepStrictEqual(doGenerate.mock.callCount(), 1);
```

## Provider registry

```ts
import { MockLanguageModelV4, MockProviderV4 } from 'ai/test';

const provider = new MockProviderV4({
  languageModels: {
    primary: new MockLanguageModelV4({ doGenerate: textResult('ok') }),
  },
});
```

Use this when the code resolves models by provider/model ID. Unknown IDs intentionally raise `NoSuchModelError`.
