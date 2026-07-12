import { simulateReadableStream, tool } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { InMemoryFs } from 'just-bash';
import assert from 'node:assert';
import { describe, it } from 'node:test';
import z from 'zod';

import {
  ContextEngine,
  InMemoryContextStore,
  agent,
  createBashTool,
  createVirtualSandbox,
  user,
} from '@deepagents/context';

const sandbox = await createBashTool({
  sandbox: await createVirtualSandbox({ fs: new InMemoryFs() }),
});

const testUsage = {
  inputTokens: {
    total: 3,
    noCache: 3,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: {
    total: 10,
    text: 10,
    reasoning: undefined,
  },
} as const;

function createRepairStreamingModel() {
  const model = new MockLanguageModelV4({
    doGenerate: {
      finishReason: { unified: 'stop', raw: '' },
      usage: testUsage,
      warnings: [],
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ orderId: '42' }),
        },
      ],
    },
    doStream: async () => {
      if (model.doStreamCalls.length === 1) {
        return {
          stream: simulateReadableStream({
            chunks: [
              {
                type: 'tool-call' as const,
                toolCallId: 'call_1',
                toolName: 'lookup_order',
                input: '{"orderId":42}',
              },
              {
                type: 'finish' as const,
                finishReason: { unified: 'tool-calls', raw: '' },
                usage: testUsage,
              },
            ],
          }),
        };
      }

      return {
        stream: simulateReadableStream({
          chunks: [
            { type: 'text-start' as const, id: 'text-2' },
            { type: 'text-delta' as const, id: 'text-2', delta: 'done' },
            { type: 'text-end' as const, id: 'text-2' },
            {
              type: 'finish' as const,
              finishReason: { unified: 'stop', raw: '' },
              usage: testUsage,
            },
          ],
        }),
      };
    },
  });
  return model;
}

describe('context agent repair tool calls', () => {
  it('passes the request abort signal to the repair call during streaming', async () => {
    const model = createRepairStreamingModel();
    const abortController = new AbortController();
    const context = new ContextEngine({
      store: new InMemoryContextStore(),
      chatId: 'repair-stream-test',
      userId: 'test-user',
    }).set(user('Find order 42'));

    const assistant = agent({
      sandbox,
      name: 'assistant',
      context,
      model,
      tools: {
        lookup_order: tool({
          inputSchema: z.object({ orderId: z.string() }),
          execute: async ({ orderId }) => `order:${orderId}`,
        }),
      },
    });

    const result = await assistant.stream(
      {},
      {
        abortSignal: abortController.signal,
        transform: () => new TransformStream(),
      },
    );

    let text = '';
    for await (const chunk of result.textStream) {
      text += chunk;
    }

    assert.strictEqual(text, 'done');
    assert.strictEqual(
      model.doGenerateCalls[0]?.abortSignal,
      abortController.signal,
    );
  });
});
