import { encode } from 'gpt-tokenizer';

import type { ContextFragment } from './context.ts';
import type { Models } from './models.generated.ts';
import type { ContextRenderer } from './renderers/abstract.renderer.ts';

/**
 * Cost information for a model (prices per 1M tokens)
 */
export interface ModelCost {
  input: number;
  output: number;
  cache_read?: number;
  cache_write?: number;
  reasoning?: number;
}

/**
 * Model information from models.dev
 */
export interface ModelInfo {
  id: string;
  name: string;
  family: string;
  cost: ModelCost;
  limit: {
    context: number;
    output: number;
  };
  provider: string;
}

/**
 * Estimate for a single fragment
 */
export interface FragmentEstimate {
  name: string;
  id?: string;
  tokens: number;
  cost: number;
}

/**
 * Estimate result returned by the estimate function
 */
export interface EstimateResult {
  model: string;
  provider: string;
  tokens: number;
  cost: number;
  limits: {
    context: number;
    output: number;
    exceedsContext: boolean;
  };
  fragments: FragmentEstimate[];
}

/**
 * Tokenizer interface for counting tokens
 */
export interface Tokenizer {
  encode(text: string): number[];
  count(text: string): number;
}

/**
 * Default tokenizer using gpt-tokenizer
 * Works reasonably well for most models (~5-10% variance)
 */
export const defaultTokenizer: Tokenizer = {
  encode(text: string): number[] {
    return encode(text);
  },
  count(text: string): number {
    return encode(text).length;
  },
};

type ModelsDevResponse = Record<
  string,
  {
    id: string;
    name: string;
    models: Record<
      string,
      {
        id: string;
        name: string;
        family: string;
        cost: ModelCost;
        limit: { context: number; output: number };
      }
    >;
  }
>;

/**
 * Registry for AI model information from models.dev
 * Caches data and provides lookup by model ID
 */
export class ModelsRegistry {
  #cache: Map<string, ModelInfo> = new Map();
  #loaded = false;
  #tokenizers: Map<string, Tokenizer> = new Map();
  #defaultTokenizer: Tokenizer = defaultTokenizer;

  /**
   * Load models data from models.dev API
   */
  async load(): Promise<void> {
    if (this.#loaded) return;

    const response = await fetch('https://models.dev/api.json');
    if (!response.ok) {
      throw new Error(`Failed to fetch models: ${response.statusText}`);
    }

    const data = (await response.json()) as ModelsDevResponse;

    for (const [providerId, provider] of Object.entries(data)) {
      for (const [modelId, model] of Object.entries(provider.models)) {
        const info: ModelInfo = {
          id: model.id,
          name: model.name,
          family: model.family,
          cost: model.cost,
          limit: model.limit,
          provider: providerId,
        };

        // Store by full ID (provider:model)
        this.#cache.set(`${providerId}:${modelId}`, info);
      }
    }

    this.#loaded = true;
  }

  /**
   * Get model info by ID
   * @param modelId - Model ID (e.g., "openai:gpt-4o")
   */
  get(modelId: string): ModelInfo | undefined {
    return this.#cache.get(modelId);
  }

  /**
   * Check if a model exists in the registry
   */
  has(modelId: string): boolean {
    return this.#cache.has(modelId);
  }

  /**
   * List all available model IDs
   */
  list(): string[] {
    return [...this.#cache.keys()];
  }

  /**
   * Register a custom tokenizer for specific model families
   * @param family - Model family name (e.g., "llama", "claude")
   * @param tokenizer - Tokenizer implementation
   */
  registerTokenizer(family: string, tokenizer: Tokenizer): void {
    this.#tokenizers.set(family, tokenizer);
  }

  /**
   * Set the default tokenizer used when no family-specific tokenizer is registered
   */
  setDefaultTokenizer(tokenizer: Tokenizer): void {
    this.#defaultTokenizer = tokenizer;
  }

  /**
   * Get the appropriate tokenizer for a model
   */
  getTokenizer(modelId: string): Tokenizer {
    const model = this.get(modelId);
    if (model) {
      const familyTokenizer = this.#tokenizers.get(model.family);
      if (familyTokenizer) {
        return familyTokenizer;
      }
    }
    return this.#defaultTokenizer;
  }

  /**
   * Estimate token count and cost for given text and model
   * @param modelId - Model ID to use for pricing (e.g., "openai:gpt-4o")
   * @param input - Input text (prompt)
   */
  estimate(modelId: Models, input: string): EstimateResult {
    const model = this.get(modelId);
    if (!model) {
      throw new Error(
        `Model "${modelId}" not found. Call load() first or check model ID.`,
      );
    }

    const tokenizer = this.getTokenizer(modelId);
    const tokens = tokenizer.count(input);
    const cost = (tokens / 1_000_000) * model.cost.input;

    return {
      model: model.id,
      provider: model.provider,
      tokens,
      cost,
      limits: {
        context: model.limit.context,
        output: model.limit.output,
        exceedsContext: tokens > model.limit.context,
      },
      fragments: [],
    };
  }
}

// Singleton instance for convenience
let _registry: ModelsRegistry | null = null;

/**
 * Get the shared ModelsRegistry instance
 */
export function getModelsRegistry(): ModelsRegistry {
  if (!_registry) {
    _registry = new ModelsRegistry();
  }
  return _registry;
}

/**
 * Convenience function to estimate cost for a model
 * Automatically loads the registry if not already loaded
 *
 * @param modelId - Model ID (e.g., "openai:gpt-4o", "anthropic:claude-3-5-sonnet")
 * @param renderer - Renderer to use for converting fragments to text
 * @param fragments - Context fragments to estimate
 */
export async function estimate(
  modelId: Models,
  renderer: ContextRenderer,
  ...fragments: ContextFragment[]
): Promise<EstimateResult> {
  const registry = getModelsRegistry();
  await registry.load();

  // Calculate total (all fragments rendered together)
  const input = renderer.render(fragments);
  const model = registry.get(modelId);
  if (!model) {
    throw new Error(
      `Model "${modelId}" not found. Call load() first or check model ID.`,
    );
  }

  const tokenizer = registry.getTokenizer(modelId);
  const totalTokens = tokenizer.count(input);
  const totalCost = (totalTokens / 1_000_000) * model.cost.input;

  // Calculate per-fragment estimates
  const fragmentEstimates: FragmentEstimate[] = fragments.map((fragment) => {
    const rendered = renderer.render([fragment]);
    const tokens = tokenizer.count(rendered);
    const cost = (tokens / 1_000_000) * model.cost.input;
    return {
      id: fragment.id,
      name: fragment.name,
      tokens,
      cost,
    };
  });

  return {
    model: model.id,
    provider: model.provider,
    tokens: totalTokens,
    cost: totalCost,
    limits: {
      context: model.limit.context,
      output: model.limit.output,
      exceedsContext: totalTokens > model.limit.context,
    },
    fragments: fragmentEstimates,
  };
}
