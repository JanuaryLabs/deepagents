import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { type UIMessage, generateId, simulateReadableStream, tool } from 'ai';
import {
  MockLanguageModelV4,
  convertReadableStreamToArray as drain,
} from 'ai/test';
import { InMemoryFs } from 'just-bash';
import assert from 'node:assert';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { z } from 'zod';

import {
  ContextEngine,
  InMemoryContextStore,
  agent,
  chat,
  createBashTool,
  createVirtualSandbox,
  reminder,
  toolCallCount,
} from '@deepagents/context';
import { createFileTelemetry } from '@deepagents/context/telemetry/file';

const testUsage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
} as const;

const STEER = 'YOU-HAVE-CALLED-BASH-REPEATEDLY';

/** One user turn in which the model calls `bash` four times, then answers. */
function scriptedModel(): MockLanguageModelV4 {
  const script = ['bash', 'bash', 'bash', 'bash', 'done'] as const;
  const model: MockLanguageModelV4 = new MockLanguageModelV4({
    doStream: async () => {
      const call = model.doStreamCalls.length;
      const spec = script[Math.min(call - 1, script.length - 1)];
      const chunks: LanguageModelV4StreamPart[] =
        spec === 'done'
          ? [
              { type: 'text-start', id: 'd' },
              { type: 'text-delta', id: 'd', delta: 'done' },
              { type: 'text-end', id: 'd' },
            ]
          : [
              {
                type: 'tool-call',
                toolCallId: `c${call}`,
                toolName: 'bash',
                input: JSON.stringify({ cmd: 'echo hi' }),
              },
            ];
      chunks.push({
        type: 'finish',
        finishReason: {
          unified: spec === 'done' ? 'stop' : 'tool-calls',
          raw: '',
        },
        usage: testUsage,
      });
      return { stream: simulateReadableStream({ chunks }) };
    },
  });
  return model;
}

describe('steer reminders and in-turn history', () => {
  it('sees tool calls the model makes later in the same turn', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'deepagents-steer-live-'));
    const path = join(directory, 'ai.jsonl');
    try {
      const context = new ContextEngine({
        store: new InMemoryContextStore(),
        chatId: 'steer-live',
        userId: 'u1',
      });
      const chatAgent = agent({
        name: 'steer-live',
        context,
        model: scriptedModel(),
        sandbox: await createBashTool({
          sandbox: await createVirtualSandbox({ fs: new InMemoryFs() }),
        }),
        tools: {
          bash: tool({
            description: 'run a shell command',
            inputSchema: z.object({ cmd: z.string() }),
            execute: async () => ({ ok: true }),
          }),
        },
        telemetry: {
          integrations: createFileTelemetry({ path, includeTimestamp: false }),
        },
      });

      // The model calls bash 4 times in this ONE turn. A steer reminder gated on
      // "bash called at least twice" must therefore fire before the turn ends.
      context.set(
        reminder(STEER, {
          when: toolCallCount('bash', { gte: 2 }),
          target: 'steer',
        }),
      );

      await context.continue({
        id: generateId(),
        role: 'user',
        parts: [{ type: 'text', text: 'run bash a few times' }],
      } satisfies UIMessage);
      await drain(await chat(chatAgent));

      const fired = (await readFile(path, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { event: string; data: unknown })
        .filter((record) => record.event === 'onLanguageModelCallStart')
        .some((record) => JSON.stringify(record.data).includes(STEER));

      assert.strictEqual(
        fired,
        true,
        'steer reminder never fired: its WhenContext is cached once per stream ' +
          '(engine.ts #steerWhenCtx), so lastAssistantMessage is frozen at the ' +
          'first step boundary and cannot observe the 2nd/3rd/4th bash call of ' +
          'the same turn.',
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
