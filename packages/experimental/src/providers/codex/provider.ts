import { createOpenAI } from '@ai-sdk/openai';
import { DEFAULT_CODEX_BASE_URL } from '@opencoredev/loginwithchatgpt-core';

import { createLanguageModelProvider } from '../language-model-provider.ts';
import { generateViaStream } from './generate-via-stream.ts';

/** Codex Responses models over a ChatGPT transport; `fetch` owns authentication. */
export function codexProvider(fetch: typeof globalThis.fetch) {
  const provider = createOpenAI({
    name: 'codex',
    baseURL: DEFAULT_CODEX_BASE_URL,
    apiKey: 'injected-by-chatgpt-transport',
    fetch,
  });

  return createLanguageModelProvider(provider.responses, {
    specificationVersion: 'v4',
    // Set this before the OpenAI provider encodes history, otherwise it can
    // replace prior content with server-side references that Codex cannot use.
    transformParams: async ({ params }) => ({
      ...params,
      providerOptions: {
        ...params.providerOptions,
        openai: { ...params.providerOptions?.openai, store: false },
      },
    }),
    wrapGenerate: async ({ doStream }) => generateViaStream(await doStream()),
  });
}
