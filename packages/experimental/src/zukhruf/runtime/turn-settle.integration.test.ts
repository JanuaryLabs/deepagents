import { TemporaryFiles } from '@zukhruf/fs';
import { waitFor } from '@zukhruf/testing/async';
import { Postgres } from '@zukhruf/testing/postgres';
import { type UIMessage, isToolUIPart } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import assert from 'node:assert/strict';
import { suite, test } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { PgBoss } from 'pg-boss';
import { z } from 'zod';

import {
  type AdmissionScope,
  type AgentPluginDefinition,
  AgentRuntime,
  AgentStorage,
  type AgentTree,
  EmbeddedAgentStorage,
  NonRetryableError,
  PostgresAgentStorage,
  TurnQueue,
  type TurnRef,
  defineAgent,
  defineStack,
  defineTool,
} from '@deepagents/experimental/zukhruf';

import { buildSandbox } from '../../testing/build-sandbox.fixture.ts';
import {
  textResult,
  toolCallResult,
} from '../../testing/stream-results.fixture.ts';
import { userTurn } from '../../testing/user-turn.fixture.ts';

const testPostgres = new Postgres({ environment: process.env });

/** The real turn queue, with every orphan report its consumer has reconciled recorded. */
class OrphanRecordingQueue extends TurnQueue {
  readonly orphans: { streamId: string; error: string }[] = [];
  readonly #inner: TurnQueue;

  constructor(inner: TurnQueue) {
    super();
    this.#inner = inner;
  }

  override push(turn: TurnRef) {
    return this.#inner.push(turn);
  }

  override getTurnActivity(conversation: Pick<TurnRef, 'chatId' | 'userId'>) {
    return this.#inner.getTurnActivity(conversation);
  }

  override getCurrentTurn(conversation: Pick<TurnRef, 'chatId' | 'userId'>) {
    return this.#inner.getCurrentTurn(conversation);
  }

  override cancel(streamId: string) {
    return this.#inner.cancel(streamId);
  }

  override consume(...[handler, options]: Parameters<TurnQueue['consume']>) {
    return this.#inner.consume(handler, {
      ...options,
      onOrphaned: async (turn, error) => {
        await options.onOrphaned(turn, error);
        this.orphans.push({ streamId: turn.streamId, error });
      },
    });
  }

  override resumeParked(chatId: string) {
    return this.#inner.resumeParked(chatId);
  }

  override forget(conversation: Pick<TurnRef, 'chatId' | 'userId'>) {
    return this.#inner.forget(conversation);
  }
}

/** A real storage whose turn queue records orphan reports. */
class OrphanRecordingStorage extends AgentStorage {
  readonly queue: OrphanRecordingQueue;
  readonly #inner: AgentStorage;

  constructor(inner: AgentStorage) {
    super();
    this.#inner = inner;
    this.queue = new OrphanRecordingQueue(inner.queue);
  }

  get store() {
    return this.#inner.store;
  }

  get streams() {
    return this.#inner.streams;
  }

  get mailboxStore() {
    return this.#inner.mailboxStore;
  }

  get sandboxIdleWakes() {
    return this.#inner.sandboxIdleWakes;
  }

  get deletedConversations() {
    return this.#inner.deletedConversations;
  }

  settleQueue(followUp: string) {
    return this.#inner.settleQueue(followUp);
  }

  admit<T>(
    tree: AgentTree,
    work: (scope: AdmissionScope) => Promise<T>,
  ): Promise<T> {
    return this.#inner.admit(tree, work);
  }
}

const storages = [
  {
    name: 'embedded',
    open: async (resources: AsyncDisposableStack): Promise<AgentStorage> => {
      const directory = resources.use(
        await new TemporaryFiles().directory('zukhruf-'),
      );
      return resources.use(
        await EmbeddedAgentStorage.open({ directory: directory.path }),
      );
    },
  },
  {
    name: 'postgres',
    open: async (resources: AsyncDisposableStack): Promise<AgentStorage> => {
      const database = resources.use(await testPostgres.database());
      const boss = new PgBoss({ connectionString: database.connectionString });
      boss.on('error', () => {});
      await boss.start();
      resources.defer(() => boss.stop({ graceful: false }));
      return resources.use(
        await PostgresAgentStorage.create({
          pool: database.pool(),
          boss,
          queue: { pollingIntervalSeconds: 0.5 },
        }),
      );
    },
  },
];

/** A plugin whose settle follow-up fails, not to be retried, on every run, recording each chat it runs for. */
function rejectingAvailability(settled: string[]): AgentPluginDefinition {
  return {
    name: 'rejecting-availability',
    create: () => ({
      initialize: async () => ({
        conversationAvailable: async ({ chatId }) => {
          settled.push(chatId);
          throw new NonRetryableError(availabilityFailure(chatId));
        },
      }),
    }),
  };
}

const availabilityFailure = (chatId: string) =>
  `availability of "${chatId}" failed`;

