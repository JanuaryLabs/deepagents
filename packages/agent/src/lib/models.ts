import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { embedMany } from 'ai';

export const lmstudio = createOpenAICompatible({
  name: 'lmstudio',
  baseURL: process.env.LM_STUDIO_BASE_URL ?? 'http://127.0.0.1:1234/v1',
  supportsStructuredOutputs: true,
  includeUsage: true,
});

export const glm = createOpenAICompatible({
  name: 'z.ai',
  baseURL: 'https://api.z.ai/api/paas/v4/',
  apiKey: process.env.ZAI_API_KEY,
});

export async function embed(documents: string[]): Promise<{
  embeddings: number[][];
  dimensions: number;
}> {
  const dimensions = 1024;
  const { embeddings } = await embedMany({
    model: lmstudio.textEmbeddingModel('text-embedding-qwen3-embedding-0.6b'),
    values: documents,
    providerOptions: { lmstudio: { dimensions } },
  });
  return { embeddings, dimensions };
}
