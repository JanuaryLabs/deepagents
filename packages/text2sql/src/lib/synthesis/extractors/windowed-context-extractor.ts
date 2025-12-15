/**
 * WindowedContextExtractor - Extracts pairs with a sliding window of context.
 *
 * Keeps only the last N messages in context. Useful for long conversations
 * where older messages become less relevant.
 */
import type { UIMessage } from 'ai';

import type { Adapter } from '../../adapters/adapter.ts';

import {
  BaseContextualExtractor,
  type BaseContextualExtractorOptions,
} from './base-contextual-extractor.ts';

export interface WindowedContextExtractorOptions
  extends BaseContextualExtractorOptions {
  windowSize: number;
}

/**
 * Extracts SQL pairs with a sliding window of conversation context.
 *
 * @example
 * ```typescript
 * const extractor = new WindowedContextExtractor(messages, adapter, {
 *   windowSize: 5,
 * });
 * const pairs = await extractor.produce();
 * ```
 */
export class WindowedContextExtractor extends BaseContextualExtractor {
  private windowSize: number;

  constructor(
    messages: UIMessage[],
    adapter: Adapter,
    options: WindowedContextExtractorOptions,
  ) {
    super(messages, adapter, options);
    this.windowSize = options.windowSize;
  }

  /**
   * Add user message to context (keeps all, windowing happens on snapshot).
   */
  protected async onUserMessage(text: string): Promise<void> {
    this.context.push(`User: ${text}`);
  }

  /**
   * Return only the last N messages based on window size.
   */
  protected getContextSnapshot(): string[] {
    if (this.context.length <= this.windowSize) {
      return [...this.context];
    }
    return this.context.slice(-this.windowSize);
  }
}
