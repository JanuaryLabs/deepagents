import { groq } from '@ai-sdk/groq';
import {
  type UIMessage,
  getToolOrDynamicToolName,
  isTextUIPart,
  isToolOrDynamicToolUIPart,
} from 'ai';
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
import { type ExtractedPair, PairProducer } from '../types.ts';

export interface DbQueryInput {
  sql: string;
  reasoning?: string;
}

export interface SqlWithContext {
  sql: string;
  success: boolean;
  conversationContext: string[];
}

export interface BaseContextualExtractorOptions {
  includeFailures?: boolean;
  toolName?: string;
}

const contextResolverSchema = z.object({
  question: z
    .string()
    .describe(
      'A standalone natural language question that the SQL query answers',
    ),
});

/**
 * Resolves a SQL query with conversation context into a standalone question.
 */
export async function resolveContext(params: {
  conversation: string;
  sql: string;
  introspection?: string;
}): Promise<{ question: string }> {
  const context = new ContextEngine({
    store: new InMemoryContextStore(),
    chatId: `context-resolver-${crypto.randomUUID()}`,
    userId: 'system',
  });

  context.set(
    persona({
      name: 'context_resolver',
      role: 'You are an expert at understanding conversational context and generating clear, standalone questions from multi-turn conversations.',
      objective:
        'Transform context-dependent messages into standalone questions that fully capture user intent',
    }),
    ...(params.introspection
      ? [fragment('database_schema', params.introspection)]
      : []),
    fragment('conversation', params.conversation),
    fragment('sql', params.sql),
    fragment(
      'task',
      dedent`
        Given the conversation above and the SQL query that was executed,
        generate a single, standalone natural language question that:
        1. Fully captures the user's intent without needing prior context
        2. Uses natural business language (not SQL terminology)
        3. Could be asked by someone who hasn't seen the conversation
        4. Accurately represents what the SQL query answers
      `,
    ),
    fragment(
      'examples',
      dedent`
        Conversation: "Show me customers" → "Filter to NY" → "Sort by revenue"
        SQL: SELECT * FROM customers WHERE region = 'NY' ORDER BY revenue DESC
        Question: "Show me customers in the NY region sorted by revenue"

        Conversation: "What were sales last month?" → "Break it down by category"
        SQL: SELECT category, SUM(amount) FROM sales WHERE date >= '2024-11-01' GROUP BY category
        Question: "What were sales by category for last month?"
      `,
    ),
    user('Generate a standalone question for this SQL query.'),
  );

  const resolverOutput = structuredOutput({
    model: groq('openai/gpt-oss-20b'),
    context,
    schema: contextResolverSchema,
  });

  return resolverOutput.generate();
}

export function getMessageText(message: UIMessage): string {
  const textParts = message.parts.filter(isTextUIPart).map((part) => part.text);
  return textParts.join(' ').trim();
}

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
export abstract class BaseContextualExtractor extends PairProducer {
  protected context: string[] = [];
  protected results: SqlWithContext[] = [];
  protected messages: UIMessage[];
  protected adapter: Adapter;
  protected options: BaseContextualExtractorOptions;

  constructor(
    messages: UIMessage[],
    adapter: Adapter,
    options: BaseContextualExtractorOptions = {},
  ) {
    super();
    this.messages = messages;
    this.adapter = adapter;
    this.options = options;
  }

  /**
   * Template method - defines the extraction algorithm skeleton.
   * Subclasses customize behavior via hooks, not by overriding this method.
   */
  async *produce(): AsyncGenerator<ExtractedPair[]> {
    // Reset state for each produce() invocation to prevent race conditions
    // if produce() is called multiple times concurrently
    this.context = [];
    this.results = [];

    const { includeFailures = false, toolName = 'db_query' } = this.options;

    // Step 1: Extract SQLs with context (calls hooks)
    await this.extractSqlsWithContext(toolName, includeFailures);

    if (this.results.length === 0) {
      return;
    }

    // Step 2: Get introspection for schema context
    // TODO: Update to use fragments and render them
    // const schemaFragments = await this.adapter.introspect();
    // const introspection = new XmlRenderer().render(schemaFragments);
    const introspection = '' as any; // Placeholder - synthesis needs to be updated to use fragments

    // Step 3: Resolve each SQL's context into a standalone question
    yield* this.resolveQuestions(introspection);
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
  protected async *resolveQuestions(
    introspection: string,
  ): AsyncGenerator<ExtractedPair[]> {
    for (const item of this.results) {
      const output = await resolveContext({
        conversation: formatConversation(item.conversationContext),
        sql: item.sql,
        introspection,
      });

      yield [
        {
          question: output.question,
          sql: item.sql,
          context: item.conversationContext,
          success: item.success,
        },
      ];
    }
  }

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
