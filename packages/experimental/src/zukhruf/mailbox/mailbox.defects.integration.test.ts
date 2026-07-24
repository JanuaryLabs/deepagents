import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { InMemoryFs } from 'just-bash';
import assert from 'node:assert';
import { describe, it } from 'node:test';
import { z } from 'zod';

import {
  type AgentSandbox,
  InMemoryContextStore,
  type MessageData,
  SqliteStreamStore,
  createBashTool,
  createVirtualSandbox,
} from '@deepagents/context';
import {
  type AgentDeclaration,
  AgentRuntime,
  type ConsumeContext,
  type ConsumeOptions,
  MessageDeliveryMode,
  SqliteMailboxStore,
  TurnQueue,
  type TurnRef,
  createInterAgentCommunication,
  defineTool,
} from '@deepagents/experimental/zukhruf';

const root = { chatId: 'root', userId: 'user-1' };
const researcher = { chatId: 'researcher', userId: 'user-1' };

const usage = {
  inputTokens: {
    total: 1,
    noCache: 1,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
} as const;

function mail(content: string) {
  return createInterAgentCommunication({
    author: root,
    recipient: researcher,
    content,
  });
}

function textModel(text = 'done') {
  return new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: 'text-start', id: 'text-1' },
          { type: 'text-delta', id: 'text-1', delta: text },
          { type: 'text-end', id: 'text-1' },
          {
            type: 'finish',
            finishReason: { unified: 'stop', raw: '' },
            usage,
          },
        ],
      }),
    }),
  });
}

function declaration(
  model: AgentDeclaration['model'],
  tools?: AgentDeclaration['tools'],
): AgentDeclaration {
  return {
    name: 'researcher',
    model,
    sandbox: async (): Promise<AgentSandbox> =>
      createBashTool({
        sandbox: await createVirtualSandbox({ fs: new InMemoryFs() }),
      }),
    instructions: [],
    tools,
  };
}

class ManualTurnQueue extends TurnQueue {
  readonly attempted: TurnRef[] = [];
  readonly pending: TurnRef[] = [];
  failPushes = 0;
  #consumer?: {
    handler: (turn: TurnRef, context: ConsumeContext) => Promise<void>;
    options: ConsumeOptions;
  };

  override async push(turn: TurnRef) {
    this.attempted.push(turn);
    if (this.failPushes > 0) {
      this.failPushes--;
      throw new Error('simulated queue push failure');
    }
    this.pending.push(turn);
    return { jobId: turn.streamId, inserted: true };
  }

  override async getTurnActivity(
    conversation: Pick<TurnRef, 'chatId' | 'userId'>,
  ): Promise<'idle' | 'queued' | 'running'> {
    return this.pending.some(
      (turn) =>
        turn.chatId === conversation.chatId &&
        turn.userId === conversation.userId,
    )
      ? 'queued'
      : 'idle';
  }

  override async getCurrentTurn(
    conversation: Pick<TurnRef, 'chatId' | 'userId'>,
  ): Promise<TurnRef | undefined> {
    return this.pending.find(
      (turn) =>
        turn.chatId === conversation.chatId &&
        turn.userId === conversation.userId,
    );
  }

  override async cancel(streamId: string): Promise<void> {
    const remaining = this.pending.filter((turn) => turn.streamId !== streamId);
    this.pending.splice(0, this.pending.length, ...remaining);
  }

  override async consume(
    handler: (turn: TurnRef, context: ConsumeContext) => Promise<void>,
    options: ConsumeOptions,
  ): Promise<AsyncDisposable> {
    this.#consumer = { handler, options };
    return {
      [Symbol.asyncDispose]: async () => {
        this.#consumer = undefined;
      },
    };
  }

  override async resumeParked(): Promise<void> {}

  async runNext(): Promise<void> {
    assert.ok(this.#consumer, 'start runtime.work() before running a turn');
    const turn = this.pending.shift();
    assert.ok(turn, 'expected one queued turn');
    const abort = new AbortController();
    try {
      await this.#consumer.handler(turn, {
        signal: abort.signal,
        park: async () => {},
      });
    } catch (error) {
      await this.#consumer.options.onOrphaned(
        turn,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
}

class FailFirstHistoryWriteStore extends InMemoryContextStore {
  #fail = true;

  override async addMessages(messages: MessageData[]): Promise<void> {
    if (this.#fail) {
      this.#fail = false;
      throw new Error('simulated durable history write failure');
    }
    await super.addMessages(messages);
  }
}

