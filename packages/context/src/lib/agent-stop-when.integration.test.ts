import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';
import {
  type UIMessage,
  generateId,
  simulateReadableStream,
  stepCountIs,
  tool,
} from 'ai';
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
  InMemoryContextStore,
  agent,
  chat,
  createBashTool,
  createVirtualSandbox,
} from '@deepagents/context';

const testUsage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
} as const;

/** Always calls `noop`, so only `stopWhen` can end the loop. */
function alwaysToolCallingModel(): MockLanguageModelV4 {
  const model: MockLanguageModelV4 = new MockLanguageModelV4({
    doStream: async () => {
      const call = model.doStreamCalls.length;
      const chunks: LanguageModelV4StreamPart[] = [
        {
          type: 'tool-call',
          toolCallId: `c${call}`,
          toolName: 'noop',
          input: '{}',
        },
        {
          type: 'finish',
          finishReason: { unified: 'tool-calls', raw: '' },
          usage: testUsage,
        },
      ];
      return { stream: simulateReadableStream({ chunks }) };
    },
  });
  return model;
}

async function runWithStopWhen(
  stopWhen: Parameters<typeof agent>[0]['stopWhen'],
): Promise<number> {
  const context = new ContextEngine({
    store: new InMemoryContextStore(),
    chatId: `stop-${String(stopWhen)}-${generateId()}`,
    userId: 'u1',
  });
  const model = alwaysToolCallingModel();
  const chatAgent = agent({
    name: 'stop',
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
    ...(stopWhen ? { stopWhen } : {}),
  });

  await context.continue({
    id: generateId(),
    role: 'user',
    parts: [{ type: 'text', text: 'loop' }],
  } satisfies UIMessage);
  await drain(await chat(chatAgent));

  return model.doStreamCalls.length;
}

describe('agent stopWhen', () => {
  it('honours a caller-supplied stopWhen instead of the built-in ceiling', async () => {
    const steps = await runWithStopWhen(stepCountIs(3));

    assert.strictEqual(
      steps,
      3,
      'the model calls a tool forever; only stopWhen can end the loop, so a ' +
        'caller-supplied stepCountIs(3) must cap it at 3 model calls',
    );
  });

  it('falls back to the built-in ceiling when no stopWhen is given', async () => {
    const steps = await runWithStopWhen(undefined);

    assert.strictEqual(
      steps,
      200,
      'the default ceiling is isStepCount(200) and must be unchanged',
    );
  });
});
