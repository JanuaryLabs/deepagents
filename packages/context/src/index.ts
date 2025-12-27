import type { ContextFragment } from './lib/context.ts';
import { type EstimateResult, getModelsRegistry } from './lib/estimate.ts';
import type { Models } from './lib/models.generated.ts';
import {
  type ContextRenderer,
  XmlRenderer,
} from './lib/renderers/abstract.renderer.ts';

export type { ContextFragment } from './lib/context.ts';
export {
  type ContextRenderer,
  type RendererOptions,
  XmlRenderer,
  MarkdownRenderer,
  TomlRenderer,
  ToonRenderer,
} from './lib/renderers/abstract.renderer.ts';
export {
  type ModelCost,
  type ModelInfo,
  type EstimateResult,
  type Tokenizer,
  defaultTokenizer,
  ModelsRegistry,
  getModelsRegistry,
} from './lib/estimate.ts';
export type { Models, KnownModels } from './lib/models.generated.ts';

export class ContextEngine {
  #fragments: ContextFragment[] = [];

  public set(...fragments: ContextFragment[]) {
    this.#fragments.push(...fragments);
    return this;
  }

  public render(renderer: ContextRenderer) {
    return renderer.render(this.#fragments);
  }

  /**
   * Estimate token count and cost for the current context
   *
   * @param modelId - Model ID (e.g., "openai:gpt-4o", "anthropic:claude-3-5-sonnet")
   * @param options - Optional settings
   * @param options.renderer - Renderer to use (defaults to XmlRenderer)
   * @returns Estimate result with token counts and costs
   *
   * @example
   * ```ts
   * const context = new ContextEngine();
   * context.set(fragment('system', hint('You are helpful.')));
   *
   * const estimate = await context.estimate('openai:gpt-4o');
   * console.log(`Tokens: ${estimate.tokens}`);
   * console.log(`Cost: $${estimate.cost.toFixed(4)}`);
   * ```
   */
  public async estimate(
    modelId: Models,
    options: {
      renderer?: ContextRenderer;
    } = {},
  ): Promise<EstimateResult> {
    const renderer = options.renderer ?? new XmlRenderer();
    const renderedContext = this.render(renderer);

    const registry = getModelsRegistry();
    await registry.load();

    return registry.estimate(modelId, renderedContext);
  }

  /**
   * Consolidate context fragments (no-op for now).
   *
   * This is a placeholder for future functionality that merges context fragments
   * using specific rules. Currently, it does nothing.
   *
   * @experimental
   */
  public consolidate(): void {
    return void 0;
  }
}

export function hint(text: string): ContextFragment {
  return {
    name: 'hint',
    data: text,
  };
}

export function fragment(
  name: string,
  ...children: ContextFragment[]
): ContextFragment {
  return {
    name,
    data: children,
  };
}