function runtimeHarness(options?: {
  model?: AgentDeclaration['model'];
  contextStore?: InMemoryContextStore;
  mailboxStore?: SqliteMailboxStore;
  queue?: ManualTurnQueue;
  tools?: AgentDeclaration['tools'];
}) {
  const contextStore = options?.contextStore ?? new InMemoryContextStore();
  const mailboxStore =
    options?.mailboxStore ?? new SqliteMailboxStore(':memory:');
  const streamStore = new SqliteStreamStore(':memory:');
  const queue = options?.queue ?? new ManualTurnQueue();
  const runtime = new AgentRuntime(
    declaration(options?.model ?? textModel(), options?.tools),
    {
      store: contextStore,
      streamStore,
      queue,
      mailboxStore,
    },
  );

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
          return {
            stream: simulateReadableStream({
              chunks: [
                {
                  type: 'tool-call',
                  toolCallId: 'boundary-call',
                  toolName: 'bash',
                  input: JSON.stringify({
                    command: 'echo boundary',
                    reasoning: 'Create a safe model-step boundary.',
                  }),
                },
                {
                  type: 'finish',
                  finishReason: { unified: 'tool-calls', raw: '' },
                  usage,
                },
              ] as LanguageModelV4StreamPart[],
            }),
          };
        }
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: 'text-start', id: 'text-2' },
              { type: 'text-delta', id: 'text-2', delta: 'finished' },
              { type: 'text-end', id: 'text-2' },
              {
                type: 'finish',
                finishReason: { unified: 'stop', raw: '' },
                usage,
              },
            ] as LanguageModelV4StreamPart[],
          }),
        };
      },
    });
    const h = runtimeHarness({ model });
    try {
      await using _worker = await h.runtime.work();
      await h.runtime.enqueue(researcher, {
        id: 'active-safe-boundary-turn',
        input: 'start working',
      });
      const executing = h.queue.runNext();
      await firstStepStarted.promise;

      await h.runtime.deliver(
        mail('new evidence while active'),
        MessageDeliveryMode.QueueOnly,
      );
      assert.equal(
        h.queue.pending.length,
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
          const content = (
            message.metadata as
              { interAgentCommunication?: { content?: string } } | undefined
          )?.interAgentCommunication?.content;
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
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: 'text-start', id: `text-${call}` },
              { type: 'text-delta', id: `text-${call}`, delta: `done ${call}` },
              { type: 'text-end', id: `text-${call}` },
              {
                type: 'finish',
                finishReason: { unified: 'stop', raw: '' },
                usage,
              },
            ],
          }),
        };
      },
    });
    const h = runtimeHarness({ model });
    try {
      await using _worker = await h.runtime.work();
      await h.runtime.enqueue(researcher, {
        id: 'active-final-boundary-turn',
        input: 'finish this response',
      });
      const executing = h.queue.runNext();
      await firstSamplingStarted.promise;

      await h.runtime.deliver(
        mail('arrived during the final sample'),
        MessageDeliveryMode.QueueOnly,
      );
      assert.equal(
        h.queue.pending.length,
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
        h.queue.pending.length >= 1,
        'at least one serialized fallback survives the durable handoff',
      );
      assert.ok(h.queue.pending.every((turn) => turn.kind === 'mailbox'));
      while (h.queue.pending.length > 0) await h.queue.runNext();

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
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: 'text-start', id: `text-${call}` },
              { type: 'text-delta', id: `text-${call}`, delta: `done ${call}` },
              { type: 'text-end', id: `text-${call}` },
              {
                type: 'finish',
                finishReason: { unified: 'stop', raw: '' },
                usage,
              },
            ],
          }),
        };
      },
    });
    const contextStore = new InMemoryContextStore();
    const mailboxStore = new SqliteMailboxStore(':memory:');
    const streamStore = new SqliteStreamStore(':memory:');
    const queue = new ManualTurnQueue();
    const runtimeOptions = {
      store: contextStore,
      streamStore,
      mailboxStore,
      queue,
    };
    const agent = declaration(model);
    const workerRuntime = new AgentRuntime(agent, runtimeOptions);
    const senderRuntime = new AgentRuntime(agent, runtimeOptions);
    try {
      await using _worker = await workerRuntime.work();
      await workerRuntime.enqueue(researcher, {
        id: 'cross-runtime-active-turn',
        input: 'finish this response',
      });
      const executing = queue.runNext();
      await firstSamplingStarted.promise;

      await senderRuntime.deliver(
        mail('arrived from another coordinator'),
        MessageDeliveryMode.QueueOnly,
      );
      assert.equal(
        queue.pending.length,
        1,
        'durable mailbox activity is visible across coordinator instances',
      );

      releaseFirstSampling.resolve();
      await executing;

      assert.ok(
        queue.pending.length >= 1,
        'at least one durable fallback survives the append-to-wake boundary',
      );
      assert.ok(queue.pending.every((turn) => turn.kind === 'mailbox'));
      while (queue.pending.length > 0) await queue.runNext();
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
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: 'text-start', id: 'text-1' },
              { type: 'text-delta', id: 'text-1', delta: 'received' },
              { type: 'text-end', id: 'text-1' },
              {
                type: 'finish',
                finishReason: { unified: 'stop', raw: '' },
                usage,
              },
            ],
          }),
        };
      },
    });
    const contextStore = new InMemoryContextStore();
    const mailboxStore = new SqliteMailboxStore(':memory:');
    const streamStore = new SqliteStreamStore(':memory:');
    const queue = new ManualTurnQueue();
    const runtimeOptions = {
      store: contextStore,
      streamStore,
      mailboxStore,
      queue,
    };
    const agent = declaration(model);
    const workerRuntime = new AgentRuntime(agent, runtimeOptions);
    const senderRuntime = new AgentRuntime(agent, runtimeOptions);
    try {
      await using _worker = await workerRuntime.work();

      await senderRuntime.deliver(
        mail('first triggered task'),
        MessageDeliveryMode.TriggerTurn,
      );
      await queue.runNext();
      assert.equal(queue.pending.length, 0);
      assert.equal(prompts.length, 1);

      await senderRuntime.deliver(
        mail('second triggered task'),
        MessageDeliveryMode.TriggerTurn,
      );

      assert.equal(
        queue.pending.length,
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
      streamStore,
      mailboxStore,
      queue,
    };
    const agent = declaration(textModel());
    const workerRuntime = new AgentRuntime(agent, runtimeOptions);
    const senderRuntime = new AgentRuntime(agent, runtimeOptions);
    try {
      await using _worker = await workerRuntime.work();
      const completed = await workerRuntime.enqueue(researcher, {
        id: 'completed-before-queue-only-mail',
        input: 'finish first',
      });
      await queue.runNext();
      assert.equal(
        await streamStore.getStreamStatus(completed.id),
        'completed',
      );
      assert.equal(queue.pending.length, 0);

      await senderRuntime.deliver(
        mail('wait until a natural future turn'),
        MessageDeliveryMode.QueueOnly,
      );

      assert.equal(
        queue.pending.length,
        0,
        'send_message does not trigger a turn after the durable end-turn handoff',
      );
      assert.equal(await mailboxStore.hasPending(researcher), true);
    } finally {
      mailboxStore.close();
      streamStore.close();
    }
  });

  it('keeps destructive mailbox storage private while exposing host delivery', () => {
    const h = runtimeHarness();
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
    queue.failPushes = 1;
    const h = runtimeHarness({ queue });
    try {
      await assert.rejects(
        h.runtime.deliver(mail('wake me'), MessageDeliveryMode.TriggerTurn),
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
          return {
            stream: simulateReadableStream({
              chunks: [
                {
                  type: 'tool-call',
                  toolCallId: 'approval-call',
                  toolName: 'sendEmail',
                  input: JSON.stringify({ to: 'a@b.c' }),
                },
                {
                  type: 'finish',
                  finishReason: { unified: 'tool-calls', raw: '' },
                  usage,
                },
              ] as LanguageModelV4StreamPart[],
            }),
          };
        }
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: 'text-start', id: 'text-2' },
              {
                type: 'text-delta',
                id: 'text-2',
                delta: 'continued',
              },
              { type: 'text-end', id: 'text-2' },
              {
                type: 'finish',
                finishReason: { unified: 'stop', raw: '' },
                usage,
              },
            ] as LanguageModelV4StreamPart[],
          }),
        };
      },
    });
    const h = runtimeHarness({
      model,
      tools: {
        sendEmail: defineTool({
          description: 'Send an email',
          inputSchema: z.object({ to: z.string() }),
          needsApproval: true,
          execute: async () => 'sent',
        }),
      },
    });
    try {
      await using _worker = await h.runtime.work();
      await h.runtime.enqueue(researcher, {
        id: 'approval-mailbox-turn',
        input: 'send it',
      });
      await h.queue.runNext();

      await h.runtime.deliver(
        mail('mail must reach resumed request'),
        MessageDeliveryMode.QueueOnly,
      );
      await h.runtime.approve(researcher, { toolCallId: 'approval-call' });
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
    const h = runtimeHarness({
      contextStore: new FailFirstHistoryWriteStore(),
    });
    try {
      await h.runtime.deliver(
        mail('lost after the drain if history persistence fails'),
        MessageDeliveryMode.TriggerTurn,
      );
      await using _worker = await h.runtime.work();
      await h.queue.runNext();

      assert.equal(
        await h.mailboxStore.hasPending(researcher),
        false,
        'draining consumes mail before the runtime writes durable history',
      );

      const history = await h.runtime.observe(researcher).engine.getMessages();
      assert.deepStrictEqual(
        history.flatMap((message) => {
          const content = (
            message.metadata as
              { interAgentCommunication?: { content?: string } } | undefined
          )?.interAgentCommunication?.content;
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
