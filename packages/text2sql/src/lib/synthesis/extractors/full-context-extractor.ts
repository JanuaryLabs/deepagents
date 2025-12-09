/**
 * FullContextExtractor - Extracts pairs with complete conversation context.
 *
 * Keeps all messages in context from the start of the conversation.
 * Best for short conversations where full history is relevant.
 */
import type { UIMessage } from 'ai';

import type { Adapter } from '../../adapters/adapter.ts';

import {
  BaseContextualExtractor,
  type BaseContextualExtractorOptions,
} from './base-contextual-extractor.ts';

export type FullContextExtractorOptions = BaseContextualExtractorOptions;

/**
 * Extracts SQL pairs with full conversation context.
 *
 * @example
 * ```typescript
 * const extractor = new FullContextExtractor(messages, adapter);
 * const pairs = await extractor.produce();
 * ```
 */
export class FullContextExtractor extends BaseContextualExtractor {
  constructor(
    messages: UIMessage[],
    adapter: Adapter,
    options: FullContextExtractorOptions = {},
  ) {
    super(messages, adapter, options);
  }

  /**
   * Add user message to context (keeps all messages).
   */
  protected async onUserMessage(text: string): Promise<void> {
    this.context.push(`User: ${text}`);
  }

  /**
   * Return all context accumulated so far.
   */
  protected getContextSnapshot(): string[] {
    return [...this.context];
  }
}
