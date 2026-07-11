import type { LanguageModelV4Prompt } from '@ai-sdk/provider';
import { type UIMessage, simulateReadableStream, tool } from 'ai';
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
  outputTokens: { total: 4, text: 4, reasoning: undefined },
} as const;

function toolResultOutputs(prompt: LanguageModelV4Prompt) {
  const outputs: unknown[] = [];
  for (const message of prompt) {
    if (message.role !== 'tool') continue;
    for (const part of message.content) {
      if (part.type === 'tool-result') outputs.push(part.output);
    }
  }
  return outputs;
}

describe('host-only tool output metadata', () => {
  it('uses default projections without replacing custom ones during replay', async () => {
    const inspect = tool({
      description: 'Inspect a resource',
      inputSchema: z.object({ id: z.string() }),
      execute: async ({ id }) => ({
        status: 'ready',
        meta: { requestId: `request-${id}` },
      }),
    });
    const echo = tool({
      description: 'Echo text',
      inputSchema: z.object({}),
      execute: async () => 'plain text',
    });
    const list = tool({
      description: 'List values',
      inputSchema: z.object({}),
      execute: async () => ['first', 'second'],
    });
    const custom = tool({
      description: 'Use a custom model projection',
      inputSchema: z.object({}),
      execute: async () => ({
        status: 'custom',
        meta: { requestId: 'custom-request' },
      }),
      toModelOutput: ({ output }) => ({
        type: 'text',
        value: `custom:${output.meta.requestId}`,
      }),
    });

    let capturedPrompt: LanguageModelV4Prompt = [];
    const model = new MockLanguageModelV4({
      doGenerate: async (options) => {
        capturedPrompt = options.prompt;
        return {
          finishReason: { unified: 'stop', raw: undefined },
          usage: testUsage,
          content: [{ type: 'text', text: 'The resource is ready.' }],
          warnings: [],
        };
      },
    });

    const assistant = agent({
      name: 'resource-agent',
      prompt: 'Inspect resources.',
      model,
      tools: { custom, echo, inspect, list },
    });
    const messages: UIMessage[] = [
      {
        id: 'user-1',
        role: 'user',
        parts: [{ type: 'text', text: 'Inspect resource 42.' }],
      },
      {
        id: 'assistant-1',
        role: 'assistant',
        parts: [
          {
            type: 'tool-inspect',
            toolCallId: 'call-inspect',
            state: 'output-available',
            input: { id: '42' },
            output: {
              status: 'ready',
              meta: { requestId: 'request-42' },
            },
          },
          {
            type: 'tool-echo',
            toolCallId: 'call-echo',
            state: 'output-available',
            input: {},
            output: 'plain text',
          },
          {
            type: 'tool-list',
            toolCallId: 'call-list',
            state: 'output-available',
            input: {},
            output: ['first', 'second'],
          },
          {
            type: 'tool-custom',
            toolCallId: 'call-custom',
            state: 'output-available',
            input: {},
            output: {
              status: 'custom',
              meta: { requestId: 'custom-request' },
            },
          },
        ] as UIMessage['parts'],
      },
      {
        id: 'user-2',
        role: 'user',
        parts: [{ type: 'text', text: 'What was its status?' }],
      },
    ];

    await generate(assistant, messages, {});

    assert.deepStrictEqual(toolResultOutputs(capturedPrompt), [
      { type: 'json', value: { status: 'ready' } },
      { type: 'text', value: 'plain text' },
      { type: 'json', value: ['first', 'second'] },
      { type: 'text', value: 'custom:custom-request' },
    ]);
  });

  it('keeps meta in streamed host output and hides it from the next step', async () => {
    const inspect = tool({
      description: 'Inspect a resource',
      inputSchema: z.object({ id: z.string() }),
      execute: async ({ id }) => ({
        status: 'ready',
        meta: { requestId: `request-${id}` },
      }),
    });
    const prompts: LanguageModelV4Prompt[] = [];
    let call = 0;
    const model = new MockLanguageModelV4({
      doStream: async (options) => {
        prompts.push(options.prompt);
        call++;
        const chunks: Record<string, unknown>[] =
          call === 1
            ? [
                {
                  type: 'tool-call',
                  toolCallId: 'call-inspect',
                  toolName: 'inspect',
                  input: JSON.stringify({ id: '42' }),
                },
                {
                  type: 'finish',
                  finishReason: { unified: 'tool-calls', raw: undefined },
                  usage: testUsage,
                },
              ]
            : [
                { type: 'text-start', id: 'text-1' },
                { type: 'text-delta', id: 'text-1', delta: 'Ready.' },
                { type: 'text-end', id: 'text-1' },
                {
                  type: 'finish',
                  finishReason: { unified: 'stop', raw: undefined },
                  usage: testUsage,
                },
              ];
        return {
          stream: simulateReadableStream({ chunks: chunks as never }),
          rawCall: { rawPrompt: undefined, rawSettings: {} },
        };
      },
    });
    const assistant = agent({
      name: 'streaming-resource-agent',
      prompt: 'Inspect resources.',
      model,
      tools: { inspect },
    });

    const result = await execute(assistant, 'Inspect resource 42.', {});
    const hostOutputs: unknown[] = [];
    for await (const part of result.fullStream) {
      if (part.type === 'tool-result') hostOutputs.push(part.output);
    }

    assert.deepStrictEqual(hostOutputs, [
      {
        status: 'ready',
        meta: { requestId: 'request-42' },
      },
    ]);
    assert.deepStrictEqual(toolResultOutputs(prompts[1]), [
      { type: 'json', value: { status: 'ready' } },
    ]);
  });
});
