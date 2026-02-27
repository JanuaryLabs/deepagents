import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createGroq } from '@ai-sdk/groq';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModelV3 } from '@ai-sdk/provider';

type ProviderFactory = (modelId: string) => LanguageModelV3;

const providers: Record<string, ProviderFactory> = {
  openai: (id) => createOpenAI()(id),
  anthropic: (id) => createAnthropic()(id),
  google: (id) => createGoogleGenerativeAI()(id),
  groq: (id) => createGroq()(id),
  ollama: (id) =>
    createOpenAICompatible({
      name: 'ollama',
      baseURL: process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434/v1',
    })(id),
  lmstudio: (id) =>
    createOpenAICompatible({
      name: 'lmstudio',
      baseURL: process.env.LM_STUDIO_BASE_URL ?? 'http://127.0.0.1:1234/v1',
    })(id),
};

export function resolveModel(modelString: string): LanguageModelV3 {
  const slashIndex = modelString.indexOf('/');
  if (slashIndex === -1) {
    throw new Error(
      `Invalid model format "${modelString}". Expected "provider/model-id" (e.g. "openai/gpt-4o").`,
    );
  }
  const providerName = modelString.slice(0, slashIndex);
  const modelId = modelString.slice(slashIndex + 1);
  const factory = providers[providerName];
  if (!factory) {
    throw new Error(
      `Unknown provider "${providerName}". Available: ${Object.keys(providers).join(', ')}`,
    );
  }
  return factory(modelId);
}
