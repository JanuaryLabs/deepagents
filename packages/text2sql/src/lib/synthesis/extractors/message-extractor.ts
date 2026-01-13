import {
  type UIMessage,
  getToolOrDynamicToolName,
  isToolOrDynamicToolUIPart,
} from 'ai';

import { type ExtractedPair, PairProducer } from '../types.ts';
import {
  type DbQueryInput,
  getMessageText,
} from './base-contextual-extractor.ts';

export interface MessageExtractorOptions {
  includeFailures?: boolean;
  toolName?: string;
}
/**
 * MessageExtractor - Extract pairs from chat history by parsing tool calls.
 *
 * Deterministic extraction: parses db_query tool calls and pairs them
 * with the preceding user message.
 */
export class MessageExtractor extends PairProducer {
  #messages: UIMessage[];
  #options: MessageExtractorOptions;

  /**
   * @param messages - Chat history to extract pairs from
   * @param options - Extraction configuration
   */
  constructor(messages: UIMessage[], options: MessageExtractorOptions = {}) {
    super();
    this.#messages = messages;
    this.#options = options;
  }

  /**
   * Extracts question-SQL pairs by parsing tool calls and pairing with user messages.
   * @returns Pairs extracted from db_query tool invocations
   */
  async *produce(): AsyncGenerator<ExtractedPair[]> {
    const { includeFailures = false, toolName = 'db_query' } = this.#options;
    let lastUserMessage: UIMessage | null = null;

    for (const message of this.#messages) {
      if (message.role === 'user') {
        lastUserMessage = message;
        continue;
      }

      if (message.role === 'assistant' && lastUserMessage) {
        for (const part of message.parts) {
          if (!isToolOrDynamicToolUIPart(part)) {
            continue;
          }

          if (getToolOrDynamicToolName(part) !== toolName) {
            continue;
          }

          // Handle both static and dynamic tool part shapes
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

          // Skip incomplete tool calls (streaming or pending)
          if (!success && !failed) {
            continue;
          }

          const question = getMessageText(lastUserMessage);
          if (!question) {
            continue;
          }

          yield [
            {
              question,
              sql: toolInput.sql,
              success,
            },
          ];
        }
      }
    }
  }
}
