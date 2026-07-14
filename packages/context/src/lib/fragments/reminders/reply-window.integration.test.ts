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
  everyOfLastN,
  reminder,
  toolFailed,
  toolOutput,
} from '@deepagents/context';
import { createFileTelemetry } from '@deepagents/context/telemetry/file';

const testUsage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
} as const;

const STREAK = 'THREE-REPLIES-OF-FAILING-BASH';

/** Each user turn: the model calls a failing `bash` three times, then answers. */
function scriptedModel(): MockLanguageModelV4 {
  const perTurn = ['bash', 'bash', 'bash', 'done'] as const;
  const model: MockLanguageModelV4 = new MockLanguageModelV4({
    doStream: async () => {
      const call = model.doStreamCalls.length;
      const spec = perTurn[(call - 1) % perTurn.length];
      const chunks: LanguageModelV4StreamPart[] =
        spec === 'done'
          ? [
              { type: 'text-start', id: `d${call}` },
              { type: 'text-delta', id: `d${call}`, delta: 'done' },
              { type: 'text-end', id: `d${call}` },
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

/**
 * Run `turns` user turns and report whether an `everyOfLastN(3, toolFailed)`
 * steer reminder ever reached the model. `withNoise` registers an UNRELATED
 * tool-output reminder, whose firing carves each reply into several segments.
 */
async function streakFired(
  turns: number,
  withNoise: boolean,
): Promise<boolean> {
  const directory = await mkdtemp(join(tmpdir(), 'deepagents-reply-'));
  const path = join(directory, 'ai.jsonl');
  try {
    const context = new ContextEngine({
      store: new InMemoryContextStore(),
      chatId: `reply-${turns}-${withNoise}`,
      userId: 'u1',
    });
    const chatAgent = agent({
      name: 'reply',
      context,
      model: scriptedModel(),
      sandbox: await createBashTool({
        sandbox: await createVirtualSandbox({ fs: new InMemoryFs() }),
      }),
      tools: {
        bash: tool({
          description: 'run a shell command',
          inputSchema: z.object({ cmd: z.string() }),
          execute: async (): Promise<{ ok: boolean }> => {
            throw new Error('bash: not found');
          },
        }),
      },
      telemetry: {
        integrations: createFileTelemetry({ path, includeTimestamp: false }),
      },
    });

    context.set(
      reminder(STREAK, {
        when: everyOfLastN(3, toolFailed('bash')),
        target: 'steer',
      }),
    );
    if (withNoise) {
      context.set(
        reminder('UNRELATED-NOISE', {
          when: toolOutput({ name: 'bash', state: 'output-error' }),
          target: 'tool-output',
        }),
      );
    }

    for (let turn = 0; turn < turns; turn++) {
      await context.continue({
        id: generateId(),
        role: 'user',
        parts: [{ type: 'text', text: `turn ${turn}` }],
      } satisfies UIMessage);
      await drain(await chat(chatAgent));
    }

    return (await readFile(path, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { event: string; data: unknown })
      .filter((record) => record.event === 'onLanguageModelCallStart')
      .some((record) => JSON.stringify(record.data).includes(STREAK));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe('window predicates count replies, not segments', () => {
  it('gives the same answer whether or not an unrelated reminder is carving the reply', async () => {
    const quiet = await streakFired(1, false);
    const noisy = await streakFired(1, true);

    assert.strictEqual(quiet, false, 'one reply is not three replies');
    assert.strictEqual(
      noisy,
      quiet,
      'registering an unrelated tool-output reminder carved the single reply ' +
        'into several assistant messages, and everyOfLastN(3, ...) counted ' +
        'those instead of replies — so it fired on a single reply',
    );
  });

  it('still fires once three real replies have each failed bash', async () => {
    assert.strictEqual(
      await streakFired(3, true),
      true,
      'three genuine replies, each failing bash, must satisfy everyOfLastN(3)',
    );
  });
});
