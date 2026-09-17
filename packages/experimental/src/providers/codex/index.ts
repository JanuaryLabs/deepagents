import { createOpenAI } from '@ai-sdk/openai';
import {
  DEFAULT_CODEX_BASE_URL,
  createCodexFetch,
  resolveConfig,
} from '@opencoredev/loginwithchatgpt-core';

import { createLanguageModelProvider } from '../language-model-provider.ts';
import { generateViaStream } from './generate-via-stream.ts';
import { getLocalCodexAuth } from './local-credentials.ts';

/** Creates AI SDK models; Zukhruf or the calling application owns the tool loop. */
export function createCodex() {
  const provider = createOpenAI({
    name: 'codex',
    baseURL: DEFAULT_CODEX_BASE_URL,
    apiKey: 'injected-by-local-chatgpt-transport',
    fetch: (input, init) =>
      createCodexFetch({
        config: resolveConfig(),
        getAuth: () =>
          getLocalCodexAuth(
            init?.signal ??
              (input instanceof Request ? input.signal : undefined),
          ),
      })(input, init),
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

export const codex = createCodex();
