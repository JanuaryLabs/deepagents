import { groq } from '@ai-sdk/groq';
import type { LanguageModelV1, UIMessage } from 'ai';
import dedent from 'dedent';
import z from 'zod';

import { agent, generate, user } from '@deepagents/agent';
import { type ContextStore, InMemoryContextStore } from '@deepagents/context';

import type { Adapter } from '../../lib/adapters/adapter.ts';
import { Text2Sql } from '../../lib/sql.ts';

export interface ConversationSimulatorConfig {
  /** Database adapter to use */
  adapter: Adapter;
  /** Initial question to start the conversation */
  initialQuestion: string;
  /** Number of turns (including initial question) */
  turns: number;
  /** Model for Text2Sql (defaults to groq gpt-oss-20b) */
  model?: LanguageModelV1;
}

export interface SimulationResult {
  /** All messages from the conversation */
  messages: UIMessage[];
  /** The chat ID used */
  chatId: string;
  /** Questions that were asked (including follow-ups) */
  questions: string[];
}

/**
 * Agent that generates natural follow-up questions based on conversation context.
 */
const followUpAgent = agent<
  { question: string },
  { conversation: string; lastQuestion: string; lastResponse: string }
>({
  name: 'follow_up_generator',
  model: groq('openai/gpt-oss-20b'),
  output: z.object({
    question: z.string().describe('A natural follow-up question'),
  }),
  prompt: (state) => dedent`
    <identity>
      You are simulating a business user having a conversation with a database assistant.
      Generate natural, realistic follow-up questions.
    </identity>

    <conversation_so_far>
    ${state?.conversation || '(none)'}
    </conversation_so_far>

    <last_exchange>
    User: ${state?.lastQuestion}
    Assistant: ${state?.lastResponse}
    </last_exchange>

    <task>
      Generate a natural follow-up question that a business user might ask next.

      Good follow-ups:
      - Refine the query: "Sort that by revenue", "Filter to just the top 10"
      - Request different view: "Break it down by month", "Show me percentages instead"
      - Drill deeper: "What about just Q4?", "Show me the details for the first one"
      - Contextual references: "What about last year?", "Include the totals"

      The question should:
      - Feel natural and conversational
      - Reference the previous result implicitly or explicitly
      - Be something a business user would actually ask
    </task>
  `,
});

/**
 * Extract a summary of the assistant's response for follow-up generation.
 */
function summarizeResponse(message: UIMessage): string {
  const textParts = message.parts
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text);

  if (textParts.length > 0) {
    const fullText = textParts.join(' ');
    // Return first 500 chars as summary
    return fullText.length > 500 ? fullText.slice(0, 500) + '...' : fullText;
  }

  // Check for tool results
  const toolParts = message.parts.filter(
    (p) => p.type.startsWith('tool-') && 'state' in p,
  );
  if (toolParts.length > 0) {
    return `(executed ${toolParts.length} database queries)`;
  }

  return '(response received)';
}

/**
 * Build a conversation summary for the follow-up agent.
 */
function buildConversationSummary(messages: UIMessage[]): string {
  return messages
    .map((m) => {
      if (m.role === 'user') {
        const text = m.parts
          .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
          .map((p) => p.text)
          .join(' ');
        return `User: ${text}`;
      }
      return `Assistant: ${summarizeResponse(m)}`;
    })
    .join('\n');
}

/**
 * Create a UIMessage for a user question.
 */
function createUserMessage(question: string): UIMessage {
  return {
    id: `user-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    role: 'user',
    parts: [{ type: 'text', text: question }],
  };
}

/**
 * Drain the UI message stream to completion.
 *
 * The stream is an SSE-formatted ReadableStream. We don't need to parse it -
 * the Text2Sql.chat onFinish callback saves messages to history automatically.
 * We just need to consume the stream to allow completion.
 */
async function drainStream(
  streamPromise: ReturnType<typeof Text2Sql.prototype.chat>,
): Promise<void> {
  const stream = await streamPromise;
  const reader = stream.getReader();

  // Drain the stream - messages are saved to history via onFinish callback
  while (true) {
    const { done } = await reader.read();
    if (done) break;
  }
}

/**
 * Simulate a multi-turn conversation with Text2Sql.
 *
 * @example
 * ```typescript
 * const result = await simulateConversation({
 *   adapter: sqliteAdapter,
 *   initialQuestion: 'Show me all customers',
 *   turns: 3,
 * });
 *
 * // result.messages contains the full UIMessage[] history
 * const extractor = new FullContextExtractor(result.messages, adapter);
 * const pairs = await extractor.produce();
 * ```
 */
export async function simulateConversation(
  config: ConversationSimulatorConfig,
): Promise<SimulationResult> {
  const store = new InMemoryContextStore();
  const model = config.model ?? groq('gpt-oss-20b');
  const text2sql = new Text2Sql({
    version: `eval-simulator-${Date.now()}`,
    store,
    model,
    adapter: config.adapter,
  });

  const chatId = `eval-${Date.now()}`;
  const userId = 'eval-user';

  const questions: string[] = [];
  let currentQuestion = config.initialQuestion;

  for (let turn = 0; turn < config.turns; turn++) {
    questions.push(currentQuestion);

    // Create user message
    const userMessage = createUserMessage(currentQuestion);

    // Send to Text2Sql and drain the stream (messages saved to store via onFinish)
    const stream = text2sql.chat([userMessage], { chatId, userId });
    await drainStream(stream);

    // Generate follow-up for next turn (if not last)
    if (turn < config.turns - 1) {
      const allMessages = await getMessagesFromStore(store, chatId);
      const lastAssistant = allMessages.findLast((m) => m.role === 'assistant');

      const { experimental_output } = await generate(
        followUpAgent,
        [user('Generate a natural follow-up question.')],
        {
          conversation: buildConversationSummary(allMessages.slice(0, -1)),
          lastQuestion: currentQuestion,
          lastResponse: lastAssistant
            ? summarizeResponse(lastAssistant)
            : '(no response)',
        },
      );

      currentQuestion = experimental_output.question;
    }
  }

  // Retrieve final messages from store
  const messages = await getMessagesFromStore(store, chatId);

  return {
    messages,
    chatId,
    questions,
  };
}

/**
 * Helper to get UIMessages from the new ContextStore.
 */
async function getMessagesFromStore(
  store: ContextStore,
  chatId: string,
): Promise<UIMessage[]> {
  const branch = await store.getActiveBranch(chatId);
  if (!branch?.headMessageId) {
    return [];
  }

  const messageChain = await store.getMessageChain(branch.headMessageId);

  // Filter to only message types and convert to UIMessage
  return messageChain
    .filter(
      (m) =>
        m.type === 'message' || m.name === 'user' || m.name === 'assistant',
    )
    .map((m) => m.data as UIMessage);
}

/**
 * Simulate multiple independent conversations.
 *
 * @example
 * ```typescript
 * const results = await simulateMultipleConversations({
 *   adapter: sqliteAdapter,
 *   scenarios: [
 *     { initialQuestion: 'Show customers', turns: 3 },
 *     { initialQuestion: 'Total sales', turns: 2 },
 *   ],
 * });
 * ```
 */
export async function simulateMultipleConversations(config: {
  adapter: Adapter;
  scenarios: Array<{ initialQuestion: string; turns: number }>;
}): Promise<SimulationResult[]> {
  const results: SimulationResult[] = [];

  for (const scenario of config.scenarios) {
    const result = await simulateConversation({
      adapter: config.adapter,
      initialQuestion: scenario.initialQuestion,
      turns: scenario.turns,
    });
    results.push(result);
  }

  return results;
}
