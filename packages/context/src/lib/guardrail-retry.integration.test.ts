import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { type UIMessage, generateId, simulateReadableStream, tool } from 'ai';
import {
  MockLanguageModelV4,
  convertReadableStreamToArray as drain,
} from 'ai/test';
import { InMemoryFs } from 'just-bash';
import assert from 'node:assert';
import { describe, it } from 'node:test';
import { z } from 'zod';

import {
  ContextEngine,
  type Guardrail,
  InMemoryContextStore,
  agent,
  chat,
  createBashTool,
  createVirtualSandbox,
  fail,
  pass,
} from '@deepagents/context';

const testUsage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
} as const;

type StepSpec = { tool: string } | { text: string };

function scriptedModel(steps: StepSpec[]): MockLanguageModelV4 {
  const model: MockLanguageModelV4 = new MockLanguageModelV4({
    doStream: async () => {
      const call = model.doStreamCalls.length;
      const spec = steps[Math.min(call - 1, steps.length - 1)];
      const id = `s${call}`;
      const chunks: LanguageModelV4StreamPart[] = [];
      if ('text' in spec) {
        chunks.push(
          { type: 'text-start', id },
          { type: 'text-delta', id, delta: spec.text },
          { type: 'text-end', id },
        );
      } else {
        chunks.push({
          type: 'tool-call',
          toolCallId: `c${call}`,
          toolName: spec.tool,
          input: '{}',
        });
      }
      chunks.push({
        type: 'finish',
        finishReason: {
          unified: 'tool' in spec ? 'tool-calls' : 'stop',
          raw: '',
        },
        usage: testUsage,
      });
      return { stream: simulateReadableStream({ chunks }) };
    },
  });
  return model;
}

describe('guardrail retry persistence', () => {
  it('leaves no unterminated or empty text part in the persisted assistant message', async () => {
    const context = new ContextEngine({
      store: new InMemoryContextStore(),
      chatId: 'guardrail-parts',
      userId: 'u1',
    });
    const model = scriptedModel([
      { text: 'rejected answer' },
      { tool: 'noop' },
      { text: 'final answer' },
    ]);

    let rejected = false;
    const failFirstText: Guardrail = {
      id: 'fail-first-text',
      name: 'fail-first-text',
      handle: (part) => {
        if (part.type === 'text-delta' && !rejected) {
          rejected = true;
          return fail('retry with another tool');
        }
        return pass(part);
      },
    };

    const chatAgent = agent({
      name: 'guardrail-parts',
      context,
      model,
      sandbox: await createBashTool({
        sandbox: await createVirtualSandbox({ fs: new InMemoryFs() }),
      }),
      tools: {
        noop: tool({
          description: 'noop',
          inputSchema: z.object({}),
          execute: async () => ({ ok: true }),
        }),
      },
      guardrails: [failFirstText],
    });

    await context.continue({
      id: generateId(),
      role: 'user',
      parts: [{ type: 'text', text: 'answer me' }],
    } satisfies UIMessage);
    await drain(
      await chat(chatAgent, { transform: () => new TransformStream() }),
    );

    const textParts = (await context.getMessages())
      .filter((message) => message.role === 'assistant')
      .flatMap((message) => message.parts)
      .filter((part) => part.type === 'text');

    assert.deepStrictEqual(
      textParts.filter((part) => part.state !== 'done'),
      [],
      'a guardrail-rejected generation left a text part open (state !== "done"); ' +
        'text-start was forwarded to the writer before the guardrail rejected the ' +
        'first delta, and the part is never closed',
    );
    assert.deepStrictEqual(
      textParts.filter((part) => part.text.trim().length === 0),
      [],
      'a guardrail-rejected generation persisted an empty text part',
    );
  });
});
