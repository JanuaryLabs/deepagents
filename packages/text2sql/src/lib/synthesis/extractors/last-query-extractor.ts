import type { UIMessage } from 'ai';

import { generate, user } from '@deepagents/agent';

import type { Adapter } from '../../adapters/adapter.ts';
import type { ExtractedPair } from '../types.ts';
import {
  BaseContextualExtractor,
  type BaseContextualExtractorOptions,
  contextResolverAgent,
  formatConversation,
} from './base-contextual-extractor.ts';

export type LastQueryExtractorOptions = BaseContextualExtractorOptions;

/**
 * Extracts only the last SQL query with its resolved question.
 *
 * @example
 * ```typescript
 * const extractor = new LastQueryExtractor(messages, adapter);
 * const pairs = await toPairs(extractor); // Returns array with at most 1 pair
 * ```
 */
export class LastQueryExtractor extends BaseContextualExtractor {
  constructor(
    messages: UIMessage[],
    adapter: Adapter,
    options: LastQueryExtractorOptions = {},
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

  /**
   * Override to only resolve the LAST query instead of all queries.
   */
  protected override async *resolveQuestions(
    introspection: string,
  ): AsyncGenerator<ExtractedPair[]> {
    if (this.results.length === 0) {
      return;
    }

    const last = this.results.at(-1)!;
    const { experimental_output } = await generate(
      contextResolverAgent,
      [user('Generate a standalone question for this SQL query.')],
      {
        conversation: formatConversation(last.conversationContext),
        sql: last.sql,
        introspection,
      },
    );

    yield [
      {
        question: experimental_output.question,
        sql: last.sql,
        context: last.conversationContext,
        success: last.success,
      },
    ];
  }
}
