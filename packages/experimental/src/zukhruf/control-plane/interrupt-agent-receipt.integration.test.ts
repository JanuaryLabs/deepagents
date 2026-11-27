import { TemporaryFiles } from '@zukhruf/fs';
import { waitFor } from '@zukhruf/testing/async';
import { MockLanguageModelV4 } from 'ai/test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import {
  type AgentHost,
  AgentRuntime,
  EmbeddedAgentStorage,
  defineAgent,
  defineStack,
} from '@deepagents/experimental/zukhruf';

import { buildSandbox } from '../../testing/build-sandbox.fixture.ts';
import {
  textResult,
  toolCallResult,
} from '../../testing/stream-results.fixture.ts';
import { userTurn } from '../../testing/user-turn.fixture.ts';

const call = (toolName: string, input: unknown) =>
  toolCallResult({
    toolCallId: randomUUID(),
    toolName,
    input: JSON.stringify(input),
  });

async function childrenOf(runtime: AgentHost, chatId: string) {
  const history = await runtime.listHistory();
  return history.find((item) => item.chatId === chatId)?.children ?? [];
}

// An interrupted child never ran a turn of its own, so no worker records its
// terminal state: interrupt_agent is the only path that records the receipt.
test("interrupt_agent records a queued child's own completion receipt as cancelled", async (t) => {
  await using resources = new AsyncDisposableStack();
  const directory = resources.use(
    await new TemporaryFiles().directory('interrupt-agent-receipt-'),
  );
  const queuedModel = new MockLanguageModelV4({
    doStream: async () => textResult('should never run'),
  });
  const rootSteps = [
    call('spawn_agent', {
      agent_type: 'queued-worker',
      task_name: 'queued',
      message: 'go',
      fork_turns: 'none',
    }),
    call('spawn_agent', {
      agent_type: 'worker',
      task_name: 'other',
      message: 'go',
      fork_turns: 'none',
    }),
    call('interrupt_agent', { target: 'queued' }),
  ];
  const runtime = resources.use(
    await new AgentRuntime(
      defineAgent({
        name: 'root',
        instructions: [],
        sandbox: buildSandbox(),
        model: new MockLanguageModelV4({
          doStream: async () => rootSteps.shift() ?? textResult('root done'),
        }),
        subagents: [
          defineAgent({
            name: 'queued-worker',
            instructions: [],
            sandbox: buildSandbox(),
            model: queuedModel,
          }),
          defineAgent({
            name: 'worker',
            instructions: [],
            sandbox: buildSandbox(),
            model: new MockLanguageModelV4({
              doStream: async () => textResult('other done'),
            }),
          }),
        ],
      }),
    ).initialize(
      defineStack(async () => ({
        storage: resources.use(
          await EmbeddedAgentStorage.open({ directory: directory.path }),
        ),
      })),
    ),
  );
  // One slot: the root's turn holds it, so both children's first turns stay
  // queued until the root's turn ends, and the queued child is interrupted first.
  resources.use(await runtime.work({ concurrency: 1 }));
  const conversation = { chatId: randomUUID(), userId: 'user-1' };

  const turn = await runtime.enqueue(
    conversation,
    userTurn(randomUUID(), 'run'),
  );
  for await (const chunk of turn.stream) assert.ok(chunk.type);

  // The other child completes afterwards, so a receipt exists that is not the
  // interrupted child's own.
  await waitFor(
    async () => {
      const other = (await childrenOf(runtime, conversation.chatId)).find(
        (child) => child.path === '/root/other',
      );
      assert.equal(other?.activities.completion?.outcome, 'completed');
    },
    { interval: 50, signal: t.signal },
  );
  const children = await childrenOf(runtime, conversation.chatId);
  const queued = children.find((child) => child.path === '/root/queued');
  const other = children.find((child) => child.path === '/root/other');
  assert.ok(queued?.activities.spawn, 'the queued child was spawned');
  assert.ok(other?.activities.completion);
  const streamId = queued.activities.spawn.streamId;
  const { at, ...completion } = queued.activities.completion ?? {};
  assert.deepStrictEqual(
    { completion, state: queued.state, childTurns: queuedModel.doStreamCalls },
    {
      completion: {
        id: `completion:${streamId}`,
        type: 'completion',
        outcome: 'cancelled',
        actorPath: '/root/queued',
        targetPath: '/root/queued',
        streamId,
      },
      state: 'interrupted',
      childTurns: [],
    },
  );
  assert.equal(typeof at, 'number');
  assert.notEqual(other.activities.completion.streamId, streamId);
});
