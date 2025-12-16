import { groq } from '@ai-sdk/groq';
import type { UIMessage } from 'ai';
import dedent from 'dedent';
import z from 'zod';

import { agent, generate, user } from '@deepagents/agent';

import type { Adapter } from '../../adapters/adapter.ts';
import {
  BaseContextualExtractor,
  type BaseContextualExtractorOptions,
  contextResolverAgent,
  formatConversation,
} from './base-contextual-extractor.ts';

export type SegmentedContextExtractorOptions = BaseContextualExtractorOptions;

/** Agent that detects if a new message represents a topic change */
const topicChangeAgent = agent<
  { isTopicChange: boolean; reason: string },
  { context: string; newMessage: string }
>({
  name: 'topic_change_detector',
  model: groq('openai/gpt-oss-20b'),
  output: z.object({
    isTopicChange: z
      .boolean()
      .describe('Whether the new message represents a topic change'),
    reason: z.string().describe('Brief explanation for the decision'),
  }),
  prompt: (state) => dedent`
    <identity>
      You are an expert at understanding conversational flow and detecting topic changes.
    </identity>

    <conversation_context>
    ${state?.context || '(no prior context)'}
    </conversation_context>

    <new_message>
    ${state?.newMessage}
    </new_message>

    <task>
      Determine if the new message represents a significant topic change from the
      prior conversation context. A topic change occurs when:
      1. The user asks about a completely different entity/table/domain
      2. The user starts a new analytical question unrelated to prior discussion
      3. There's a clear shift in what data or metrics are being discussed

      NOT a topic change:
      - Follow-up questions refining the same query ("filter by...", "sort by...")
      - Questions about the same entities with different conditions
      - Requests for more details on the same topic
    </task>

    <examples>
      Context: "Show me customers in NY" → "Sort by revenue"
      New: "Filter to those with orders over $1000"
      Decision: NOT a topic change (still refining customer query)

      Context: "Show me customers in NY" → "Sort by revenue"
      New: "What were our total sales last quarter?"
      Decision: Topic change (shifted from customers to sales metrics)

      Context: "List all products"
      New: "How many orders did we have last month?"
      Decision: Topic change (products → orders/sales)
    </examples>
  `,
});

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
      const isTopicChange = await this.detectTopicChange(text, contextSnapshot);
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
   * Detect if a new message represents a topic change using LLM.
   * @param newMessage - The new user message to check
   * @param contextSnapshot - Snapshot of context captured before this async call
   */
  private async detectTopicChange(
    newMessage: string,
    contextSnapshot: string[],
  ): Promise<boolean> {
    const { experimental_output } = await generate(
      topicChangeAgent,
      [user('Determine if this is a topic change.')],
      {
        context: formatConversation(contextSnapshot),
        newMessage,
      },
    );

    return experimental_output.isTopicChange;
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
    const { experimental_output } = await generate(
      contextResolverAgent,
      [user('Generate a standalone question for this message.')],
      {
        conversation: formatConversation([...contextSnapshot, `User: ${text}`]),
        sql: '', // No SQL yet, just resolving the question
      },
    );

    return experimental_output.question;
  }
}
