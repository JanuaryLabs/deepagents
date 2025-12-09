/**
 * BaseContextualExtractor - Abstract base class for contextual extraction.
 *
 * Uses the Template Pattern to define the extraction algorithm skeleton,
 * with hooks for subclasses to customize context management.
 *
 * Subclasses:
 * - FullContextExtractor: Keeps all context
 * - WindowedContextExtractor: Keeps last N messages
 * - SegmentedContextExtractor: Resets on topic change
 */
import { groq } from '@ai-sdk/groq';
import {
  type UIMessage,
  getToolOrDynamicToolName,
  isTextUIPart,
  isToolOrDynamicToolUIPart,
} from 'ai';
import dedent from 'dedent';
import z from 'zod';

import { agent, generate, user } from '@deepagents/agent';

import type { Adapter } from '../../adapters/adapter.ts';
import type { ExtractedPair, PairProducer } from '../types.ts';

/** Shape of the db_query tool input */
export interface DbQueryInput {
  sql: string;
  reasoning?: string;
}

/** Intermediate representation of an extracted SQL with its context */
export interface SqlWithContext {
  sql: string;
  success: boolean;
  /** All messages up to and including the one that triggered this SQL */
  conversationContext: string[];
}

/** Base options for all contextual extractors */
export interface BaseContextualExtractorOptions {
  /** Include failed queries in output (default: false) */
  includeFailures?: boolean;
  /** Tool name to extract SQL from (default: 'db_query') */
  toolName?: string;
}

/** Agent that resolves context-dependent questions into standalone ones */
export const contextResolverAgent = agent<
  { question: string },
  { conversation: string; sql: string; introspection?: string }
>({
  name: 'context_resolver',
  model: groq('openai/gpt-oss-20b'),
  output: z.object({
    question: z
      .string()
      .describe(
        'A standalone natural language question that the SQL query answers',
      ),
  }),
  prompt: (state) => dedent`
    <identity>
      You are an expert at understanding conversational context and generating clear,
      standalone questions from multi-turn conversations.
    </identity>

    ${state?.introspection ? `<schema>\n${state.introspection}\n</schema>` : ''}

    <conversation>
    ${state?.conversation}
    </conversation>

    <sql>
    ${state?.sql}
    </sql>

    <task>
      Given the conversation above and the SQL query that was executed,
      generate a single, standalone natural language question that:
      1. Fully captures the user's intent without needing prior context
      2. Uses natural business language (not SQL terminology)
      3. Could be asked by someone who hasn't seen the conversation
      4. Accurately represents what the SQL query answers
    </task>

    <examples>
      Conversation: "Show me customers" → "Filter to NY" → "Sort by revenue"
      SQL: SELECT * FROM customers WHERE region = 'NY' ORDER BY revenue DESC
      Question: "Show me customers in the NY region sorted by revenue"

      Conversation: "What were sales last month?" → "Break it down by category"
      SQL: SELECT category, SUM(amount) FROM sales WHERE date >= '2024-11-01' GROUP BY category
      Question: "What were sales by category for last month?"
    </examples>
  `,
});

/** Extract text content from message parts */
export function getMessageText(message: UIMessage): string {
  const textParts = message.parts.filter(isTextUIPart).map((part) => part.text);
  return textParts.join(' ').trim();
}

/** Format conversation messages for the resolver agent */
export function formatConversation(messages: string[]): string {
  return messages.map((msg, i) => `[${i + 1}] ${msg}`).join('\n');
}

/**
 * Abstract base class for contextual extractors using Template Pattern.
 *
 * The `produce()` method defines the algorithm skeleton:
 * 1. Iterate through messages
 * 2. Call `onUserMessage()` hook for user messages
 * 3. Extract SQL from assistant messages using `getContextSnapshot()` hook
 * 4. Resolve questions using LLM
 *
 * Subclasses implement the hooks to customize context management.
 */
export abstract class BaseContextualExtractor implements PairProducer {
  protected context: string[] = [];
  protected results: SqlWithContext[] = [];

  constructor(
    protected messages: UIMessage[],
    protected adapter: Adapter,
    protected options: BaseContextualExtractorOptions = {},
  ) {}

  /**
   * Template method - defines the extraction algorithm skeleton.
   * Subclasses customize behavior via hooks, not by overriding this method.
   */
  async produce(): Promise<ExtractedPair[]> {
    const { includeFailures = false, toolName = 'db_query' } = this.options;

    // Step 1: Extract SQLs with context (calls hooks)
    await this.extractSqlsWithContext(toolName, includeFailures);

    if (this.results.length === 0) {
      return [];
    }

    // Step 2: Get introspection for schema context
    const introspection = await this.adapter.introspect();

    // Step 3: Resolve each SQL's context into a standalone question
    return this.resolveQuestions(introspection);
  }

  /**
   * Core extraction loop - iterates through messages and calls hooks.
   */
  private async extractSqlsWithContext(
    toolName: string,
    includeFailures: boolean,
  ): Promise<void> {
    for (const message of this.messages) {
      if (message.role === 'user') {
        const text = getMessageText(message);
        if (text) {
          await this.onUserMessage(text);
        }
        continue;
      }

      if (message.role === 'assistant') {
        await this.extractFromAssistant(message, toolName, includeFailures);
      }
    }
  }

  /**
   * Extract SQL from assistant message parts.
   */
  private async extractFromAssistant(
    message: UIMessage,
    toolName: string,
    includeFailures: boolean,
  ): Promise<void> {
    for (const part of message.parts) {
      if (!isToolOrDynamicToolUIPart(part)) {
        continue;
      }

      if (getToolOrDynamicToolName(part) !== toolName) {
        continue;
      }

      // Use 'input' property (not 'args') to match useChat structure
      const toolInput = ('input' in part ? part.input : undefined) as
        | DbQueryInput
        | undefined;
      if (!toolInput?.sql) {
        continue;
      }

      const success = part.state === 'output-available';
      const failed = part.state === 'output-error';

      if (failed && !includeFailures) {
        continue;
      }

      // Skip if still streaming or not yet executed
      if (!success && !failed) {
        continue;
      }

      const snapshot = this.getContextSnapshot();
      // Skip if no context available
      if (snapshot.length === 0) {
        continue;
      }

      this.results.push({
        sql: toolInput.sql,
        success,
        conversationContext: snapshot,
      });
    }

    // Add assistant text responses to context (for multi-turn understanding)
    const assistantText = getMessageText(message);
    if (assistantText) {
      this.context.push(`Assistant: ${assistantText}`);
    }
  }

  /**
   * Resolve extracted SQL contexts into standalone questions using LLM.
   */
  private async resolveQuestions(
    introspection: string,
  ): Promise<ExtractedPair[]> {
    const pairs: ExtractedPair[] = [];

    for (const item of this.results) {
      const { experimental_output } = await generate(
        contextResolverAgent,
        [user('Generate a standalone question for this SQL query.')],
        {
          conversation: formatConversation(item.conversationContext),
          sql: item.sql,
          introspection,
        },
      );

      pairs.push({
        question: experimental_output.question,
        sql: item.sql,
        context: item.conversationContext,
        success: item.success,
      });
    }

    return pairs;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // HOOKS - Subclasses override these to customize context management
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Hook called when a user message is encountered.
   * Subclasses implement this to decide how to update context.
   */
  protected abstract onUserMessage(text: string): Promise<void>;

  /**
   * Hook called when extracting SQL to get the current context snapshot.
   * Subclasses implement this to decide what context to include.
   */
  protected abstract getContextSnapshot(): string[];
}