/** Records the process warnings about `chatId` emitted while `body` runs. */
async function recordingWarnings<T>(
  chatId: string,
  body: (warnings: string[]) => Promise<T>,
): Promise<T> {
  const warnings: string[] = [];
  const record = (warning: Error) => {
    if (warning.message.includes(`"${chatId}"`)) warnings.push(warning.message);
  };
  process.on('warning', record);
  try {
    return await body(warnings);
  } finally {
    process.off('warning', record);
  }
}

for (const { name, open } of storages) {
  suite(`a settle follow-up that fails (${name})`, () => {
    test('an approval continuation that completes is not orphaned, and no recovery runs its model again', async (t) => {
      await using resources = new AsyncDisposableStack();
      const storage = new OrphanRecordingStorage(await open(resources));
      const settled: string[] = [];
      const calls: string[] = [];
      const conversation = { chatId: 'settled-continuation', userId: 'u1' };
      const runtime = resources.use(
        await new AgentRuntime(
          defineAgent({
            name: 'approval',
            sandbox: buildSandbox(),
            instructions: [],
            toolApproval: { sendEmail: 'user-approval' },
            tools: {
              sendEmail: defineTool({
                description: 'Send an email',
                inputSchema: z.object({ to: z.string() }),
                execute: async ({ to }) => `sent:${to}`,
              }),
            },
            plugins: [rejectingAvailability(settled)],
            model: new MockLanguageModelV4({
              doStream: async ({ prompt }) => {
                const answered = JSON.stringify(prompt).includes('sent:a@b.c');
                calls.push(answered ? 'continuation' : 'ask');
                return answered
                  ? textResult('done')
                  : toolCallResult({
                      toolCallId: 'send-1',
                      toolName: 'sendEmail',
                      input: JSON.stringify({ to: 'a@b.c' }),
                    });
              },
            }),
          }),
        ).initialize(defineStack(async () => ({ storage }))),
      );

      await recordingWarnings(conversation.chatId, async (warnings) => {
        await using _worker = await runtime.work();
        void _worker;
        const ask = await runtime.enqueue(
          conversation,
          userTurn(crypto.randomUUID(), 'send it'),
        );
        await Array.fromAsync(ask.stream);
        // The ask's follow-up runs before the continuation starts, so a later
        // turn cannot supersede it.
        await waitFor(() => assert.equal(settled.length, 1), {
          signal: t.signal,
          interval: 50,
        });
        const paused: UIMessage | undefined = (
          await runtime.observe(conversation).engine.getMessages()
        ).at(-1);
        assert.ok(paused?.role === 'assistant');
        const continuation = await runtime.enqueue(conversation, {
          message: {
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
          },
          trigger: 'submit-message',
        });
        await Array.fromAsync(continuation.stream);

        await waitFor(() => assert.ok(settled.length >= 2), {
          signal: t.signal,
          interval: 50,
        });
        // Give what follows a failed follow-up the time to show: an orphan
        // report and the recovery it may push.
        await setTimeout(2_000);

        assert.deepStrictEqual(
          {
            orphans: storage.queue.orphans,
            settled,
            warnings,
            calls,
            continuation: (
              await runtime.observe(conversation).status(continuation.id)
            )?.status,
            activity: await storage.queue.getTurnActivity(conversation),
          },
          {
            orphans: [],
            settled: [conversation.chatId, conversation.chatId],
            warnings: [
              availabilityFailure(conversation.chatId),
              availabilityFailure(conversation.chatId),
            ],
            calls: ['ask', 'continuation'],
            continuation: 'completed',
            activity: 'idle',
          },
        );
      });
    });

    test('an orphaned turn is reconciled once, and its settle still runs once', async (t) => {
      await using resources = new AsyncDisposableStack();
      const storage = new OrphanRecordingStorage(await open(resources));
      const settled: string[] = [];
      const conversation = { chatId: 'settled-orphan', userId: 'u1' };
      const runtime = resources.use(
        await new AgentRuntime(
          defineAgent({
            name: 'crashing',
            sandbox: {
              ...buildSandbox(),
              open: async () => {
                throw new Error('sandbox setup failed');
              },
            },
            instructions: [],
            plugins: [rejectingAvailability(settled)],
            model: new MockLanguageModelV4({
              doStream: async () => textResult('unreachable'),
            }),
          }),
        ).initialize(defineStack(async () => ({ storage }))),
      );

      await recordingWarnings(conversation.chatId, async (warnings) => {
        await using _worker = await runtime.work();
        void _worker;
        const crashed = await runtime.enqueue(
          conversation,
          userTurn(crypto.randomUUID(), 'crash'),
        );

        await waitFor(() => assert.ok(storage.queue.orphans.length >= 1), {
          signal: t.signal,
          interval: 50,
        });
        // Give the follow-up, and a re-run of the reconciliation (pg-boss
        // retries a rejected dead-letter job right away), the time to show.
        await setTimeout(2_000);

        assert.deepStrictEqual(
          {
            orphans: storage.queue.orphans.map(({ streamId }) => streamId),
            settled,
            warnings,
            status: (await runtime.observe(conversation).status(crashed.id))
              ?.status,
          },
          {
            orphans: [crashed.id],
            settled: [conversation.chatId],
            warnings: [availabilityFailure(conversation.chatId)],
            status: 'failed',
          },
        );
      });
    });
  });
}
