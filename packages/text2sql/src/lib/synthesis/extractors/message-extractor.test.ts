import type { UIMessage } from 'ai';
import assert from 'node:assert';
import { describe, it } from 'node:test';

import { MessageExtractor } from './message-extractor.ts';

/**
 * Helper to create a user message with text content.
 */
function createUserMessage(text: string): UIMessage {
  return {
    id: `user-${Date.now()}-${Math.random()}`,
    role: 'user',
    parts: [{ type: 'text', text }],
  };
}

/**
 * Helper to create an assistant message with a tool call.
 * Tool name is embedded in the type field as `tool-{toolName}`.
 * Uses `input` property to match real useChat structure.
 */
function createAssistantWithToolCall(
  sql: string,
  options: {
    toolName?: string;
    state?:
      | 'output-available'
      | 'output-error'
      | 'input-streaming'
      | 'input-available'
      | 'call';
    reasoning?: string;
  } = {},
): UIMessage {
  const {
    toolName = 'db_query',
    state = 'output-available',
    reasoning,
  } = options;

  return {
    id: `assistant-${Date.now()}-${Math.random()}`,
    role: 'assistant',
    parts: [
      {
        type: `tool-${toolName}`,
        toolCallId: `tool-${Date.now()}`,
        state,
        input: { sql, reasoning },
      },
    ],
  } as UIMessage;
}

/**
 * Helper to create an assistant message with text only.
 */
function createAssistantTextMessage(text: string): UIMessage {
  return {
    id: `assistant-${Date.now()}-${Math.random()}`,
    role: 'assistant',
    parts: [{ type: 'text', text }],
  };
}

