import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { TemporaryFiles } from '@zukhruf/fs';
import { waitFor } from '@zukhruf/testing/async';
import { isToolUIPart, simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';

import {
  AgentRuntime,
  EmbeddedAgentStorage,
  defineAgent,
  defineStack,
  defineTool,
} from '@deepagents/experimental/zukhruf';

import { buildSandbox } from '../../testing/build-sandbox.fixture.ts';
import { textResult } from '../../testing/stream-results.fixture.ts';
import { usage } from '../../testing/usage.fixture.ts';
import { userTurn } from '../../testing/user-turn.fixture.ts';

test('a partial approval answer records the denial without running the denied tool, and the unanswered sibling keeps waiting for its answer', async (t) => {
  await using resources = new AsyncDisposableStack();
  const directory = resources.use(
    await new TemporaryFiles().directory('zukhruf-'),
  );
  const storage = resources.use(
    await EmbeddedAgentStorage.open({ directory: directory.path }),
  );
  const sent: string[] = [];
  const model: MockLanguageModelV4 = new MockLanguageModelV4({
    doStream: async () => {
      if (model.doStreamCalls.length > 1) return textResult('noted');
      const chunks: LanguageModelV4StreamPart[] = [
        {
          type: 'tool-call',
          toolCallId: 'first-email',
          toolName: 'sendEmail',
          input: JSON.stringify({ to: 'first@example.com' }),
        },
        {
          type: 'tool-call',
          toolCallId: 'second-email',
          toolName: 'sendEmail',
          input: JSON.stringify({ to: 'second@example.com' }),
        },
        {
          type: 'finish',
          finishReason: { unified: 'tool-calls', raw: '' },
          usage,
        },
      ];
      return { stream: simulateReadableStream({ chunks }) };
    },
  });
  const runtime = resources.use(
    await new AgentRuntime(
      defineAgent({
        name: 'mailer',
        sandbox: buildSandbox(),
        instructions: [],
        toolApproval: { sendEmail: 'user-approval' },
        tools: {
          sendEmail: defineTool({
            description: 'Send an email',
            inputSchema: z.object({ to: z.string() }),
            execute: async ({ to }) => {
              sent.push(to);
              return `sent:${to}`;
            },
          }),
        },
        model,
      }),
    ).initialize(defineStack(async () => ({ storage }))),
  );
  await using _worker = await runtime.work();
  void _worker;
  const conversation = { chatId: 'partial-answer', userId: 'u1' };

  const ask = await runtime.enqueue(
    conversation,
    userTurn(crypto.randomUUID(), 'email both'),
  );
  await Array.fromAsync(ask.stream);
  const paused = (await runtime.observe(conversation).engine.getMessages()).at(
    -1,
  );
  assert.ok(paused?.role === 'assistant');
  const continuation = await runtime.enqueue(conversation, {
    message: {
      ...paused,
      role: 'assistant',
      parts: paused.parts.map((part) =>
        isToolUIPart(part) &&
        part.state === 'approval-requested' &&
        part.toolCallId === 'first-email'
          ? {
              ...part,
              state: 'approval-responded',
              approval: {
                ...part.approval,
                approved: false,
                reason: 'not this one',
              },
            }
          : part,
      ),
    },
    trigger: 'submit-message',
  });
  await Array.fromAsync(continuation.stream);

  await waitFor(
    async () =>
      assert.equal(
        (await runtime.observe(conversation).status(continuation.id))?.status,
        'completed',
      ),
    { signal: t.signal },
  );
  const head = (await runtime.observe(conversation).engine.getMessages()).at(
    -1,
  );
  assert.deepStrictEqual(
    {
      sent,
      tools: head?.parts.flatMap((part) =>
        isToolUIPart(part)
          ? [
              {
                toolCallId: part.toolCallId,
                state: part.state,
                reason: part.approval?.reason,
              },
            ]
          : [],
      ),
    },
    {
      sent: [],
      tools: [
        {
          toolCallId: 'first-email',
          state: 'output-denied',
          reason: 'not this one',
        },
        {
          toolCallId: 'second-email',
          state: 'approval-requested',
          reason: undefined,
        },
      ],
    },
  );
});
