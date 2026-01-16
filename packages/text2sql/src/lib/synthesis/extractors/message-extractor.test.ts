import type { UIMessage } from 'ai';
import assert from 'node:assert';
import { describe, it } from 'node:test';

import { MessageExtractor } from './message-extractor.ts';

type MessagePart = UIMessage['parts'][number];
type ToolPart = Extract<MessagePart, { type: `tool-${string}` }>;
type DynamicToolPart = Extract<MessagePart, { type: 'dynamic-tool' }>;
type ToolCallState =
  | 'output-available'
  | 'output-error'
  | 'input-streaming'
  | 'input-available';
type ToolExecutionOptions = {
  toolName?: string;
  toolCallId?: string;
  input?: Record<string, unknown> | undefined;
  reasoning?: string;
  output?: unknown;
  errorText?: string;
};

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
 * Helper to create an assistant message with parts.
 */
function createAssistantMessage(parts: UIMessage['parts']): UIMessage {
  return {
    id: `assistant-${Date.now()}-${Math.random()}`,
    role: 'assistant',
    parts,
  };
}

/**
 * Helper to create a tool call part.
 * Tool name is embedded in the type field as `tool-{toolName}`.
 * Uses `input` property to match real useChat structure.
 */
function createToolCall(
  state: ToolCallState,
  sql: string | undefined,
  options: ToolExecutionOptions = {},
): ToolPart {
  const {
    toolName = 'db_query',
    toolCallId = `tool-${Date.now()}`,
    input,
    reasoning,
    output,
    errorText,
  } = options;
  const toolType = `tool-${toolName}` as `tool-${string}`;
  const hasInput = Object.prototype.hasOwnProperty.call(options, 'input');
  const toolInput = hasInput ? input : { sql, reasoning };

  if (state === 'output-available') {
    return {
      type: toolType,
      toolCallId,
      state,
      input: toolInput,
      output: output ?? {},
    };
  }

  if (state === 'output-error') {
    return {
      type: toolType,
      toolCallId,
      state,
      input: toolInput,
      errorText: errorText ?? 'Tool execution failed',
    };
  }

  return {
    type: toolType,
    toolCallId,
    state,
    input: toolInput,
  };
}

function createOutputAvailableToolCall(
  sql: string | undefined,
  options: ToolExecutionOptions = {},
): ToolPart {
  return createToolCall('output-available', sql, options);
}

function createOutputErrorToolCall(
  sql: string | undefined,
  options: ToolExecutionOptions = {},
): ToolPart {
  return createToolCall('output-error', sql, options);
}

function createInputStreamingToolCall(
  sql: string | undefined,
  options: ToolExecutionOptions = {},
): ToolPart {
  return createToolCall('input-streaming', sql, options);
}

function createInputAvailableToolCall(
  sql: string | undefined,
  options: ToolExecutionOptions = {},
): ToolPart {
  return createToolCall('input-available', sql, options);
}

function createDynamicToolCallInputAvailable(
  input: Record<string, unknown>,
  options: { toolName?: string; toolCallId?: string } = {},
): DynamicToolPart {
  return {
    type: 'dynamic-tool',
    toolName: options.toolName ?? 'db_query',
    toolCallId: options.toolCallId ?? `tool-${Date.now()}`,
    state: 'input-available',
    input,
  };
}

/**
 * Helper to create an assistant message with text only.
 */
function createAssistantTextMessage(text: string): UIMessage {
  return createAssistantMessage([{ type: 'text', text }]);
}

