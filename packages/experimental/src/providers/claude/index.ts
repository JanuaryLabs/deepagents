import { createAnthropic } from '@ai-sdk/anthropic';
import { defaultSettingsMiddleware } from 'ai';

import { createLanguageModelProvider } from '../language-model-provider.ts';
import { getLocalClaudeAuth } from './local-credentials.ts';

/** Creates AI SDK models using the existing Claude Code login. */
export function createClaude() {
  const provider = createAnthropic({
    name: 'claude.messages',
    baseURL: 'https://api.anthropic.com/v1',
    authToken: 'injected-by-local-claude-transport',
    // Native OAuth requires this private client identity. Verified with the
    // Messages endpoint; keep compatibility details confined to this adapter.
    headers: {
      'anthropic-beta': 'oauth-2025-04-20',
    },
    fetch: async (input, init) => {
      const signal =
        init?.signal ?? (input instanceof Request ? input.signal : undefined);
      const token = await getLocalClaudeAuth(signal);
      const headers = new Headers(init?.headers);
      headers.set('authorization', `Bearer ${token}`);
      headers.delete('x-api-key');
      return globalThis.fetch(input, { ...init, headers });
    },
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

export const claude = createClaude();
