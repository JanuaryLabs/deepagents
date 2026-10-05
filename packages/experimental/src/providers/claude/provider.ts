import { createAnthropic } from '@ai-sdk/anthropic';
import { defaultSettingsMiddleware } from 'ai';

import { createLanguageModelProvider } from '../language-model-provider.ts';

/** Claude Messages models over a subscription transport; `fetch` owns authentication. */
export function claudeProvider(fetch: typeof globalThis.fetch) {
  const provider = createAnthropic({
    name: 'claude.messages',
    baseURL: 'https://api.anthropic.com/v1',
    authToken: 'injected-by-claude-subscription-transport',
    // Native OAuth requires this private client identity. Verified with the
    // Messages endpoint; keep compatibility details confined to this adapter.
    headers: {
      'anthropic-beta': 'oauth-2025-04-20',
    },
    fetch,
  });

  return createLanguageModelProvider(provider.languageModel, [
    {
      specificationVersion: 'v4',
      transformParams: async ({ params }) => ({
        ...params,
        prompt: [
          {
            role: 'system',
            content:
              "You are a Claude agent, built on Anthropic's Claude Agent SDK.",
          },
          ...params.prompt,
        ],
      }),
    },
    defaultSettingsMiddleware({
      settings: {
        providerOptions: {
          anthropic: { cacheControl: { type: 'ephemeral' } },
        },
      },
    }),
  ]);
}

export function withBearer(
  init: RequestInit | undefined,
  token: string,
): RequestInit {
  const headers = new Headers(init?.headers);
  headers.set('authorization', `Bearer ${token}`);
  headers.delete('x-api-key');
  return { ...init, headers };
}