describe('MessageExtractor', () => {
  describe('basic extraction', () => {
    it('should extract a single question/SQL pair', async () => {
      const messages: UIMessage[] = [
        createUserMessage('How many users are there?'),
        createAssistantMessage([
          createOutputAvailableToolCall('SELECT COUNT(*) FROM users'),
        ]),
      ];

      const extractor = new MessageExtractor(messages);
      const pairs = await extractor.toPairs();

      assert.strictEqual(pairs.length, 1);
      assert.strictEqual(pairs[0].question, 'How many users are there?');
      assert.strictEqual(pairs[0].sql, 'SELECT COUNT(*) FROM users');
      assert.strictEqual(pairs[0].success, true);
    });

    it('should extract multiple question/SQL pairs', async () => {
      const messages: UIMessage[] = [
        createUserMessage('How many users are there?'),
        createAssistantMessage([
          createOutputAvailableToolCall('SELECT COUNT(*) FROM users'),
        ]),
        createUserMessage('Show me the top 5 products'),
        createAssistantMessage([
          createOutputAvailableToolCall('SELECT * FROM products LIMIT 5'),
        ]),
      ];

      const extractor = new MessageExtractor(messages);
      const pairs = await extractor.toPairs();

      assert.strictEqual(pairs.length, 2);
      assert.strictEqual(pairs[0].question, 'How many users are there?');
      assert.strictEqual(pairs[0].sql, 'SELECT COUNT(*) FROM users');
      assert.strictEqual(pairs[1].question, 'Show me the top 5 products');
      assert.strictEqual(pairs[1].sql, 'SELECT * FROM products LIMIT 5');
    });

    it('should handle multiple tool calls in single assistant message', async () => {
      const messages: UIMessage[] = [
        createUserMessage('Get user count and product count'),
        createAssistantMessage([
          createOutputAvailableToolCall('SELECT COUNT(*) FROM users', {
            toolCallId: 'tool-1',
          }),
          createOutputAvailableToolCall('SELECT COUNT(*) FROM products', {
            toolCallId: 'tool-2',
          }),
        ]),
      ];

      const extractor = new MessageExtractor(messages);
      const pairs = await extractor.toPairs();

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
        createAssistantMessage([
          createOutputErrorToolCall('SELECT COUNT(*) FROM userz'),
        ]),
      ];

      const extractor = new MessageExtractor(messages);
      const pairs = await extractor.toPairs();

      assert.strictEqual(pairs.length, 0);
    });

    it('should include failed queries when includeFailures is true', async () => {
      const messages: UIMessage[] = [
        createUserMessage('How many users are there?'),
        createAssistantMessage([
          createOutputErrorToolCall('SELECT COUNT(*) FROM userz'),
        ]),
      ];

      const extractor = new MessageExtractor(messages, {
        includeFailures: true,
      });
      const pairs = await extractor.toPairs();

      assert.strictEqual(pairs.length, 1);
      assert.strictEqual(pairs[0].success, false);
      assert.strictEqual(pairs[0].sql, 'SELECT COUNT(*) FROM userz');
    });

    it('should mix successful and failed queries when includeFailures is true', async () => {
      const messages: UIMessage[] = [
        createUserMessage('How many users are there?'),
        createAssistantMessage([
          createOutputErrorToolCall('SELECT COUNT(*) FROM userz'),
        ]),
        createUserMessage('Show me products'),
        createAssistantMessage([
          createOutputAvailableToolCall('SELECT * FROM products'),
        ]),
      ];

      const extractor = new MessageExtractor(messages, {
        includeFailures: true,
      });
      const pairs = await extractor.toPairs();

      assert.strictEqual(pairs.length, 2);
      assert.strictEqual(pairs[0].success, false);
      assert.strictEqual(pairs[1].success, true);
    });
  });

  describe('tool state handling', () => {
    it('should skip input-streaming tool calls', async () => {
      const messages: UIMessage[] = [
        createUserMessage('How many users are there?'),
        createAssistantMessage([
          createInputStreamingToolCall('SELECT COUNT(*) FROM users'),
        ]),
      ];

      const extractor = new MessageExtractor(messages);
      const pairs = await extractor.toPairs();

      assert.strictEqual(pairs.length, 0);
    });

    it('should skip input-available tool calls (not yet executed)', async () => {
      const messages: UIMessage[] = [
        createUserMessage('How many users are there?'),
        createAssistantMessage([
          createInputAvailableToolCall('SELECT COUNT(*) FROM users'),
        ]),
      ];

      const extractor = new MessageExtractor(messages);
      const pairs = await extractor.toPairs();

      assert.strictEqual(pairs.length, 0);
    });

    it('should skip pending dynamic tool calls', async () => {
      const messages: UIMessage[] = [
        createUserMessage('How many users are there?'),
        createAssistantMessage([
          createDynamicToolCallInputAvailable(
            { sql: 'SELECT COUNT(*) FROM users' },
            { toolCallId: 'tool-1' },
          ),
        ]),
      ];

      const extractor = new MessageExtractor(messages);
      const pairs = await extractor.toPairs();

      assert.strictEqual(pairs.length, 0);
    });
  });

  describe('custom tool name', () => {
    it('should extract from custom tool name', async () => {
      const messages: UIMessage[] = [
        createUserMessage('How many users are there?'),
        createAssistantMessage([
          createOutputAvailableToolCall('SELECT COUNT(*) FROM users', {
            toolName: 'execute_sql',
          }),
        ]),
      ];

      const extractor = new MessageExtractor(messages, {
        toolName: 'execute_sql',
      });
      const pairs = await extractor.toPairs();

      assert.strictEqual(pairs.length, 1);
      assert.strictEqual(pairs[0].sql, 'SELECT COUNT(*) FROM users');
    });

    it('should ignore tool calls with different tool name', async () => {
      const messages: UIMessage[] = [
        createUserMessage('How many users are there?'),
        createAssistantMessage([
          createOutputAvailableToolCall('SELECT COUNT(*) FROM users', {
            toolName: 'other_tool',
          }),
        ]),
      ];

      const extractor = new MessageExtractor(messages);
      const pairs = await extractor.toPairs();

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
        createAssistantMessage([
          createOutputAvailableToolCall('SELECT COUNT(*) FROM users'),
        ]),
      ];

      const extractor = new MessageExtractor(messages);
      const pairs = await extractor.toPairs();

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
        createAssistantMessage([
          createOutputAvailableToolCall('SELECT COUNT(*) FROM users'),
        ]),
      ];

      const extractor = new MessageExtractor(messages);
      const pairs = await extractor.toPairs();

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
        createAssistantMessage([
          createOutputAvailableToolCall('SELECT COUNT(*) FROM users'),
        ]),
      ];

      const extractor = new MessageExtractor(messages);
      const pairs = await extractor.toPairs();

      assert.strictEqual(pairs.length, 0);
    });

    it('should trim whitespace from extracted text', async () => {
      const messages: UIMessage[] = [
        {
          id: 'user-1',
          role: 'user',
          parts: [{ type: 'text', text: '  How many users?  ' }],
        },
        createAssistantMessage([
          createOutputAvailableToolCall('SELECT COUNT(*) FROM users'),
        ]),
      ];

      const extractor = new MessageExtractor(messages);
      const pairs = await extractor.toPairs();

      assert.strictEqual(pairs[0].question, 'How many users?');
    });
  });

  describe('edge cases', () => {
    it('should return empty array for empty messages', async () => {
      const extractor = new MessageExtractor([]);
      const pairs = await extractor.toPairs();

      assert.strictEqual(pairs.length, 0);
    });

    it('should skip tool calls without sql in input', async () => {
      const messages: UIMessage[] = [
        createUserMessage('Do something'),
        createAssistantMessage([
          createOutputAvailableToolCall(undefined, {
            input: { reasoning: 'no sql here' },
          }),
        ]),
      ];

      const extractor = new MessageExtractor(messages);
      const pairs = await extractor.toPairs();

      assert.strictEqual(pairs.length, 0);
    });

    it('should skip tool calls without input', async () => {
      const messages: UIMessage[] = [
        createUserMessage('Do something'),
        createAssistantMessage([
          createOutputErrorToolCall(undefined, {
            input: undefined,
            errorText: 'Missing input',
          }),
        ]),
      ];

      const extractor = new MessageExtractor(messages);
      const pairs = await extractor.toPairs();

      assert.strictEqual(pairs.length, 0);
    });

    it('should skip assistant messages without preceding user message', async () => {
      const messages: UIMessage[] = [
        createAssistantMessage([
          createOutputAvailableToolCall('SELECT COUNT(*) FROM users'),
        ]),
      ];

      const extractor = new MessageExtractor(messages);
      const pairs = await extractor.toPairs();

      assert.strictEqual(pairs.length, 0);
    });

    it('should skip assistant text-only messages', async () => {
      const messages: UIMessage[] = [
        createUserMessage('Hello'),
        createAssistantTextMessage('Hi there! How can I help?'),
        createUserMessage('Count users'),
        createAssistantMessage([
          createOutputAvailableToolCall('SELECT COUNT(*) FROM users'),
        ]),
      ];

      const extractor = new MessageExtractor(messages);
      const pairs = await extractor.toPairs();

      assert.strictEqual(pairs.length, 1);
      assert.strictEqual(pairs[0].question, 'Count users');
    });

    it('should use most recent user message for tool call', async () => {
      const messages: UIMessage[] = [
        createUserMessage('First question'),
        createAssistantTextMessage('Let me help'),
        createUserMessage('Actually, count users'),
        createAssistantMessage([
          createOutputAvailableToolCall('SELECT COUNT(*) FROM users'),
        ]),
      ];

      const extractor = new MessageExtractor(messages);
      const pairs = await extractor.toPairs();

      assert.strictEqual(pairs.length, 1);
      assert.strictEqual(pairs[0].question, 'Actually, count users');
    });
  });
});
