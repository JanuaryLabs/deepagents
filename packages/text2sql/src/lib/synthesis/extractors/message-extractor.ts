/**
 * MessageExtractor - Extract pairs from chat history by parsing tool calls.
 *
 * Deterministic extraction: parses db_query tool calls and pairs them
 * with the preceding user message.
 */
import {
  type UIMessage,
  getToolOrDynamicToolName,
  isTextUIPart,
  isToolOrDynamicToolUIPart,
} from 'ai';

import type { ExtractedPair, PairProducer } from '../types.ts';

export interface MessageExtractorOptions {
  /** Include failed queries in output (default: false) */
  includeFailures?: boolean;
  /** Tool name to extract SQL from (default: 'db_query') */
  toolName?: string;
}

/** Shape of the db_query tool input */
interface DbQueryInput {
  sql: string;
  reasoning?: string;
}

/** Extract text content from a user message */
function getMessageText(message: UIMessage): string {
  const textParts = message.parts.filter(isTextUIPart).map((part) => part.text);

  return textParts.join(' ').trim();
}

export class MessageExtractor implements PairProducer {
  constructor(
    private messages: UIMessage[],
    private options: MessageExtractorOptions = {},
  ) {}

  async produce(): Promise<ExtractedPair[]> {
    const { includeFailures = false, toolName = 'db_query' } = this.options;
    const pairs: ExtractedPair[] = [];

    // Track the last user message as we iterate
    let lastUserMessage: UIMessage | null = null;

    for (const message of this.messages) {
      if (message.role === 'user') {
        lastUserMessage = message;
        continue;
      }

      if (message.role === 'assistant' && lastUserMessage) {
        // Look for db_query tool calls in this assistant message
        for (const part of message.parts) {
          if (!isToolOrDynamicToolUIPart(part)) {
            continue;
          }

          // Check if this is the tool we're looking for
          if (getToolOrDynamicToolName(part) !== toolName) {
            continue;
          }

          // Get the input - handle both static and dynamic tool parts
          const toolInput = ('input' in part ? part.input : undefined) as
            | DbQueryInput
            | undefined;
          if (!toolInput?.sql) {
            continue;
          }

          const success = part.state === 'output-available';
          const failed = part.state === 'output-error';

          // Skip failures if not including them
          if (failed && !includeFailures) {
            continue;
          }

          // Skip if still streaming or not yet executed
          if (!success && !failed) {
            continue;
          }

          const question = getMessageText(lastUserMessage);
          // Skip pairs with empty questions (e.g., image-only messages)
          if (!question) {
            continue;
          }

          pairs.push({
            question,
            sql: toolInput.sql,
            success,
          });
        }
      }
    }

    return pairs;
  }
}
