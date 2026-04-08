# MockLanguageModelV3 Patterns

## Table of Contents

- [Usage Fixture](#usage-fixture)
- [Pattern 1: Static doGenerate](#pattern-1-static-dogenerate)
- [Pattern 2: Throwing Model](#pattern-2-throwing-model)
- [Pattern 3: Capturing Model](#pattern-3-capturing-model)
- [Pattern 4: Streaming with doStream](#pattern-4-streaming-with-dostream)
- [Pattern 5: Tool Call Model](#pattern-5-tool-call-model)
- [Pattern 6: Multi-Response Sequence](#pattern-6-multi-response-sequence)
- [AI SDK Error Constructors](#ai-sdk-error-constructors)
- [Gotchas](#gotchas)

---

## Usage Fixture

Every mock model needs a `usage` object:

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

For streaming, a simpler shape works:

```ts
const testUsage = {
  inputTokens: { total: 10 },
  outputTokens: { total: 5 },
} as const;
```

---

## Pattern 1: Static doGenerate

Return a fixed response. Used when you just need the model to return data.

```ts
import { MockLanguageModelV3 } from 'ai/test';

function createMockModel(response: Record<string, unknown>) {
  return new MockLanguageModelV3({
    doGenerate: {
      finishReason: { unified: 'stop', raw: '' },
      usage: testUsage,
      content: [{ type: 'text', text: JSON.stringify(response) }],
      warnings: [],
    },
  });
}

// Usage:
const model = createMockModel({ answer: 'Paris' });
```

---

## Pattern 2: Throwing Model

Model that always throws. Used to test error handling paths.

```ts
function createThrowingModel(errorFactory: () => Error) {
  return new MockLanguageModelV3({
    doGenerate: async () => {
      throw errorFactory();
    },
  });
}

// Usage:
const model = createThrowingModel(
  () =>
    new APICallError({
      message: 'Rate limit exceeded',
      url: 'https://api.example.com',
      requestBodyValues: {},
      isRetryable: true,
    }),
);
```

---

## Pattern 3: Capturing Model

Records all calls for prompt/settings inspection. Supports mixed responses and errors.

```ts
function createCapturingModel(responses: Array<Record<string, unknown> | Error>) {
  const calls: Array<{ messages: unknown; settings: unknown }> = [];
  let callIndex = 0;
  return {
    calls,
    model: new MockLanguageModelV3({
      doGenerate: async (options) => {
        calls.push({ messages: options.prompt, settings: options });
        const response = responses[callIndex++];
        if (response instanceof Error) throw response;
        return {
          finishReason: { unified: 'stop', raw: '' },
          usage: testUsage,
          content: [{ type: 'text' as const, text: JSON.stringify(response) }],
          warnings: [],
        };
      },
    }),
  };
}

// Verify prompt content:
const { model, calls } = createCapturingModel([{ answer: 'Paris' }]);
await generateText({ model, prompt: 'What is the capital of France?' });
const promptContent = JSON.stringify(calls[0].messages);
assert.ok(promptContent.includes('capital'));

// Test retry with error then success:
const { model, calls } = createCapturingModel([
  new JSONParseError({ text: '{ bad', cause: new SyntaxError('Unexpected') }),
  { answer: 'Paris' },
]);
```

---

## Pattern 4: Streaming with doStream

Simulate streaming responses using V3 chunk protocol. Required for testing `streamText()`.

```ts
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';

function createStreamingModel(text = 'response text') {
  return new MockLanguageModelV3({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: 'text-start', id: 'text-1' },
          { type: 'text-delta', id: 'text-1', delta: text },
          { type: 'text-end', id: 'text-1' },
          {
            type: 'finish',
            finishReason: { unified: 'stop', raw: '' },
            usage: testUsage,
          },
        ],
      }),
      rawCall: { rawPrompt: undefined, rawSettings: {} },
    }),
  });
}
```

Consume streams with a drain helper:

```ts
async function drain(stream: ReadableStream) {
  const reader = stream.getReader();
  while (true) {
    const { done } = await reader.read();
    if (done) break;
  }
}
```

Bypass `smoothStream()` when constructing the object under test:

```ts
// Pass this option to prevent smoothStream() from hanging in tests
{
  transform: () => new TransformStream();
}
```

---

## Pattern 5: Tool Call Model

Simulate the model invoking a tool. Used with `generateText()` + `stepCountIs(1)`.

```ts
import { generateText, stepCountIs } from 'ai';

const createToolCallModel = (toolName: string, input: string) =>
  new MockLanguageModelV3({
    doGenerate: {
      finishReason: { unified: 'tool-calls', raw: undefined },
      usage: testUsage,
      warnings: [],
      content: [
        {
          type: 'tool-call',
          toolCallType: 'function',
          toolCallId: 'call-1',
          toolName,
          input,
        },
      ],
    },
  });

// Execute with real tool logic:
const result = await generateText({
  model: createToolCallModel(
    'search',
    '{"query":"weather","reasoning":"test"}',
  ),
  prompt: 'test-input',
  stopWhen: stepCountIs(1),
  tools: { search: mySearchTool },
});

// Inspect results:
const toolResult = result.content.find(
  (p) => p.type === 'tool-result' && p.toolName === 'search',
);
const toolError = result.content.find(
  (p) => p.type === 'tool-error' && p.toolName === 'search',
);
```

---

## Pattern 6: Multi-Response Sequence

Inline model with `callCount` for tests needing different responses per call.

```ts
let callCount = 0;
const model = new MockLanguageModelV3({
  doGenerate: async () => {
    callCount++;
    if (callCount === 1) {
      throw new APICallError({
        message: 'Rate limit exceeded',
        url: 'https://api.example.com',
        requestBodyValues: {},
        isRetryable: true,
      });
    }
    return {
      finishReason: { unified: 'stop', raw: '' },
      usage: testUsage,
      content: [{ type: 'text', text: JSON.stringify({ answer: 'success' }) }],
      warnings: [],
    };
  },
});
```

Prefer `createCapturingModel` (Pattern 3) when you also need to inspect calls. Use this inline pattern only for custom per-call logic beyond simple sequencing.

---

## AI SDK Error Constructors

```ts
import {
  APICallError,
  JSONParseError,
  NoContentGeneratedError,
  NoObjectGeneratedError,
  NoOutputGeneratedError,
  TypeValidationError,
} from 'ai';

// APICallError
new APICallError({
  message: 'Rate limit exceeded',
  url: 'https://api.example.com',
  requestBodyValues: {},
  isRetryable: true,
  statusCode: 429, // optional
  responseBody: '...', // optional
});

// JSONParseError
new JSONParseError({
  text: '{ bad json',
  cause: new SyntaxError('Unexpected token'),
});

// TypeValidationError
new TypeValidationError({
  value: { invalid: true },
  cause: new Error('Expected string, got number'),
});

// NoObjectGeneratedError
new NoObjectGeneratedError({
  response: { id: 'r1', timestamp: new Date(), modelId: 'test' },
  usage: { inputTokens: 10, outputTokens: 0, totalTokens: 10 },
  finishReason: 'error',
});

// NoOutputGeneratedError — no args required
new NoOutputGeneratedError();

// NoContentGeneratedError — no args required
new NoContentGeneratedError();
```

---

## Gotchas

1. **V3 uses `delta` not `textDelta`** — `textDelta` is V2 and will silently produce empty output
2. **V3 requires `id` on text-start/delta/end** chunks
3. **V3 requires text-start -> text-delta -> text-end** sequence
4. **No `step-finish` at model level** — that's internal to AI SDK
5. **`doGenerate` does NOT simulate `doStream`** — provide both if your code calls `streamText()`
6. **`smoothStream()` hangs in tests** — bypass with `transform: () => new TransformStream()`
7. **`totalUsage` returns `inputTokens`/`outputTokens`/`totalTokens`** — the old `promptTokens`/`completionTokens` names no longer exist
8. **All AI SDK error types extend `Error`** — so `instanceof Error` is `true` for all of them
9. **`isInstance()` static methods use symbol markers** — prefer `ErrorClass.isInstance(err)` over `instanceof`
10. **Build before running tests** — if tests import from package specifiers which resolve to `dist/`
