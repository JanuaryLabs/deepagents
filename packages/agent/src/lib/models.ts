import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { embedMany, extractReasoningMiddleware, wrapLanguageModel } from 'ai';

export const lmstudio = createOpenAICompatible({
  name: 'lmstudio',
  baseURL: process.env.LM_STUDIO_BASE_URL ?? 'http://127.0.0.1:1234/v1',
  supportsStructuredOutputs: true,
  includeUsage: true,
});

export const ollama = createOpenAICompatible({
  name: 'ollama',
  baseURL: process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434/v1',
  supportsStructuredOutputs: true,
});

export const glm = createOpenAICompatible({
  name: 'z.ai',
  baseURL: 'https://api.z.ai/api/paas/v4/',
  apiKey: process.env.ZAI_API_KEY,
});

export const cerebras = createOpenAICompatible({
  name: 'cerebras',
  baseURL: 'https://api.cerebras.ai/v1',
  apiKey: process.env.CEREBRAS_API_KEY,
  includeUsage: true,
  supportsStructuredOutputs: true,
});
export const nebius = createOpenAICompatible({
  name: 'nebius',
  baseURL: 'https://api.tokenfactory.nebius.com/v1/',
  apiKey: process.env.NEBIUS_API_KEY,
  includeUsage: true,
  supportsStructuredOutputs: true,
});
interface MiniMaxProviderSettings {
  /**
   * Base URL for the Groq API calls.
   */
  baseURL?: string;
  /**
   * API key for authenticating requests.
   */
  apiKey?: string;
  /**
   * Custom headers to include in the requests.
   */
  headers?: Record<string, string>;
}

export function createMiniMax(config: MiniMaxProviderSettings = {}) {
  return (modelId: 'MiniMax-M2.5') => {
    return wrapLanguageModel({
      model: createOpenAICompatible({
        headers: config.headers,
        name: 'minimax',
        baseURL: config.baseURL ?? 'https://api.minimax.chat/v1',
        apiKey: config.apiKey ?? process.env.MINIMAX_API_KEY,
        includeUsage: true,
        supportsStructuredOutputs: true,
      })(modelId),
      middleware: extractReasoningMiddleware({ tagName: 'think' }),
    });
  };
}

export const minimax = (modelId: 'MiniMax-M2.5') => createMiniMax()(modelId);

export async function embed(documents: string[]): Promise<{
  embeddings: number[][];
  dimensions: number;
}> {
  const dimensions = 1024;
  const { embeddings } = await embedMany({
    model: lmstudio.embeddingModel('text-embedding-qwen3-embedding-0.6b'),
    values: documents,
    providerOptions: { lmstudio: { dimensions } },
  });
  return { embeddings, dimensions };
}
