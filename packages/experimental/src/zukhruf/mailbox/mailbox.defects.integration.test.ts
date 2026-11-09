import { type UIMessage, isToolUIPart } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';

import {
  InMemoryContextStore,
  type MessageData,
  SqliteStreamStore,
} from '@deepagents/context';
import {
  type AgentDeclaration,
  type AgentHost,
  AgentRuntime,
  MessageDeliveryModes,
  SqliteMailboxStore,
  type TurnRef,
  createInterAgentCommunication,
  defineStack,
  defineTool,
} from '@deepagents/experimental/zukhruf';

import { buildSandbox } from '../../testing/build-sandbox.fixture.ts';
import {
  ControlledTurnQueue,
  type TurnConsumer,
} from '../../testing/controlled-turn-queue.fixture.ts';
import {
  textResult,
  toolCallResult,
} from '../../testing/stream-results.fixture.ts';
import { streamsFor } from '../../testing/streams-for.fixture.ts';
import { userTurn } from '../../testing/user-turn.fixture.ts';

/** Message metadata the turn executor writes for delivered mail. */
const communicationMessageMetadataSchema = z.object({
  interAgentCommunication: z.looseObject({ content: z.string() }),
});

async function submitApproval(
  runtime: AgentHost,
  conversation: { chatId: string; userId: string },
  toolCallId: string,
) {
  const head = (await runtime.observe(conversation).engine.getMessages()).at(
    -1,
  );
  assert.equal(head?.role, 'assistant');
  const message: UIMessage & { role: 'assistant' } = {
    ...head,
    role: 'assistant',
    parts: head.parts.map((part) =>
      isToolUIPart(part) &&
      part.state === 'approval-requested' &&
      part.toolCallId === toolCallId
        ? {
            ...part,
            state: 'approval-responded',
            approval: { ...part.approval, approved: true },
          }
        : part,
    ),
  };
  await runtime.enqueue(conversation, {
    message,
    trigger: 'submit-message',
  });
}

const root = { chatId: 'root', userId: 'user-1' };
const researcher = { chatId: 'researcher', userId: 'user-1' };

function mail(content: string) {
  return createInterAgentCommunication({
    author: root,
    recipient: researcher,
    content,
  });
}

function textModel(text = 'done') {
  return new MockLanguageModelV4({
    doStream: async () => textResult(text),
  });
}

function declaration(model: AgentDeclaration['model']): AgentDeclaration {
  return {
    name: 'researcher',
    model,
    sandbox: buildSandbox,
    instructions: [],
  };
}

class ManualTurnQueue extends ControlledTurnQueue {
  readonly attempted: TurnRef[] = [];
  readonly pushFaults: Error[] = [];

  override async push(turn: TurnRef) {
    this.attempted.push(turn);
    const fault = this.pushFaults.shift();
    if (fault) throw fault;
    await super.push(turn);
  }

  protected override async park(): Promise<void> {}

  protected override async deliver(
    turn: TurnRef,
    consumer: TurnConsumer,
  ): Promise<void> {
    try {
      await super.deliver(turn, consumer);
    } catch (error) {
      await this.orphan(turn, consumer, error);
    }
  }
}

class FailFirstHistoryWriteStore extends InMemoryContextStore {
  readonly #faults = [new Error('simulated durable history write failure')];

  override async addMessages(messages: MessageData[]): Promise<void> {
    const fault = this.#faults.shift();
    if (fault) throw fault;
    await super.addMessages(messages);
  }
}

async function runtimeHarness(options?: {
  model?: AgentDeclaration['model'];
  contextStore?: InMemoryContextStore;
  mailboxStore?: SqliteMailboxStore;
  queue?: ManualTurnQueue;
  tools?: AgentDeclaration['tools'];
  toolApproval?: AgentDeclaration['toolApproval'];
}) {
  const contextStore = options?.contextStore ?? new InMemoryContextStore();
  const mailboxStore =
    options?.mailboxStore ?? new SqliteMailboxStore(':memory:');
  const streamStore = new SqliteStreamStore(':memory:');
  const queue = options?.queue ?? new ManualTurnQueue();
  const runtimeSetup = new AgentRuntime({
    ...declaration(options?.model ?? textModel()),
    tools: options?.tools,
    toolApproval: options?.toolApproval,
  });
  const runtimeStack = defineStack(async () => ({
    store: contextStore,
    streams: streamsFor(streamStore),
    queue,
    mailboxStore,
  }));
  const runtime = await runtimeSetup.initialize(runtimeStack);

  return {
    runtime,
    queue,
    streamStore,
    mailboxStore,
    close() {
      mailboxStore.close();
      streamStore.close();
    },
  };
}

