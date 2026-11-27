import { type UIMessage, isToolUIPart } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';

import { InMemoryContextStore, SqliteStreamStore } from '@deepagents/context';
import {
  type AgentHost,
  AgentRuntime,
  type ConversationId,
  SqliteMailboxStore,
  defineAgent,
  defineStack,
  defineTool,
} from '@deepagents/experimental/zukhruf';

import { buildSandbox } from '../../testing/build-sandbox.fixture.ts';
import { ControlledAgentStorage } from '../../testing/controlled-agent-storage.fixture.ts';
import { ControlledTurnQueue } from '../../testing/controlled-turn-queue.fixture.ts';
import { toolCallResult } from '../../testing/stream-results.fixture.ts';
import { streamsFor } from '../../testing/streams-for.fixture.ts';
import { userTurn } from '../../testing/user-turn.fixture.ts';

/**
 * A runtime on real stores whose `publish` call is paused for approval and
 * then answered approved, with its continuation queued but not yet run.
 */
async function answeredContinuation(hooks: {
  publish: (abortSignal: AbortSignal | undefined) => Promise<string>;
  turnStart?: () => Promise<void>;
}) {
  const streamStore = new SqliteStreamStore(':memory:');
  const mailboxStore = new SqliteMailboxStore(':memory:');
  const queue = new ControlledTurnQueue();
  const resources = new AsyncDisposableStack();
  resources.defer(() => {
    streamStore.close();
    mailboxStore.close();
  });
  const runtime = await new AgentRuntime(
    defineAgent({
      name: 'root',
      model: new MockLanguageModelV4({
        doStream: async () =>
          toolCallResult({
            toolCallId: 'aborted-publish',
            toolName: 'publish',
            input: JSON.stringify({ report: 'ready' }),
          }),
      }),
      sandbox: buildSandbox(),
      instructions: [],
      providerOptions: async () => {
        await hooks.turnStart?.();
        return {};
      },
      toolApproval: { publish: 'user-approval' },
      tools: {
        publish: defineTool({
          description: 'Publish a report',
          inputSchema: z.object({ report: z.string() }),
          execute: (_input, { abortSignal }) => hooks.publish(abortSignal),
        }),
      },
    }),
  ).initialize(
    defineStack(async () => ({
      storage: new ControlledAgentStorage({
        store: new InMemoryContextStore(),
        streams: streamsFor(streamStore),
        mailboxStore,
        queue,
      }),
    })),
  );
  resources.use(runtime);
  resources.use(await runtime.work());
  const conversation = { chatId: 'aborted-continuation', userId: 'user-1' };
  const initial = await runtime.enqueue(
    conversation,
    userTurn('aborted-continuation-turn', 'publish after approval'),
  );
  await queue.runNext();
  const paused = (await runtime.observe(conversation).engine.getMessages()).at(
    -1,
  );
  assert.equal(paused?.role, 'assistant');
  const answered: UIMessage & { role: 'assistant' } = {
    ...paused,
    role: 'assistant',
    parts: paused.parts.map((part) =>
      isToolUIPart(part) && part.state === 'approval-requested'
        ? {
            ...part,
            state: 'approval-responded',
            approval: { ...part.approval, approved: true },
          }
        : part,
    ),
  };
  await runtime.enqueue(conversation, {
    message: answered,
    trigger: 'submit-message',
  });
  return {
    runtime,
    queue,
    conversation,
    continuationId: initial.id,
    resources,
  };
}

/** The chain's last two messages: the continuation's calls, then the marker. */
async function chainTail(
  runtime: AgentHost,
  conversation: ConversationId,
  continuationId: string,
) {
  const messages = await runtime.observe(conversation).engine.getMessages();
  return messages.slice(-2).map((message) => ({
    id: message.id === continuationId ? 'continuation' : message.role,
    calls: message.parts.filter(isToolUIPart).map((part) => part.state),
    marker: message.parts.some(
      (part) => part.type === 'text' && part.text.startsWith('<turn_aborted>'),
    ),
  }));
}

test('an approval continuation cancelled while its approved call runs records the call failed before the <turn_aborted> marker', async () => {
  const publishing = Promise.withResolvers<void>();
  const { runtime, queue, conversation, continuationId, resources } =
    await answeredContinuation({
      publish: (abortSignal) => {
        publishing.resolve();
        const { promise, reject } = Promise.withResolvers<never>();
        abortSignal?.addEventListener(
          'abort',
          () => reject(abortSignal.reason),
          { once: true },
        );
        return promise;
      },
    });
  await using _resources = resources;

  const continuation = queue.runNext();
  await publishing.promise;
  await runtime.observe(conversation).cancel(continuationId);
  await continuation;

  assert.deepStrictEqual(
    await chainTail(runtime, conversation, continuationId),
    [
      { id: 'continuation', calls: ['output-error'], marker: false },
      { id: 'user', calls: [], marker: true },
    ],
  );
});

test('an approval continuation cancelled after its setup and before its stream is read records the approved call failed before the <turn_aborted> marker', async () => {
  let turns = 0;
  const continuationStarted = Promise.withResolvers<void>();
  const releaseContinuation = Promise.withResolvers<void>();
  const { runtime, queue, conversation, continuationId, resources } =
    await answeredContinuation({
      publish: async () => 'published',
      turnStart: async () => {
        turns++;
        if (turns === 2) {
          continuationStarted.resolve();
          await releaseContinuation.promise;
        }
      },
    });
  await using _resources = resources;

  const continuation = queue.runNext();
  await continuationStarted.promise;
  await runtime.observe(conversation).cancel(continuationId);
  releaseContinuation.resolve();
  await continuation;

  assert.deepStrictEqual(
    await chainTail(runtime, conversation, continuationId),
    [
      { id: 'continuation', calls: ['output-error'], marker: false },
      { id: 'user', calls: [], marker: true },
    ],
  );
});
