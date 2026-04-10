import { simulateReadableStream, tool } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
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
  const calls: Array<{ abortSignal: AbortSignal | undefined }> = [];
  let callIndex = 0;

  return {
    calls,
    model: new MockLanguageModelV3({
      doGenerate: async ({ abortSignal }) => {
        calls.push({ abortSignal });

        if (callIndex++ === 0) {
          return {
            finishReason: { unified: 'tool-calls', raw: undefined },
            usage: testUsage,
            warnings: [],
            content: [
              {
                type: 'tool-call' as const,
                toolCallType: 'function' as const,
                toolCallId: 'call-1',
                toolName: 'lookup_order',
                input: '{"orderId":42}',
              },
            ],
          };
        }

        if (callIndex === 2) {
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
    }),
  };
}

function createRepairStreamingModel() {
  const repairCalls: Array<{ abortSignal: AbortSignal | undefined }> = [];
  let streamCallIndex = 0;

  return {
    repairCalls,
    model: new MockLanguageModelV3({
      doGenerate: async ({ abortSignal }) => {
        repairCalls.push({ abortSignal });

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
      },
      doStream: async () => {
        if (streamCallIndex++ === 0) {
          return {
            stream: simulateReadableStream({
              chunks: [
                {
                  type: 'tool-call' as const,
                  id: 'tc-1',
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
            rawCall: { rawPrompt: undefined, rawSettings: {} },
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
          rawCall: { rawPrompt: undefined, rawSettings: {} },
        };
      },
    }),
  };
}

describe('repair tool calls', () => {
  it('passes the request abort signal to the repair call', async () => {
    const { model, calls } = createRepairSequenceModel();
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

    assert.ok(calls.length >= 2);
    assert.strictEqual(calls[1]?.abortSignal, abortController.signal);
  });

  it('passes the request abort signal to the repair call during streaming', async () => {
    const { model, repairCalls } = createRepairStreamingModel();
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
    assert.strictEqual(repairCalls[0]?.abortSignal, abortController.signal);
  });
});
