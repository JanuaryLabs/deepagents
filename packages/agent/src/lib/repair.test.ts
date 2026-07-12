import { simulateReadableStream, tool } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import assert from 'node:assert';
import { describe, it } from 'node:test';
import z from 'zod';

import { agent, execute, generate } from '@deepagents/agent';

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

function createRepairSequenceModel() {
  const model = new MockLanguageModelV4({
    doGenerate: async () => {
      if (model.doGenerateCalls.length === 1) {
        return {
          finishReason: { unified: 'tool-calls', raw: undefined },
          usage: testUsage,
          warnings: [],
          content: [
            {
              type: 'tool-call' as const,
              toolCallId: 'call-1',
              toolName: 'lookup_order',
              input: '{"orderId":42}',
            },
          ],
        };
      }

      if (model.doGenerateCalls.length === 2) {
        return {
          finishReason: { unified: 'stop', raw: '' },
          usage: testUsage,
          warnings: [],
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ orderId: '42' }),
            },
          ],
        };
      }

      return {
        finishReason: { unified: 'stop', raw: '' },
        usage: testUsage,
        warnings: [],
        content: [{ type: 'text' as const, text: 'done' }],
      };
    },
  });
  return model;
}

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

describe('repair tool calls', () => {
  it('passes the request abort signal to the repair call', async () => {
    const model = createRepairSequenceModel();
    const abortController = new AbortController();
    const assistant = agent({
      name: 'assistant',
      prompt: 'You help with orders.',
      model,
      tools: {
        lookup_order: tool({
          inputSchema: z.object({ orderId: z.string() }),
          execute: async ({ orderId }) => `order:${orderId}`,
        }),
      },
    });

    await generate(
      assistant,
      'Find order 42',
      {},
      {
        abortSignal: abortController.signal,
      },
    );

    assert.ok(model.doGenerateCalls.length >= 2);
    assert.strictEqual(
      model.doGenerateCalls[1]?.abortSignal,
      abortController.signal,
    );
  });

  it('passes the request abort signal to the repair call during streaming', async () => {
    const model = createRepairStreamingModel();
    const abortController = new AbortController();
    const assistant = agent({
      name: 'assistant',
      prompt: 'You help with orders.',
      model,
      tools: {
        lookup_order: tool({
          inputSchema: z.object({ orderId: z.string() }),
          execute: async ({ orderId }) => `order:${orderId}`,
        }),
      },
    });

    const result = await execute(
      assistant,
      'Find order 42',
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
