# AI SDK v7 test API

Source of truth: public `ai` and `ai/test` exports and implementations, plus the V4 interfaces in `@ai-sdk/provider`.

## Utility exports

```ts
import { simulateReadableStream } from 'ai';
import {
  convertArrayToAsyncIterable,
  convertArrayToReadableStream,
  convertReadableStreamToArray,
  mockId,
  mockValues,
} from 'ai/test';
```

- `mockValues(...values)` advances once per invocation and repeats the last value after exhaustion. Its implementation uses nullish fallback, so do not use `null` or `undefined` as intentional intermediate values. Use it for sequential model results; use a function when a step must throw or inspect options.
- `mockId({ prefix })` returns a deterministic ID generator (`prefix-0`, `prefix-1`, ...). Inject it through public `generateId` options where available.
- `convertArrayToAsyncIterable(values)` creates an async iterable without a custom generator.
- `convertArrayToReadableStream(values)` creates an immediate readable stream.
- `convertReadableStreamToArray(stream)` drains and collects a stream without a local reader loop.
- `simulateReadableStream({ chunks, initialDelayInMs, chunkDelayInMs })` simulates delayed or immediate chunks. Import it from `ai`; the `ai/test` export is deprecated.

## Stream and UI-message exports

```ts
import {
  consumeStream,
  isTextUIPart,
  readUIMessageStream,
  toTextStream,
} from 'ai';
```

- `readUIMessageStream({ stream, message, onError, terminateOnError })` reconstructs cumulative `UIMessage` snapshots from a `ReadableStream<UIMessageChunk>`. Keep the last yielded snapshot to inspect the final message. `terminateOnError` defaults to `false`; set it when processing errors must reject the consumer.
- `isTextUIPart(part)` is the public type guard for narrowing a `UIMessagePart` before reading `part.text`.
- `toTextStream({ stream })` accepts `ReadableStream<TextStreamPart>` and emits each text delta's `text`. It does not accept a UI-message stream, whose `text-delta` chunks carry `delta` instead.
- `consumeStream({ stream, onError })` drains without collecting. It catches reader errors and calls `onError`; with no callback it resolves after the error. Do not use it when the test must inspect content or observe stream rejection.

## Repository polling helper

```ts
import { timebox } from '@deepagents/test';
```

Use `timebox(probe, options)` for asynchronous status, conversation, or readiness polling. The probe throws until ready and its successful value becomes the result. Set `maxRetryTime` and `minTimeout` when the test owns a specific timeout or polling cadence. AI SDK does not provide status or conversation polling.

## V4 mock models

| Export                     | Constructor behavior worth knowing                                                                                                                                                           |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MockLanguageModelV4`      | `doGenerate`/`doStream` accept a function, fixed result, or result array; captures `doGenerateCalls`/`doStreamCalls`; supports dynamic `supportedUrls`. A fixed stream result is single-use. |
| `MockEmbeddingModelV4`     | `doEmbed` accepts a function, fixed result, or result array; captures `doEmbedCalls`; configures batching/parallel-call capabilities.                                                        |
| `MockImageModelV4`         | Configures `doGenerate` and `maxImagesPerCall`; does not capture calls.                                                                                                                      |
| `MockSpeechModelV4`        | Configures speech `doGenerate`; does not capture calls.                                                                                                                                      |
| `MockTranscriptionModelV4` | Configures transcription `doGenerate` and `doStream`; does not capture calls.                                                                                                                |
| `MockRerankingModelV4`     | Configures `doRerank`; does not capture calls.                                                                                                                                               |
| `MockVideoModelV4`         | Configures video `doGenerate` and `maxVideosPerCall`; does not capture calls.                                                                                                                |
| `MockProviderV4`           | Maps model IDs to language, embedding, image, transcription, speech, and reranking models; unknown IDs throw `NoSuchModelError`.                                                             |

The package still exports V3 mocks, but this repo targets AI SDK v7's V4 provider interface. Do not select V3 merely because it remains exported.

Only language and embedding mocks implement built-in call arrays. For other modalities, use Node's built-in spy rather than a handwritten wrapper:

```ts
import { MockImageModelV4 } from 'ai/test';
import { mock } from 'node:test';

const doGenerate = mock.fn(async (options) => imageResult);
const model = new MockImageModelV4({ doGenerate });
// inspect doGenerate.mock.calls
```

## Evidence checks before writing a test

```sh
node -e "import('ai/test').then(m => console.log(Object.keys(m).sort()))"
```

Then inspect:

- `node_modules/ai/dist/index.d.ts` and `node_modules/ai/dist/index.js` for public stream/message helpers and their runtime error behavior.
- `node_modules/ai/dist/test/index.d.ts` for the supported constructor surface.
- `node_modules/ai/dist/test/index.js` when sequencing or capture behavior matters.
- `node_modules/@ai-sdk/provider/dist/index.d.ts` for exact V4 result and chunk shapes.
- repository call sites using `rg "Mock.*V4|simulateReadableStream|mockValues" packages`.

Use `satisfies` and a focused runtime probe for in-code fixtures. Reserve the bundled validator for extracted JSON and lifecycle rules—ordering, matching IDs, and terminal finish—that the public package does not validate.