describe('zukhruf mailbox durability and delivery contracts', () => {
  it('delivers queue-only mail at the next safe step of an active turn', async () => {
    const firstStepStarted = Promise.withResolvers<void>();
    const releaseFirstStep = Promise.withResolvers<void>();
    const prompts: unknown[] = [];
    let call = 0;
    const model = new MockLanguageModelV4({
      doStream: async ({ prompt }) => {
        prompts.push(prompt);
        call++;
        if (call === 1) {
          firstStepStarted.resolve();
          await releaseFirstStep.promise;
          return toolCallResult({
            toolCallId: 'boundary-call',
            toolName: 'bash',
            input: JSON.stringify({
              command: 'echo boundary',
              reasoning: 'Create a safe model-step boundary.',
            }),
          });
        }
        return textResult('finished');
      },
    });
    const h = await runtimeHarness({ model });
    try {
      await using _worker = await h.runtime.work();
      void _worker;
      await h.runtime.enqueue(
        researcher,
        userTurn('active-safe-boundary-turn', 'start working'),
      );
      const executing = h.queue.runNext();
      await firstStepStarted.promise;

      await h.runtime.deliver(
        mail('new evidence while active'),
        MessageDeliveryModes.QueueOnly,
      );
      assert.equal(
        h.queue.turns.length,
        1,
        'active queue-only mail reserves one serialized fallback wake',
      );

      releaseFirstStep.resolve();
      await executing;
      await h.queue.runNext();

      assert.equal(
        prompts.length,
        2,
        'the active turn consumed the mail, so the fallback wake was a no-op',
      );
      assert.match(
        JSON.stringify(prompts[1]),
        /new evidence while active/,
        'mail is model-visible at the safe step boundary without another turn',
      );
      const history = await h.runtime.observe(researcher).engine.getMessages();
      assert.deepStrictEqual(
        history.flatMap((message) => {
          const content = communicationMessageMetadataSchema.safeParse(
            message.metadata,
          ).data?.interAgentCommunication.content;
          return content ? [content] : [];
        }),
        ['new evidence while active'],
        'the model-visible mail is durable history exactly once',
      );
      assert.equal(await h.mailboxStore.hasPending(researcher), false);
    } finally {
      h.close();
    }
  });

  it('schedules one serialized fallback when queue-only mail misses the active turn final boundary', async () => {
    const firstSamplingStarted = Promise.withResolvers<void>();
    const releaseFirstSampling = Promise.withResolvers<void>();
    const prompts: unknown[] = [];
    let active = 0;
    let maxActive = 0;
    const model = new MockLanguageModelV4({
      doStream: async ({ prompt }) => {
        const call = prompts.push(prompt);
        active++;
        maxActive = Math.max(maxActive, active);
        if (call === 1) {
          firstSamplingStarted.resolve();
          await releaseFirstSampling.promise;
        }
        active--;
        return textResult(`done ${call}`);
      },
    });
    const h = await runtimeHarness({ model });
    try {
      await using _worker = await h.runtime.work();
      void _worker;
      await h.runtime.enqueue(
        researcher,
        userTurn('active-final-boundary-turn', 'finish this response'),
      );
      const executing = h.queue.runNext();
      await firstSamplingStarted.promise;

      await h.runtime.deliver(
        mail('arrived during the final sample'),
        MessageDeliveryModes.QueueOnly,
      );
      assert.equal(
        h.queue.turns.length,
        1,
        'active queue-only mail reserves one serialized fallback wake',
      );
      assert.equal(
        prompts.length,
        1,
        'the fallback cannot sample concurrently',
      );

      releaseFirstSampling.resolve();
      await executing;

      assert.ok(
        h.queue.turns.length >= 1,
        'at least one serialized fallback survives the durable handoff',
      );
      assert.ok(h.queue.turns.every((turn) => turn.kind === 'mailbox'));
      while (h.queue.turns.length > 0) await h.queue.runNext();

      assert.equal(prompts.length, 2);
      assert.equal(maxActive, 1);
      assert.match(
        JSON.stringify(prompts[1]),
        /arrived during the final sample/,
      );
      assert.equal(await h.mailboxStore.hasPending(researcher), false);
    } finally {
      h.close();
    }
  });

  it('schedules a final-boundary fallback when queue-only mail comes from another coordinator instance', async () => {
    const firstSamplingStarted = Promise.withResolvers<void>();
    const releaseFirstSampling = Promise.withResolvers<void>();
    const prompts: unknown[] = [];
    const model = new MockLanguageModelV4({
      doStream: async ({ prompt }) => {
        const call = prompts.push(prompt);
        if (call === 1) {
          firstSamplingStarted.resolve();
          await releaseFirstSampling.promise;
        }
        return textResult(`done ${call}`);
      },
    });
    const contextStore = new InMemoryContextStore();
    const mailboxStore = new SqliteMailboxStore(':memory:');
    const streamStore = new SqliteStreamStore(':memory:');
    const queue = new ManualTurnQueue();
    const runtimeOptions = {
      store: contextStore,
      streams: streamsFor(streamStore),
      mailboxStore,
      queue,
    };
    const runtimeStack = defineStack(async () => ({ ...runtimeOptions }));
    const agent = declaration(model);
    const workerRuntimeSetup = new AgentRuntime(agent);
    const workerRuntime = await workerRuntimeSetup.initialize(runtimeStack);
    const senderRuntimeSetup = new AgentRuntime(agent);
    const senderRuntime = await senderRuntimeSetup.initialize(runtimeStack);
    try {
      await using _worker = await workerRuntime.work();
      void _worker;
      await workerRuntime.enqueue(
        researcher,
        userTurn('cross-runtime-active-turn', 'finish this response'),
      );
      const executing = queue.runNext();
      await firstSamplingStarted.promise;

      await senderRuntime.deliver(
        mail('arrived from another coordinator'),
        MessageDeliveryModes.QueueOnly,
      );
      assert.equal(
        queue.turns.length,
        1,
        'durable mailbox activity is visible across coordinator instances',
      );

      releaseFirstSampling.resolve();
      await executing;

      assert.ok(
        queue.turns.length >= 1,
        'at least one durable fallback survives the append-to-wake boundary',
      );
      assert.ok(queue.turns.every((turn) => turn.kind === 'mailbox'));
      while (queue.turns.length > 0) await queue.runNext();
      assert.equal(prompts.length, 2);
      assert.match(
        JSON.stringify(prompts[1]),
        /arrived from another coordinator/,
      );
      assert.equal(await mailboxStore.hasPending(researcher), false);
    } finally {
      mailboxStore.close();
      streamStore.close();
    }
  });

  it('schedules a later trigger after the worker consumes the first wake', async () => {
    const prompts: unknown[] = [];
    const model = new MockLanguageModelV4({
      doStream: async ({ prompt }) => {
        prompts.push(prompt);
        return textResult('received');
      },
    });
    const contextStore = new InMemoryContextStore();
    const mailboxStore = new SqliteMailboxStore(':memory:');
    const streamStore = new SqliteStreamStore(':memory:');
    const queue = new ManualTurnQueue();
    const runtimeOptions = {
      store: contextStore,
      streams: streamsFor(streamStore),
      mailboxStore,
      queue,
    };
    const runtimeStack = defineStack(async () => ({ ...runtimeOptions }));
    const agent = declaration(model);
    const workerRuntimeSetup = new AgentRuntime(agent);
    const workerRuntime = await workerRuntimeSetup.initialize(runtimeStack);
    const senderRuntimeSetup = new AgentRuntime(agent);
    const senderRuntime = await senderRuntimeSetup.initialize(runtimeStack);
    try {
      await using _worker = await workerRuntime.work();
      void _worker;

      await senderRuntime.deliver(
        mail('first triggered task'),
        MessageDeliveryModes.TriggerTurn,
      );
      await queue.runNext();
      assert.equal(queue.turns.length, 0);
      assert.equal(prompts.length, 1);

      await senderRuntime.deliver(
        mail('second triggered task'),
        MessageDeliveryModes.TriggerTurn,
      );

      assert.equal(
        queue.turns.length,
        1,
        'a fulfilled sender-local wake must not suppress later trigger turns',
      );
      await queue.runNext();
      assert.equal(prompts.length, 2);
      assert.match(JSON.stringify(prompts[1]), /second triggered task/);
      assert.equal(await mailboxStore.hasPending(researcher), false);
    } finally {
      mailboxStore.close();
      streamStore.close();
    }
  });

  it('does not wake an idle target when queue-only mail commits after the durable turn handoff', async () => {
    const contextStore = new InMemoryContextStore();
    const mailboxStore = new SqliteMailboxStore(':memory:');
    const streamStore = new SqliteStreamStore(':memory:');
    const queue = new ManualTurnQueue();
    const runtimeOptions = {
      store: contextStore,
      streams: streamsFor(streamStore),
      mailboxStore,
      queue,
    };
    const agent = declaration(textModel());
    const runtimeStack = defineStack(async () => runtimeOptions);
    const workerRuntimeSetup = new AgentRuntime(agent);
    const workerRuntime = await workerRuntimeSetup.initialize(runtimeStack);
    const senderRuntimeSetup = new AgentRuntime(agent);
    const senderRuntime = await senderRuntimeSetup.initialize(runtimeStack);
    try {
      await using _worker = await workerRuntime.work();
      void _worker;
      const completed = await workerRuntime.enqueue(
        researcher,
        userTurn('completed-before-queue-only-mail', 'finish first'),
      );
      await queue.runNext();
      assert.equal(
        await streamStore.getStreamStatus(completed.id),
        'completed',
      );
      assert.equal(queue.turns.length, 0);

      await senderRuntime.deliver(
        mail('wait until a natural future turn'),
        MessageDeliveryModes.QueueOnly,
      );

      assert.equal(
        queue.turns.length,
        0,
        'send_message does not trigger a turn after the durable end-turn handoff',
      );
      assert.equal(await mailboxStore.hasPending(researcher), true);
    } finally {
      mailboxStore.close();
      streamStore.close();
    }
  });

  it('keeps destructive mailbox storage private while exposing host delivery', async () => {
    const h = await runtimeHarness();
    try {
      assert.equal(
        'mailboxStore' in h.runtime,
        false,
        'runtime consumption does not expose its destructive mailbox store',
      );
      assert.equal('deliver' in h.runtime, true);
    } finally {
      h.close();
    }
  });

  it('does not leave a permanently queued stream receipt when wake scheduling fails', async () => {
    const queue = new ManualTurnQueue();
    queue.pushFaults.push(new Error('simulated queue push failure'));
    const h = await runtimeHarness({ queue });
    try {
      await assert.rejects(
        h.runtime.deliver(mail('wake me'), MessageDeliveryModes.TriggerTurn),
        /simulated queue push failure/,
      );

      const failedWake = queue.attempted[0];
      assert.ok(failedWake);
      assert.equal(
        await h.streamStore.getStreamStatus(failedWake.streamId),
        'failed',
        'a failed wake receipt is terminal instead of orphaned forever',
      );
    } finally {
      h.close();
    }
  });

  it('delivers mail queued during approval to the continuation first model request', async () => {
    const prompts: unknown[] = [];
    let calls = 0;
    const model = new MockLanguageModelV4({
      doStream: async ({ prompt }) => {
        prompts.push(prompt);
        calls++;
        if (calls === 1) {
          return toolCallResult({
            toolCallId: 'approval-call',
            toolName: 'sendEmail',
            input: JSON.stringify({ to: 'a@b.c' }),
          });
        }
        return textResult('continued');
      },
    });
    const h = await runtimeHarness({
      model,
      toolApproval: { sendEmail: 'user-approval' },
      tools: {
        sendEmail: defineTool({
          description: 'Send an email',
          inputSchema: z.object({ to: z.string() }),
          execute: async () => 'sent',
        }),
      },
    });
    try {
      await using _worker = await h.runtime.work();
      void _worker;
      await h.runtime.enqueue(
        researcher,
        userTurn('approval-mailbox-turn', 'send it'),
      );
      await h.queue.runNext();

      await h.runtime.deliver(
        mail('mail must reach resumed request'),
        MessageDeliveryModes.QueueOnly,
      );
      await submitApproval(h.runtime, researcher, 'approval-call');
      await h.queue.runNext();

      assert.match(
        JSON.stringify(prompts[1]),
        /mail must reach resumed request/,
      );
      assert.equal(await h.mailboxStore.hasPending(researcher), false);
    } finally {
      h.close();
    }
  });

  it('treats drain as consumption even when durable history writing fails', async () => {
    const h = await runtimeHarness({
      contextStore: new FailFirstHistoryWriteStore(),
    });
    try {
      await h.runtime.deliver(
        mail('lost after the drain if history persistence fails'),
        MessageDeliveryModes.TriggerTurn,
      );
      await using _worker = await h.runtime.work();
      void _worker;
      await h.queue.runNext();

      assert.equal(
        await h.mailboxStore.hasPending(researcher),
        false,
        'draining consumes mail before the runtime writes durable history',
      );

      const history = await h.runtime.observe(researcher).engine.getMessages();
      assert.deepStrictEqual(
        history.flatMap((message) => {
          const content = communicationMessageMetadataSchema.safeParse(
            message.metadata,
          ).data?.interAgentCommunication.content;
          return content ? [content] : [];
        }),
        [],
        'the simpler mailbox contract does not redeliver drained mail',
      );
    } finally {
      h.close();
    }
  });
});
