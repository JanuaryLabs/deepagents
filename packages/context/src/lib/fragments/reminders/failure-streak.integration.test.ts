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
  toolFailedStreak,
  toolFailureStreak,
} from '@deepagents/context';
import { createFileTelemetry } from '@deepagents/context/telemetry/file';

const testUsage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
} as const;

/** bash 5x (4 fail, 5th succeeds), then a final text step. */
function scriptedModel(): MockLanguageModelV4 {
  const script = ['bash', 'bash', 'bash', 'bash', 'bash', 'done'] as const;
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
                input: JSON.stringify({ cmd: 'ls /nope' }),
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

/** The article's ReminderMiddleware, expressed with our primitives. */
function repeatedFailureReminder(name: string) {
  return reminder(
    (ctx) => {
      const count = toolFailureStreak(ctx, name);
      if (count === 1) return `${name} failed once: try another approach.`;
      if (count <= 3)
        return `${name} failed ${count} times in a row: change the command.`;
      return `${name} failed ${count} times in a row: STOP and explain the blocker.`;
    },
    {
      when: toolFailedStreak(name, { gte: 1 }),
      target: 'tool-output',
    },
  );
}

/** Reminder texts the model actually received, in the order it first saw them. */
function remindersInPrompts(jsonl: string): string[] {
  const seen: string[] = [];
  for (const line of jsonl.trim().split('\n')) {
    const record = JSON.parse(line) as { event: string; data: unknown };
    if (record.event !== 'onLanguageModelCallStart') continue;
    for (const match of JSON.stringify(record.data).matchAll(
      /<system-reminder>(.*?)<\\?\/system-reminder>/g,
    )) {
      if (!seen.includes(match[1])) seen.push(match[1]);
    }
  }
  return seen;
}

describe('tool-failure streak reminders', () => {
  it('escalates severity across consecutive failures and resets on success', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'deepagents-streak-'));
    const path = join(directory, 'ai.jsonl');
    try {
      let bashCalls = 0;
      const context = new ContextEngine({
        store: new InMemoryContextStore(),
        chatId: 'streak',
        userId: 'u1',
      });
      const model = scriptedModel();
      const chatAgent = agent({
        name: 'streak',
        context,
        model,
        sandbox: await createBashTool({
          sandbox: await createVirtualSandbox({ fs: new InMemoryFs() }),
        }),
        tools: {
          bash: tool({
            description: 'run a shell command',
            inputSchema: z.object({ cmd: z.string() }),
            execute: async () => {
              bashCalls++;
              if (bashCalls <= 4)
                throw new Error(`bash: not found #${bashCalls}`);
              return { ok: true };
            },
          }),
        },
        telemetry: {
          integrations: createFileTelemetry({ path, includeTimestamp: false }),
        },
      });
      context.set(repeatedFailureReminder('bash'));

      await context.continue({
        id: generateId(),
        role: 'user',
        parts: [{ type: 'text', text: 'list the files' }],
      } satisfies UIMessage);
      await drain(await chat(chatAgent));

      assert.strictEqual(bashCalls, 5, 'expected 4 failures then a success');
      assert.deepStrictEqual(
        remindersInPrompts(await readFile(path, 'utf8')),
        [
          'bash failed once: try another approach.',
          'bash failed 2 times in a row: change the command.',
          'bash failed 3 times in a row: change the command.',
          'bash failed 4 times in a row: STOP and explain the blocker.',
        ],
        'the successful 5th call must not add a 5th reminder',
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
