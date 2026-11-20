import { tool } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import assert from 'node:assert';
import { describe, it } from 'node:test';
import z from 'zod';

import {
  ContextEngine,
  InMemoryContextStore,
  agent,
  user,
} from '@deepagents/context';

import { buildSandbox } from '../../test/helpers/build-sandbox.ts';
import {
  textResult,
  toolCallResult,
} from '../../test/helpers/stream-results.ts';
import { usage } from '../../test/helpers/usage.ts';

const sandbox = await buildSandbox();

function createRepairStreamingModel() {
  const model = new MockLanguageModelV4({
    doGenerate: {
      finishReason: { unified: 'stop', raw: '' },
      usage,
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
        return toolCallResult({
          toolCallId: 'call_1',
          toolName: 'lookup_order',
          input: '{"orderId":42}',
        });
      }

      return textResult('done');
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

    const { result } = await assistant.stream({
      abortSignal: abortController.signal,
      transform: () => new TransformStream(),
    });

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

  it('returns an unknown tool call to the model as an error naming the available tools, and the run continues', async () => {
    const model = new MockLanguageModelV4({
      doStream: async () => {
        if (model.doStreamCalls.length === 1) {
          return toolCallResult({
            toolCallId: 'call_ruby',
            toolName: 'ruby',
            input: '{"code":"puts 1"}',
          });
        }
        return textResult('recovered');
      },
    });
    const context = new ContextEngine({
      store: new InMemoryContextStore(),
      chatId: 'unknown-tool-test',
      userId: 'test-user',
    }).set(user('Run some code'));
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

    const { result } = await assistant.stream({
      transform: () => new TransformStream(),
    });
    let text = '';
    for await (const chunk of result.textStream) {
      text += chunk;
    }

    assert.strictEqual(text, 'recovered');
    assert.strictEqual(model.doStreamCalls.length, 2);
    const toolResults = model.doStreamCalls[1].prompt
      .filter((message) => message.role === 'tool')
      .flatMap((message) => message.content)
      .filter((part) => part.type === 'tool-result');
    assert.strictEqual(toolResults.length, 1);
    const [toolResult] = toolResults;
    assert.strictEqual(toolResult.toolCallId, 'call_ruby');
    assert.strictEqual(toolResult.toolName, 'ruby');
    assert.strictEqual(toolResult.output.type, 'error-text');
    assert.match(toolResult.output.value, /Available tools: [^.]*lookup_order/);
  });
});
