# AI SDK v7 test API

Source of truth: `ai/test` exports and implementation, plus the V4 interfaces in `@ai-sdk/provider`.

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

- `node_modules/ai/dist/test/index.d.ts` for the supported constructor surface.
- `node_modules/ai/dist/test/index.js` when sequencing or capture behavior matters.
- `node_modules/@ai-sdk/provider/dist/index.d.ts` for exact V4 result and chunk shapes.
- repository call sites using `rg "Mock.*V4|simulateReadableStream|mockValues" packages`.

Use `satisfies` and a focused runtime probe for in-code fixtures. Reserve the bundled validator for extracted JSON and lifecycle rules—ordering, matching IDs, and terminal finish—that the public package does not validate.