describe('MessageExtractor', () => {
  describe('basic extraction', () => {
    it('should extract a single question/SQL pair', async () => {
      const messages: UIMessage[] = [
        createUserMessage('How many users are there?'),
        createAssistantWithToolCall('SELECT COUNT(*) FROM users'),
      ];

      const extractor = new MessageExtractor(messages);
      const pairs = await extractor.produce();

      assert.strictEqual(pairs.length, 1);
      assert.strictEqual(pairs[0].question, 'How many users are there?');
      assert.strictEqual(pairs[0].sql, 'SELECT COUNT(*) FROM users');
      assert.strictEqual(pairs[0].success, true);
    });

    it('should extract multiple question/SQL pairs', async () => {
      const messages: UIMessage[] = [
        createUserMessage('How many users are there?'),
        createAssistantWithToolCall('SELECT COUNT(*) FROM users'),
        createUserMessage('Show me the top 5 products'),
        createAssistantWithToolCall('SELECT * FROM products LIMIT 5'),
      ];

      const extractor = new MessageExtractor(messages);
      const pairs = await extractor.produce();

      assert.strictEqual(pairs.length, 2);
      assert.strictEqual(pairs[0].question, 'How many users are there?');
      assert.strictEqual(pairs[0].sql, 'SELECT COUNT(*) FROM users');
      assert.strictEqual(pairs[1].question, 'Show me the top 5 products');
      assert.strictEqual(pairs[1].sql, 'SELECT * FROM products LIMIT 5');
    });

    it('should handle multiple tool calls in single assistant message', async () => {
      const messages: UIMessage[] = [
        createUserMessage('Get user count and product count'),
        {
          id: 'assistant-1',
          role: 'assistant',
          parts: [
            {
              type: 'tool-db_query',
              toolCallId: 'tool-1',
              state: 'output-available',
              input: { sql: 'SELECT COUNT(*) FROM users' },
            },
            {
              type: 'tool-db_query',
              toolCallId: 'tool-2',
              state: 'output-available',
              input: { sql: 'SELECT COUNT(*) FROM products' },
            },
          ],
        },
      ];

      const extractor = new MessageExtractor(messages);
      const pairs = await extractor.produce();

      assert.strictEqual(pairs.length, 2);
      assert.strictEqual(pairs[0].sql, 'SELECT COUNT(*) FROM users');
      assert.strictEqual(pairs[1].sql, 'SELECT COUNT(*) FROM products');
      // Both should have the same question since they share the user message
      assert.strictEqual(pairs[0].question, 'Get user count and product count');
      assert.strictEqual(pairs[1].question, 'Get user count and product count');
    });
  });

  describe('failure handling', () => {
    it('should skip failed queries by default', async () => {
      const messages: UIMessage[] = [
        createUserMessage('How many users are there?'),
        createAssistantWithToolCall('SELECT COUNT(*) FROM userz', {
          state: 'output-error',
        }),
      ];

      const extractor = new MessageExtractor(messages);
      const pairs = await extractor.produce();

      assert.strictEqual(pairs.length, 0);
    });

    it('should include failed queries when includeFailures is true', async () => {
      const messages: UIMessage[] = [
        createUserMessage('How many users are there?'),
        createAssistantWithToolCall('SELECT COUNT(*) FROM userz', {
          state: 'output-error',
        }),
      ];

      const extractor = new MessageExtractor(messages, {
        includeFailures: true,
      });
      const pairs = await extractor.produce();

      assert.strictEqual(pairs.length, 1);
      assert.strictEqual(pairs[0].success, false);
      assert.strictEqual(pairs[0].sql, 'SELECT COUNT(*) FROM userz');
    });

    it('should mix successful and failed queries when includeFailures is true', async () => {
      const messages: UIMessage[] = [
        createUserMessage('How many users are there?'),
        createAssistantWithToolCall('SELECT COUNT(*) FROM userz', {
          state: 'output-error',
        }),
        createUserMessage('Show me products'),
        createAssistantWithToolCall('SELECT * FROM products'),
      ];

      const extractor = new MessageExtractor(messages, {
        includeFailures: true,
      });
      const pairs = await extractor.produce();

      assert.strictEqual(pairs.length, 2);
      assert.strictEqual(pairs[0].success, false);
      assert.strictEqual(pairs[1].success, true);
    });
  });

  describe('tool state handling', () => {
    it('should skip input-streaming tool calls', async () => {
      const messages: UIMessage[] = [
        createUserMessage('How many users are there?'),
        createAssistantWithToolCall('SELECT COUNT(*) FROM users', {
          state: 'input-streaming',
        }),
      ];

      const extractor = new MessageExtractor(messages);
      const pairs = await extractor.produce();

      assert.strictEqual(pairs.length, 0);
    });

    it('should skip input-available tool calls (not yet executed)', async () => {
      const messages: UIMessage[] = [
        createUserMessage('How many users are there?'),
        createAssistantWithToolCall('SELECT COUNT(*) FROM users', {
          state: 'input-available',
        }),
      ];

      const extractor = new MessageExtractor(messages);
      const pairs = await extractor.produce();

      assert.strictEqual(pairs.length, 0);
    });

    it('should skip call state tool calls', async () => {
      const messages: UIMessage[] = [
        createUserMessage('How many users are there?'),
        createAssistantWithToolCall('SELECT COUNT(*) FROM users', {
          state: 'call',
        }),
      ];

      const extractor = new MessageExtractor(messages);
      const pairs = await extractor.produce();

      assert.strictEqual(pairs.length, 0);
    });
  });

  describe('custom tool name', () => {
    it('should extract from custom tool name', async () => {
      const messages: UIMessage[] = [
        createUserMessage('How many users are there?'),
        createAssistantWithToolCall('SELECT COUNT(*) FROM users', {
          toolName: 'execute_sql',
        }),
      ];

      const extractor = new MessageExtractor(messages, {
        toolName: 'execute_sql',
      });
      const pairs = await extractor.produce();

      assert.strictEqual(pairs.length, 1);
      assert.strictEqual(pairs[0].sql, 'SELECT COUNT(*) FROM users');
    });

    it('should ignore tool calls with different tool name', async () => {
      const messages: UIMessage[] = [
        createUserMessage('How many users are there?'),
        createAssistantWithToolCall('SELECT COUNT(*) FROM users', {
          toolName: 'other_tool',
        }),
      ];

      const extractor = new MessageExtractor(messages);
      const pairs = await extractor.produce();

      assert.strictEqual(pairs.length, 0);
    });
  });

  describe('message text extraction', () => {
    it('should handle user message with multiple text parts', async () => {
      const messages: UIMessage[] = [
        {
          id: 'user-1',
          role: 'user',
          parts: [
            { type: 'text', text: 'Hello!' },
            { type: 'text', text: 'How many users are there?' },
          ],
        },
        createAssistantWithToolCall('SELECT COUNT(*) FROM users'),
      ];

      const extractor = new MessageExtractor(messages);
      const pairs = await extractor.produce();

      assert.strictEqual(pairs.length, 1);
      assert.strictEqual(pairs[0].question, 'Hello! How many users are there?');
    });

    it('should handle user message with mixed part types', async () => {
      const messages: UIMessage[] = [
        {
          id: 'user-1',
          role: 'user',
          parts: [
            { type: 'text', text: 'Count users please' },
            { type: 'image', image: 'base64data' } as unknown as {
              type: 'text';
              text: string;
            },
          ],
        },
        createAssistantWithToolCall('SELECT COUNT(*) FROM users'),
      ];

      const extractor = new MessageExtractor(messages);
      const pairs = await extractor.produce();

      assert.strictEqual(pairs.length, 1);
      assert.strictEqual(pairs[0].question, 'Count users please');
    });

    it('should skip pairs with empty questions (image-only messages)', async () => {
      const messages: UIMessage[] = [
        {
          id: 'user-1',
          role: 'user',
          parts: [
            { type: 'image', image: 'base64data' } as unknown as {
              type: 'text';
              text: string;
            },
          ],
        },
        createAssistantWithToolCall('SELECT COUNT(*) FROM users'),
      ];

      const extractor = new MessageExtractor(messages);
      const pairs = await extractor.produce();

      assert.strictEqual(pairs.length, 0);
    });

    it('should trim whitespace from extracted text', async () => {
      const messages: UIMessage[] = [
        {
          id: 'user-1',
          role: 'user',
          parts: [{ type: 'text', text: '  How many users?  ' }],
        },
        createAssistantWithToolCall('SELECT COUNT(*) FROM users'),
      ];

      const extractor = new MessageExtractor(messages);
      const pairs = await extractor.produce();

      assert.strictEqual(pairs[0].question, 'How many users?');
    });
  });

  describe('edge cases', () => {
    it('should return empty array for empty messages', async () => {
      const extractor = new MessageExtractor([]);
      const pairs = await extractor.produce();

      assert.strictEqual(pairs.length, 0);
    });

    it('should skip tool calls without sql in input', async () => {
      const messages: UIMessage[] = [
        createUserMessage('Do something'),
        {
          id: 'assistant-1',
          role: 'assistant',
          parts: [
            {
              type: 'tool-db_query',
              toolCallId: 'tool-1',
              state: 'output-available',
              input: { reasoning: 'no sql here' },
            },
          ],
        } as UIMessage,
      ];

      const extractor = new MessageExtractor(messages);
      const pairs = await extractor.produce();

      assert.strictEqual(pairs.length, 0);
    });

    it('should skip tool calls without input', async () => {
      const messages: UIMessage[] = [
        createUserMessage('Do something'),
        {
          id: 'assistant-1',
          role: 'assistant',
          parts: [
            {
              type: 'tool-db_query',
              toolCallId: 'tool-1',
              state: 'output-available',
            },
          ],
        } as UIMessage,
      ];

      const extractor = new MessageExtractor(messages);
      const pairs = await extractor.produce();

      assert.strictEqual(pairs.length, 0);
    });

    it('should skip assistant messages without preceding user message', async () => {
      const messages: UIMessage[] = [
        createAssistantWithToolCall('SELECT COUNT(*) FROM users'),
      ];

      const extractor = new MessageExtractor(messages);
      const pairs = await extractor.produce();

      assert.strictEqual(pairs.length, 0);
    });

    it('should skip assistant text-only messages', async () => {
      const messages: UIMessage[] = [
        createUserMessage('Hello'),
        createAssistantTextMessage('Hi there! How can I help?'),
        createUserMessage('Count users'),
        createAssistantWithToolCall('SELECT COUNT(*) FROM users'),
      ];

      const extractor = new MessageExtractor(messages);
      const pairs = await extractor.produce();

      assert.strictEqual(pairs.length, 1);
      assert.strictEqual(pairs[0].question, 'Count users');
    });

    it('should use most recent user message for tool call', async () => {
      const messages: UIMessage[] = [
        createUserMessage('First question'),
        createAssistantTextMessage('Let me help'),
        createUserMessage('Actually, count users'),
        createAssistantWithToolCall('SELECT COUNT(*) FROM users'),
      ];

      const extractor = new MessageExtractor(messages);
      const pairs = await extractor.produce();

      assert.strictEqual(pairs.length, 1);
      assert.strictEqual(pairs[0].question, 'Actually, count users');
    });
  });
});
