import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { tool } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { InMemoryFs } from 'just-bash';
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { z } from 'zod';

import {
  ContextEngine,
  InMemoryContextStore,
  agent,
  createBashTool,
  createVirtualSandbox,
  user,
} from '@deepagents/context';

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};
const toolCalls = { unified: 'tool-calls' as const, raw: undefined };
const stop = { unified: 'stop' as const, raw: undefined };

for (const mode of ['generate', 'stream'] as const) {
  it(`${mode} hands the agent's sandbox to user tools`, async () => {
    const toolkit = await createBashTool({
      sandbox: await createVirtualSandbox({ fs: new InMemoryFs() }),
    });
    await toolkit.sandbox.writeTextFile({
      path: '/tmp/marker.txt',
      content: 'from the agent sandbox',
    });
    const call = {
      type: 'tool-call' as const,
      toolCallId: 'inspect-1',
      toolName: 'inspect',
      input: '{}',
    };
    const model = new MockLanguageModelV4({
      doGenerate: [
        { content: [call], finishReason: toolCalls, usage, warnings: [] },
        {
          content: [{ type: 'text', text: 'done' }],
          finishReason: stop,
          usage,
          warnings: [],
        },
      ],
      doStream: [
        {
          stream: ReadableStream.from<LanguageModelV4StreamPart>([
            { type: 'tool-input-start', id: 'inspect-1', toolName: 'inspect' },
            { type: 'tool-input-delta', id: 'inspect-1', delta: '{}' },
            { type: 'tool-input-end', id: 'inspect-1' },
            call,
            { type: 'finish', finishReason: toolCalls, usage },
          ]),
        },
        {
          stream: ReadableStream.from<LanguageModelV4StreamPart>([
            { type: 'text-start', id: 'text-1' },
            { type: 'text-delta', id: 'text-1', delta: 'done' },
            { type: 'text-end', id: 'text-1' },
            { type: 'finish', finishReason: stop, usage },
          ]),
        },
      ],
    });
    let seen: string | undefined;
    const assistant = agent({
      name: 'sandbox-reader',
      model,
      context: new ContextEngine({
        store: new InMemoryContextStore(),
        chatId: `sandbox-reader-${mode}`,
        userId: 'user',
      }).set(user('Read the marker.')),
      sandbox: toolkit,
      tools: {
        inspect: tool({
          inputSchema: z.object({}),
          execute: async (_input, { experimental_sandbox }) => {
            const result = await experimental_sandbox?.run({
              command: 'cat /tmp/marker.txt',
            });
            seen = result?.stdout;
            return 'read';
          },
        }),
      },
    });

    if (mode === 'generate') {
      await assistant.generate();
    } else {
      const { result } = await assistant.stream();
      await Array.fromAsync(result.stream);
    }

    assert.equal(seen, 'from the agent sandbox');
  });
}
