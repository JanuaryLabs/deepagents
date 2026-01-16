import { groq } from '@ai-sdk/groq';
import type { UIMessage } from 'ai';
import dedent from 'dedent';
import z from 'zod';

import {
  ContextEngine,
  InMemoryContextStore,
  fragment,
  persona,
  structuredOutput,
  user,
} from '@deepagents/context';

import type { Adapter } from '../../adapters/adapter.ts';
import {
  BaseContextualExtractor,
  type BaseContextualExtractorOptions,
  formatConversation,
  resolveContext,
} from './base-contextual-extractor.ts';

export type SegmentedContextExtractorOptions = BaseContextualExtractorOptions;

const topicChangeSchema = z.object({
  isTopicChange: z
    .boolean()
    .describe('Whether the new message represents a topic change'),
  reason: z.string().describe('Brief explanation for the decision'),
});

/**
 * Detects if a new message represents a topic change from the prior context.
 */
async function detectTopicChange(params: {
  context: string;
  newMessage: string;
}): Promise<{ isTopicChange: boolean; reason: string }> {
  const context = new ContextEngine({
    store: new InMemoryContextStore(),
    chatId: `topic-change-${crypto.randomUUID()}`,
    userId: 'system',
  });

  context.set(
    persona({
      name: 'topic_change_detector',
      role: 'You are an expert at understanding conversational flow and detecting topic changes.',
      objective: 'Detect significant topic changes in database conversations',
    }),
    fragment('conversation_context', params.context || '(no prior context)'),
    fragment('new_message', params.newMessage),
    fragment(
      'task',
      dedent`
        Determine if the new message represents a significant topic change from the
        prior conversation context. A topic change occurs when:
        1. The user asks about a completely different entity/table/domain
        2. The user starts a new analytical question unrelated to prior discussion
        3. There's a clear shift in what data or metrics are being discussed

        NOT a topic change:
        - Follow-up questions refining the same query ("filter by...", "sort by...")
        - Questions about the same entities with different conditions
        - Requests for more details on the same topic
      `,
    ),
    fragment(
      'examples',
      dedent`
        Context: "Show me customers in NY" → "Sort by revenue"
        New: "Filter to those with orders over $1000"
        Decision: NOT a topic change (still refining customer query)

        Context: "Show me customers in NY" → "Sort by revenue"
        New: "What were our total sales last quarter?"
        Decision: Topic change (shifted from customers to sales metrics)

        Context: "List all products"
        New: "How many orders did we have last month?"
        Decision: Topic change (products → orders/sales)
      `,
    ),
    user('Determine if this is a topic change.'),
  );

  const topicOutput = structuredOutput({
    model: groq('openai/gpt-oss-20b'),
    context,
    schema: topicChangeSchema,
  });

  return topicOutput.generate();
}

/**
 * Extracts SQL pairs with topic-aware context segmentation.
 *
 * When a topic change is detected:
 * 1. The triggering message is resolved to standalone form using LLM
 * 2. Context is reset
 * 3. The resolved message becomes the start of the new context
 *
 * @example
 * ```typescript
 * const extractor = new SegmentedContextExtractor(messages, adapter);
 * const pairs = await extractor.produce();
 * ```
 */
export class SegmentedContextExtractor extends BaseContextualExtractor {
  constructor(
    messages: UIMessage[],
    adapter: Adapter,
    options: SegmentedContextExtractorOptions = {},
  ) {
    super(messages, adapter, options);
  }

  /**
   * Handle user message with topic change detection.
   * If topic changes, resolve the message to standalone form before resetting.
   *
   * Note: We capture context snapshot before async LLM calls to prevent race conditions
   * where context might be modified during the async operation.
   */
  protected async onUserMessage(text: string): Promise<void> {
    // Check for topic change if we have enough context
    if (this.context.length >= 2) {
      // Capture snapshot BEFORE async calls to prevent race conditions
      const contextSnapshot = [...this.context];
      const { isTopicChange } = await detectTopicChange({
        context: formatConversation(contextSnapshot),
        newMessage: text,
      });
      if (isTopicChange) {
        // Resolve the triggering message BEFORE resetting context
        const resolved = await this.resolveToStandalone(text, contextSnapshot);
        this.context = [`User: ${resolved}`];
        return;
      }
    }

    this.context.push(`User: ${text}`);
  }

  /**
   * Return all context in current topic segment.
   */
  protected getContextSnapshot(): string[] {
    return [...this.context];
  }

  /**
   * Resolve a context-dependent message into a standalone question.
   * Called when topic change is detected to preserve the meaning of
   * the triggering message before context is reset.
   * @param text - The user message to resolve
   * @param contextSnapshot - Snapshot of context captured before this async call
   */
  private async resolveToStandalone(
    text: string,
    contextSnapshot: string[],
  ): Promise<string> {
    const output = await resolveContext({
      conversation: formatConversation([...contextSnapshot, `User: ${text}`]),
      sql: '', // No SQL yet, just resolving the question
    });

    return output.question;
  }
}
