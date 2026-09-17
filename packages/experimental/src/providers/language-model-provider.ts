import type { ProviderV4 } from '@ai-sdk/provider';
import { type LanguageModelMiddleware, customProvider, wrapProvider } from 'ai';

/** Adds dynamic model selection and callable syntax to AI SDK's provider protocol. */
export function createLanguageModelProvider(
  languageModel: ProviderV4['languageModel'],
  middleware: LanguageModelMiddleware | LanguageModelMiddleware[],
): ProviderV4 & ProviderV4['languageModel'] {
  const provider = wrapProvider({
    // The SDK rejects unsupported modalities; never expose the backing
    // provider's embedding or image endpoints through a subscription transport.
    provider: { ...customProvider({}), languageModel },
    languageModelMiddleware: middleware,
  });

  return Object.assign(provider.languageModel, provider);
}
