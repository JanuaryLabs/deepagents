import { PGlite } from '@electric-sql/pglite';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { type TestContext, type TestOptions, suite, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  type ConstructorOptions,
  type FindJobsOptions,
  type JobWithMetadata,
  PgBoss,
  fromPglite,
} from 'pg-boss';
import { v5 as uuidv5 } from 'uuid';

import type {
  PgBossTurnQueueOptions,
  TurnQueue,
  TurnRef,
} from '@deepagents/experimental/zukhruf';
import { PgBossTurnQueue } from '@deepagents/experimental/zukhruf';
import { isDockerAvailable, withPostgresContainer } from '@deepagents/test';

/**
 * Behavioral contract every TurnQueue implementation must pass.
 *
 * The runtime is built on exactly these guarantees — several of which the
 * pg-boss implementation gets from backend-specific behavior (duplicate job
 * id resolves null, job rows retained after completion, key blocking on
 * failure). This suite pins them as observable behavior so swapping or
 * upgrading a backend cannot silently change the semantics.
 *
 */
interface TurnQueueHarness extends AsyncDisposable {
  queue: TurnQueue;
}

interface PostgresQueueHarness extends TurnQueueHarness {
  connectionString: string;
  queue: PgBossTurnQueue;
}

interface PostgresQueueHarnessOptions {
  boss?: Pick<
    ConstructorOptions,
    'monitorIntervalSeconds' | 'superviseIntervalSeconds'
  >;
  queue?: PgBossTurnQueueOptions;
}

interface TurnQueueContract {
  name: string;
  makeQueue: () => Promise<TurnQueueHarness>;
  skip?: TestOptions['skip'];
  sameChatFifoTodo?: TestOptions['todo'];
}

function waitFor(
  t: TestContext,
  condition: () => boolean,
  what: string,
  timeoutMs = 10_000,
): Promise<void> {
  return t.waitFor(
    () => assert.ok(condition(), `timed out waiting for: ${what}`),
    { interval: 25, timeout: timeoutMs },
  );
}

async function waitForAsync(
  condition: () => Promise<boolean>,
  what: string,
  timeoutMs = 10_000,
) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (await condition()) return;
    await sleep(25);
  }
  throw new Error(`timed out waiting for: ${what}`);
}

type AskRef = Extract<TurnRef, { kind: 'ask' }>;

function inputOf(turn: TurnRef): string {
  if (turn.kind !== 'ask') {
    throw new Error('contract test only pushes ask turns');
  }
  return turn.input;
}

/** Deliberately NOT a UUID — ids are opaque strings as far as the port goes. */
function ref(chat: string, n: number): AskRef {
  return {
    kind: 'ask',
    streamId: `turn/${chat}#${n}:${crypto.randomUUID()}`,
    chatId: chat,
    userId: 'u1',
    input: `input-${n}`,
  };
}

type ApprovalRef = Extract<TurnRef, { kind: 'approval' }>;

function approvalRef(
  chat: string,
  decision: ApprovalRef['decision'] = { approved: true },
): ApprovalRef {
  return {
    kind: 'approval',
    streamId: `turn/${chat}#approval:${crypto.randomUUID()}`,
    chatId: chat,
    userId: 'u1',
    toolCallId: 'tool-call-1',
    approvalId: 'approval-1',
    decision,
  };
}

const noOrphans = { onOrphaned: async () => {} };
const dockerAvailable = await isDockerAvailable();

const turnQueueContracts = [
  {
    name: 'PgBossTurnQueue (postgres)',
    makeQueue: postgresQueueHarness,
    skip: dockerAvailable ? false : 'Docker is unavailable',
    sameChatFifoTodo:
      'pg-boss workers can claim same-key jobs out of FIFO order',
  },
  {
    name: 'PgBossTurnQueue (pglite)',
    makeQueue: pgliteQueueHarness,
  },
] satisfies TurnQueueContract[];

for (const contract of turnQueueContracts) {
  suite(
    `TurnQueue contract — ${contract.name}`,
    { skip: contract.skip },
    () => {
      test('delivers a turn pushed before any consumer existed, payload intact', async (t) => {
        await using h = await contract.makeQueue();
        const pushed = ref('durable', 1);
        await h.queue.push(pushed);
        await sleep(300);

        const seen: TurnRef[] = [];
        await using _consumer = await h.queue.consume(async (turn) => {
          seen.push(turn);
        }, noOrphans);

        await waitFor(
          t,
          () => seen.length === 1,
          'late consumer receives turn',
        );
        assert.deepStrictEqual(seen[0], pushed);
      });

      test('reports queued and active scheduler work until the turn settles', async () => {
        await using h = await contract.makeQueue();
        const turn = ref('status', 1);
        const conversation = { chatId: turn.chatId, userId: turn.userId };
        assert.equal(await h.queue.getTurnActivity(conversation), 'idle');

        await h.queue.push(turn);
        assert.equal(await h.queue.getTurnActivity(conversation), 'queued');

        const started = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        await using _consumer = await h.queue.consume(async () => {
          started.resolve();
          await release.promise;
        }, noOrphans);
        try {
          assert.equal(
            await Promise.race([
              started.promise.then(() => true),
              sleep(5_000).then(() => false),
            ]),
            true,
            'active handler starts',
          );
          assert.equal(await h.queue.getTurnActivity(conversation), 'running');

          release.resolve();
          await waitForAsync(
            async () =>
              (await h.queue.getTurnActivity(conversation)) === 'idle',
            'settled turn disappears from scheduler status',
          );
        } finally {
          release.resolve();
        }
      });

      test('finds and cancels every copy of the oldest queued stream id', async (t) => {
        await using h = await contract.makeQueue();
        const first = ref('interrupt-queued', 1);
        const second = ref('interrupt-queued', 2);
        await h.queue.push(first);
        await h.queue.push(first);
        await h.queue.push(second);

        assert.deepStrictEqual(
          await h.queue.getCurrentTurn({
            chatId: first.chatId,
            userId: first.userId,
          }),
          first,
        );
        await h.queue.cancel(first.streamId);
        assert.deepStrictEqual(
          await h.queue.getCurrentTurn({
            chatId: first.chatId,
            userId: first.userId,
          }),
          second,
        );

        const seen: TurnRef[] = [];
        await using _consumer = await h.queue.consume(async (turn) => {
          seen.push(turn);
        }, noOrphans);
        await waitFor(
          t,
          () => seen.length === 1,
          'successor runs after cancellation',
        );
        assert.deepStrictEqual(seen, [second]);
      });

      test('cancelling an active turn aborts its handler without overlapping its successor', async (t) => {
        await using h = await contract.makeQueue();
        const first = ref('interrupt-active', 1);
        const second = ref('interrupt-active', 2);
        await h.queue.push(first);
        await h.queue.push(second);

        const started = Promise.withResolvers<void>();
        const aborted = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const successorStarted = Promise.withResolvers<void>();
        const seen: TurnRef[] = [];
        await using _consumer = await h.queue.consume(
          async (turn, context) => {
            if (turn.streamId !== first.streamId) {
              seen.push(turn);
              successorStarted.resolve();
              return;
            }
            started.resolve();
            await once(context.signal, 'abort');
            aborted.resolve();
            await release.promise;
          },
          { ...noOrphans, concurrency: 2 },
        );

        try {
          assert.equal(
            await Promise.race([
              started.promise.then(() => true),
              sleep(5_000).then(() => false),
            ]),
            true,
            'active handler starts',
          );
          assert.deepStrictEqual(
            await h.queue.getCurrentTurn({
              chatId: first.chatId,
              userId: first.userId,
            }),
            first,
          );
          await h.queue.cancel(first.streamId);
          assert.equal(
            await Promise.race([
              aborted.promise.then(() => true),
              sleep(5_000).then(() => false),
            ]),
            true,
            'active handler observes cancellation',
          );
          const overlapped = await Promise.race([
            successorStarted.promise.then(() => true),
            sleep(1_200).then(() => false),
          ]);
          const ownerWhileInterrupted = await h.queue.getCurrentTurn({
            chatId: first.chatId,
            userId: first.userId,
          });
          release.resolve();
          assert.equal(
            overlapped,
            false,
            'strict FIFO key stays owned until the interrupted handler exits',
          );
          assert.deepStrictEqual(
            ownerWhileInterrupted,
            first,
            'the active row remains the scheduler owner while its handler exits',
          );
          await waitFor(
            t,
            () => seen.length === 1,
            'successor runs after active abort',
          );
          assert.deepStrictEqual(seen, [second]);
          await waitForAsync(
            async () =>
              (await h.queue.getTurnActivity({
                chatId: first.chatId,
                userId: first.userId,
              })) === 'idle',
            'interrupted and successor rows are commit-deleted',
          );
        } finally {
          release.resolve();
        }
      });

      test('a duplicate push never delivers concurrently, out of order, or not at all', async (t) => {
        await using h = await contract.makeQueue();
        const ask = ref('dup', 1);
        await h.queue.push(ask);
        await h.queue.push(ask);

        let deliveries = 0;
        let active = 0;
        let maxActive = 0;
        await using _consumer = await h.queue.consume(
          async () => {
            active++;
            maxActive = Math.max(maxActive, active);
            await sleep(150);
            active--;
            deliveries++;
          },
          { ...noOrphans, concurrency: 4 },
        );

        await waitFor(t, () => deliveries >= 1, 'turn delivered at least once');
        await sleep(1500);
        // At-least-once: an implementation may dedup (1) or redeliver (2),
        // but never lose the turn, exceed the duplicate count, or interleave.
        assert.ok(
          deliveries >= 1 && deliveries <= 2,
          `deliveries: ${deliveries}`,
        );
        assert.equal(maxActive, 1, 'duplicates never run concurrently');
      });

      test('deduplicates opposite commands for one persisted approval id', async (t) => {
        await using h = await contract.makeQueue();
        const approve = approvalRef('approval-dedup');
        const deny = {
          ...approve,
          decision: { approved: false, reason: 'no' },
        } satisfies ApprovalRef;

        const first = await h.queue.push(approve);
        const second = await h.queue.push(deny);
        const namespace = uuidv5(
          JSON.stringify([approve.userId, approve.chatId]),
          uuidv5.URL,
        );
        const expectedId = uuidv5(`approval:${approve.approvalId}`, namespace);
        assert.deepStrictEqual(first, {
          jobId: expectedId,
          inserted: true,
        });
        assert.deepStrictEqual(second, {
          jobId: expectedId,
          inserted: false,
        });

        const seen: TurnRef[] = [];
        await using _consumer = await h.queue.consume(async (turn) => {
          seen.push(turn);
        }, noOrphans);
        await waitFor(
          t,
          () => seen.length === 1,
          'the winning approval command',
        );
        await sleep(1_000);
        assert.deepStrictEqual(seen, [approve]);
      });

      test(
        'turns in one chat run strictly FIFO, one at a time',
        { todo: contract.sameChatFifoTodo },
        async (t) => {
          await using h = await contract.makeQueue();
          for (const n of [1, 2, 3]) await h.queue.push(ref('fifo', n));

          const events: string[] = [];
          await using _consumer = await h.queue.consume(
            async (turn) => {
              events.push(`start ${inputOf(turn)}`);
              await sleep(250);
              events.push(`end ${inputOf(turn)}`);
            },
            { ...noOrphans, concurrency: 4 },
          );

          await waitFor(
            t,
            () => events.length === 6,
            'all three turns finished',
          );
          assert.deepStrictEqual(events, [
            'start input-1',
            'end input-1',
            'start input-2',
            'end input-2',
            'start input-3',
            'end input-3',
          ]);
        },
      );

      test('turns in different chats can overlap', async (t) => {
        await using h = await contract.makeQueue();
        const gate = Promise.withResolvers<void>();
        const outcome: Record<string, string> = {};

        await h.queue.push(ref('over-a', 1));
        await h.queue.push(ref('over-b', 2));

        await using _consumer = await h.queue.consume(
          async (turn) => {
            if (turn.chatId === 'over-a') {
              outcome.a = await Promise.race([
                gate.promise.then(() => 'overlapped'),
                sleep(5000).then(() => 'timed-out'),
              ]);
            } else {
              gate.resolve();
              outcome.b = 'done';
            }
          },
          { ...noOrphans, concurrency: 2 },
        );

        await waitFor(
          t,
          () => Boolean(outcome.a && outcome.b),
          'both chats done',
        );
        assert.equal(
          outcome.a,
          'overlapped',
          'chat A finished only after chat B started — cross-chat concurrency',
        );
      });

      test('one busy chat does not block a ready turn in another chat', async (t) => {
        await using h = await contract.makeQueue();
        const active = ref('busy-chat', 1);
        const blockedSuccessor = ref('busy-chat', 2);
        const independent = ref('independent-chat', 3);
        const releaseActive = Promise.withResolvers<void>();
        const started: TurnRef[] = [];
        let successorsQueued = false;

        await h.queue.push(active);
        await using _consumer = await h.queue.consume(
          async (turn) => {
            started.push(turn);
            if (turn.streamId !== active.streamId) return;

            await h.queue.push(blockedSuccessor);
            await h.queue.push(independent);
            successorsQueued = true;
            await releaseActive.promise;
          },
          { ...noOrphans, concurrency: 4 },
        );

        try {
          await waitFor(t, () => successorsQueued, 'successors are queued');
          await waitFor(
            t,
            () =>
              started.some((turn) => turn.streamId === independent.streamId),
            'ready turn in the independent chat',
            3_000,
          );
          assert.deepStrictEqual(
            started.map((turn) => turn.streamId),
            [active.streamId, independent.streamId],
          );
        } finally {
          releaseActive.resolve();
        }
      });

      test('caps active handlers at the consume concurrency', async (t) => {
        await using h = await contract.makeQueue();
        for (const n of [1, 2, 3, 4, 5, 6]) {
          await h.queue.push(ref(`cap-${n}`, n));
        }

        let done = 0;
        let active = 0;
        let maxActive = 0;
        await using _consumer = await h.queue.consume(
          async () => {
            active++;
            maxActive = Math.max(maxActive, active);
            await sleep(300);
            active--;
            done++;
          },
          { ...noOrphans, concurrency: 2 },
        );

        await waitFor(t, () => done === 6, 'all six chats processed', 20_000);
        assert.ok(
          maxActive <= 2,
          `never more than the configured concurrency (saw ${maxActive})`,
        );
      });

      test('a crashing handler surfaces exactly once via onOrphaned, then the chat unblocks', async (t) => {
        await using h = await contract.makeQueue();
        const boom = ref('crash', 1);
        const next = ref('crash', 2);
        await h.queue.push(boom);
        await h.queue.push(next);

        const invocations: string[] = [];
        const orphans: Array<{ streamId: string; error: string }> = [];
        await using _consumer = await h.queue.consume(
          async (turn) => {
            invocations.push(inputOf(turn));
            if (turn.streamId === boom.streamId) throw new Error('kaput');
          },
          {
            onOrphaned: async (turn, error) => {
              orphans.push({ streamId: turn.streamId, error });
            },
          },
        );

        await waitFor(
          t,
          () => invocations.includes(next.input) && orphans.length === 1,
          'orphan reported and chat unblocked',
          20_000,
        );
        await sleep(500);
        assert.deepStrictEqual(
          invocations,
          [boom.input, next.input],
          'crashed turn ran exactly once (no retry), successor ran after it',
        );
        assert.equal(orphans.length, 1, 'orphan surfaced exactly once');
        assert.equal(orphans[0].streamId, boom.streamId);
        assert.match(orphans[0].error, /kaput/);
      });

      test('an orphan callback failure cannot keep the next same-chat turn blocked', async (t) => {
        await using h = await contract.makeQueue();
        const boom = ref('orphan-callback-failure', 1);
        const next = ref('orphan-callback-failure', 2);
        await h.queue.push(boom);
        await h.queue.push(next);

        const invocations: string[] = [];
        let orphanAttempts = 0;
        await using _consumer = await h.queue.consume(
          async (turn) => {
            invocations.push(inputOf(turn));
            if (turn.streamId === boom.streamId) throw new Error('kaput');
          },
          {
            onOrphaned: async () => {
              orphanAttempts++;
              throw new Error('projection unavailable');
            },
          },
        );

        await waitFor(
          t,
          () => invocations.includes(next.input),
          'source acknowledgement unblocks the successor despite callback failure',
          5_000,
        );
        assert.ok(orphanAttempts >= 1);
        assert.deepStrictEqual(invocations, [boom.input, next.input]);
      });

      test('a parked turn is not redelivered until resumeParked; revival preserves order', async (t) => {
        await using h = await contract.makeQueue();
        let gateOpen = false;
        const parked: string[] = [];
        const ran: string[] = [];
        await using _consumer = await h.queue.consume(
          async (turn, context) => {
            if (turn.kind !== 'ask') return;
            if (!gateOpen) {
              parked.push(turn.input);
              await context.park();
              return;
            }
            ran.push(turn.input);
          },
          { ...noOrphans, concurrency: 2 },
        );

        await h.queue.push(ref('gated', 1));
        await h.queue.push(ref('gated', 2));
        await waitFor(t, () => parked.length === 2, 'both turns parked');
        await sleep(1500);
        assert.deepStrictEqual(
          parked,
          ['input-1', 'input-2'],
          'parked once each — no redelivery',
        );
        assert.deepStrictEqual(ran, [], 'nothing executed while parked');

        gateOpen = true;
        await sleep(1200);
        assert.deepStrictEqual(
          ran,
          [],
          'opening the gate alone revives nothing',
        );

        await h.queue.resumeParked('gated');
        await waitFor(t, () => ran.length === 2, 'parked turns revived');
        assert.deepStrictEqual(
          ran,
          ['input-1', 'input-2'],
          'original FIFO order preserved',
        );
      });

      test('an approval command outranks revived parked turns of its chat', async (t) => {
        await using h = await contract.makeQueue();
        const ran: string[] = [];

        let parkCount = 0;
        const gatekeeper = await h.queue.consume(async (_turn, context) => {
          parkCount++;
          await context.park();
        }, noOrphans);
        await h.queue.push(ref('ranked', 1));
        await waitFor(t, () => parkCount === 1, 'turn parked');
        await gatekeeper[Symbol.asyncDispose]();

        await h.queue.push(approvalRef('ranked'));
        await h.queue.resumeParked('ranked');

        await using _consumer = await h.queue.consume(async (turn) => {
          ran.push(turn.kind);
        }, noOrphans);

        await waitFor(t, () => ran.length === 2, 'both delivered');
        assert.deepStrictEqual(
          ran,
          ['approval', 'ask'],
          'approval runs before the revived (older created_on) parked turn',
        );
      });

      test('settlement releases FIFO ownership before follow-up reconciliation', async (t) => {
        await using h = await contract.makeQueue();
        const first = ref('settlement', 1);
        const second = ref('settlement', 2);
        const settled: string[] = [];

        await h.queue.push(first);
        await h.queue.push(second);
        await using _consumer = await h.queue.consume(async () => {}, {
          ...noOrphans,
          onSettled: async (turn) => {
            settled.push(turn.streamId);
            assert.notEqual(
              await h.queue.getTurnActivity(turn),
              'running',
              'the completed job no longer owns the conversation',
            );
          },
        });

        await waitFor(t, () => settled.length === 2, 'both turns settle');
        assert.deepStrictEqual(settled, [first.streamId, second.streamId]);
      });

      test('disposal stops delivery; a later consumer picks up the backlog', async (t) => {
        await using h = await contract.makeQueue();
        let executions = 0;
        const consumer = await h.queue.consume(async () => {
          executions++;
        }, noOrphans);
        await consumer[Symbol.asyncDispose]();

        await h.queue.push(ref('backlog', 1));
        await sleep(1500);
        assert.equal(executions, 0, 'disposed consumer receives nothing');

        await using _revived = await h.queue.consume(async () => {
          executions++;
        }, noOrphans);
        await waitFor(
          t,
          () => executions === 1,
          'new consumer drains the backlog',
        );
      });
    },
  );
}

suite(
  'PgBossTurnQueue real PostgreSQL scheduler regressions',
  { skip: dockerAvailable ? false : 'Docker is unavailable' },
  () => {
    test('preserves each chat insertion order under concurrent consumption', async (t) => {
      await using h = await postgresQueueHarness();
      const chatIds = Array.from(
        { length: 8 },
        (_, index) => `fifo-regression-${index}`,
      );
      const turnNumbers = [1, 2, 3, 4, 5];
      const seen = new Map(chatIds.map((chatId) => [chatId, [] as string[]]));

      for (const chatId of chatIds) {
        for (const turnNumber of turnNumbers) {
          await h.queue.push(ref(chatId, turnNumber));
        }
      }

      let deliveries = 0;
      await using _consumer = await h.queue.consume(
        async (turn) => {
          const chat = seen.get(turn.chatId);
          assert.ok(chat, `unexpected chat: ${turn.chatId}`);
          chat.push(inputOf(turn));
          deliveries++;
          await sleep(50);
        },
        { ...noOrphans, concurrency: 8 },
      );

      await waitFor(
        t,
        () => deliveries === chatIds.length * turnNumbers.length,
        'all real-Postgres FIFO regression turns',
        30_000,
      );
      const expected = turnNumbers.map((number) => `input-${number}`);
      for (const chatId of chatIds) {
        assert.deepStrictEqual(seen.get(chatId), expected, chatId);
      }
    });

    test('preserves per-chat FIFO across independent consumer instances', async (t) => {
      await using h = await postgresQueueHarness();
      const peerBoss = new PgBoss({ connectionString: h.connectionString });
      peerBoss.on('error', () => {});
      let firstConsumer: AsyncDisposable | undefined;
      let secondConsumer: AsyncDisposable | undefined;

      try {
        await peerBoss.start();
        const peerQueue = new PgBossTurnQueue(peerBoss, {
          pollingIntervalSeconds: 0.5,
        });
        await peerQueue.initialize();

        const chatIds = Array.from(
          { length: 8 },
          (_, index) => `multi-consumer-fifo-${index}`,
        );
        const turnNumbers = [1, 2, 3, 4, 5];
        const seen = new Map(chatIds.map((chatId) => [chatId, [] as string[]]));
        const active = new Map(chatIds.map((chatId) => [chatId, 0]));
        const maxActive = new Map(chatIds.map((chatId) => [chatId, 0]));

        for (const chatId of chatIds) {
          for (const turnNumber of turnNumbers) {
            await h.queue.push(ref(chatId, turnNumber));
          }
        }

        let deliveries = 0;
        const handle = async (turn: TurnRef) => {
          const current = (active.get(turn.chatId) ?? 0) + 1;
          active.set(turn.chatId, current);
          maxActive.set(
            turn.chatId,
            Math.max(maxActive.get(turn.chatId) ?? 0, current),
          );
          try {
            const chat = seen.get(turn.chatId);
            assert.ok(chat, `unexpected chat: ${turn.chatId}`);
            chat.push(inputOf(turn));
            deliveries++;
            await sleep(50);
          } finally {
            active.set(turn.chatId, current - 1);
          }
        };

        firstConsumer = await h.queue.consume(handle, {
          ...noOrphans,
          concurrency: 4,
        });
        secondConsumer = await peerQueue.consume(handle, {
          ...noOrphans,
          concurrency: 4,
        });

        await waitFor(
          t,
          () => deliveries === chatIds.length * turnNumbers.length,
          'all turns consumed across both PgBoss instances',
          30_000,
        );
        const expected = turnNumbers.map((number) => `input-${number}`);
        for (const chatId of chatIds) {
          assert.deepStrictEqual(seen.get(chatId), expected, chatId);
          assert.equal(
            maxActive.get(chatId),
            1,
            `${chatId} never overlaps across consumer instances`,
          );
        }
      } finally {
        await firstConsumer?.[Symbol.asyncDispose]();
        await secondConsumer?.[Symbol.asyncDispose]();
        await peerBoss.stop({ graceful: false });
      }
    });

    test('isolates a handler failure from another active chat', async (t) => {
      await using h = await postgresQueueHarness();
      const failing = ref('failure-isolation-a', 1);
      const healthy = ref('failure-isolation-b', 1);
      const failingStarted = Promise.withResolvers<void>();
      const healthyStarted = Promise.withResolvers<void>();
      const releaseHealthy = Promise.withResolvers<void>();
      const completed: string[] = [];
      const orphaned: string[] = [];

      await h.queue.push(failing);
      await h.queue.push(healthy);
      await using _consumer = await h.queue.consume(
        async (turn) => {
          if (turn.streamId === failing.streamId) {
            failingStarted.resolve();
            await healthyStarted.promise;
            throw new Error('isolated failure');
          }

          healthyStarted.resolve();
          await failingStarted.promise;
          await releaseHealthy.promise;
          completed.push(turn.streamId);
        },
        {
          concurrency: 2,
          onOrphaned: async (turn) => {
            orphaned.push(turn.streamId);
          },
        },
      );

      try {
        await Promise.all([failingStarted.promise, healthyStarted.promise]);
        releaseHealthy.resolve();
        await waitFor(
          t,
          () => completed.length === 1 && orphaned.length === 1,
          'healthy completion and isolated orphan reconciliation',
          20_000,
        );
        assert.deepStrictEqual(completed, [healthy.streamId]);
        assert.deepStrictEqual(orphaned, [failing.streamId]);
      } finally {
        releaseHealthy.resolve();
      }
    });

    test('heartbeats every concurrently active handler', async (t) => {
      await using h = await postgresQueueHarness({
        boss: { monitorIntervalSeconds: 2, superviseIntervalSeconds: 2 },
        queue: { heartbeatSeconds: 10 },
      });
      const turns = [ref('heartbeat-a', 1), ref('heartbeat-b', 1)];
      const release = Promise.withResolvers<void>();
      const started = new Set<string>();
      const completed: string[] = [];
      const orphaned: string[] = [];

      for (const turn of turns) await h.queue.push(turn);
      await using _consumer = await h.queue.consume(
        async (turn) => {
          started.add(turn.streamId);
          await release.promise;
          completed.push(turn.streamId);
        },
        {
          concurrency: 2,
          onOrphaned: async (turn) => {
            orphaned.push(turn.streamId);
          },
        },
      );

      try {
        await waitFor(
          t,
          () => started.size === 2,
          'both heartbeat turns active',
        );
        await sleep(13_000);
        assert.deepStrictEqual(
          orphaned,
          [],
          'live handlers never appear orphaned',
        );
        for (const turn of turns) {
          assert.equal(
            await h.queue.getTurnActivity(turn),
            'running',
            `${turn.chatId} remains active past the heartbeat deadline`,
          );
        }

        release.resolve();
        await waitFor(
          t,
          () => completed.length === 2,
          'both live handlers finish',
        );
      } finally {
        release.resolve();
      }
    });

    test('disposal returns during active work and stops new claims', async (t) => {
      await using h = await postgresQueueHarness();
      const active = ref('dispose-active', 1);
      const queued = ref('dispose-queued', 1);
      const activeStarted = Promise.withResolvers<void>();
      const releaseActive = Promise.withResolvers<void>();
      const seen: string[] = [];
      let consumer: AsyncDisposable | undefined;
      let disposing: Promise<void> | undefined;
      let replacement: AsyncDisposable | undefined;

      try {
        await h.queue.push(active);
        consumer = await h.queue.consume(async (turn) => {
          seen.push(turn.streamId);
          activeStarted.resolve();
          await releaseActive.promise;
        }, noOrphans);
        await activeStarted.promise;
        await h.queue.push(queued);

        disposing = Promise.resolve(consumer[Symbol.asyncDispose]());
        assert.equal(
          await Promise.race([
            disposing.then(() => 'disposed'),
            sleep(2_000).then(() => 'timed-out'),
          ]),
          'disposed',
          'disposal does not wait for the active handler',
        );
        consumer = undefined;
        await sleep(500);
        assert.deepStrictEqual(
          seen,
          [active.streamId],
          'the stopped consumer does not claim queued work',
        );
        assert.equal(
          await h.queue.getTurnActivity(active),
          'running',
          'the active handler keeps its claim until it exits',
        );

        releaseActive.resolve();

        replacement = await h.queue.consume(async (turn) => {
          seen.push(turn.streamId);
        }, noOrphans);
        await waitFor(
          t,
          () => seen.length === 2,
          'replacement consumes queued turn',
        );
        assert.deepStrictEqual(seen, [active.streamId, queued.streamId]);
      } finally {
        releaseActive.resolve();
        await disposing;
        await consumer?.[Symbol.asyncDispose]();
        await replacement?.[Symbol.asyncDispose]();
      }
    });
  },
);

async function postgresQueueHarness(
  options: PostgresQueueHarnessOptions = {},
): Promise<PostgresQueueHarness> {
  const ready = Promise.withResolvers<PostgresQueueHarness>();
  const release = Promise.withResolvers<void>();
  const lifecycle = withPostgresContainer(async (container) => {
    const boss = new PgBoss({
      connectionString: container.connectionString,
      ...options.boss,
    });
    boss.on('error', () => {});
    try {
      await boss.start();
      const queue = new PgBossTurnQueue(boss, {
        pollingIntervalSeconds: 0.5,
        ...options.queue,
      });
      await queue.initialize();
      ready.resolve({
        connectionString: container.connectionString,
        queue,
        async [Symbol.asyncDispose]() {
          release.resolve();
          await lifecycle;
        },
      });
      await release.promise;
    } catch (error) {
      ready.reject(error);
      throw error;
    } finally {
      await boss.stop({ graceful: false });
    }
  });
  void lifecycle.then(
    (result) => {
      if (result === undefined) {
        ready.reject(new Error('PostgreSQL test container is unavailable'));
      }
    },
    (error: unknown) => ready.reject(error),
  );
  return ready.promise;
}

async function pgliteQueueHarness(): Promise<TurnQueueHarness> {
  const pglite = new PGlite();
  const boss = new PgBoss({ db: fromPglite(pglite), backend: 'pglite' });
  boss.on('error', () => {});
  await boss.start();
  const queue = new PgBossTurnQueue(boss, {
    pollingIntervalSeconds: 0.5,
    schema: 'pgboss',
  });
  await queue.initialize();
  return {
    queue,
    async [Symbol.asyncDispose]() {
      await boss.stop({ graceful: false });
      await pglite.close();
    },
  };
}

test('does not delete or overlap a turn claimed after the cancellation snapshot', async () => {
  const pglite = new PGlite();
  const boss = new PgBoss({ db: fromPglite(pglite), backend: 'pglite' });
  boss.on('error', () => {});
  await boss.start();
  const queue = new PgBossTurnQueue(boss, {
    pollingIntervalSeconds: 0.5,
    schema: 'pgboss',
  });
  await queue.initialize();

  const first = ref('interrupt-claim-race', 1);
  const second = ref('interrupt-claim-race', 2);
  await queue.push(first);
  await queue.push(second);

  type FindTurns = (
    name: string,
    options?: FindJobsOptions,
  ) => Promise<JobWithMetadata<TurnRef>[]>;
  const mutableBoss = boss as unknown as { findJobs: FindTurns };
  const originalFindJobs = mutableBoss.findJobs.bind(boss);
  const snapshotTaken = Promise.withResolvers<void>();
  const releaseSnapshot = Promise.withResolvers<void>();
  mutableBoss.findJobs = async (name, options) => {
    const jobs = await originalFindJobs(name, options);
    if (
      (options?.data as Partial<TurnRef> | undefined)?.streamId ===
      first.streamId
    ) {
      snapshotTaken.resolve();
      await releaseSnapshot.promise;
    }
    return jobs;
  };

  const firstStarted = Promise.withResolvers<void>();
  const releaseFirst = Promise.withResolvers<void>();
  const successorStarted = Promise.withResolvers<void>();
  let lateActiveSignalAborted = false;
  let worker: AsyncDisposable | undefined;
  let cancelling: Promise<void> | undefined;
  try {
    cancelling = queue.cancel(first.streamId);
    assert.equal(
      await Promise.race([
        snapshotTaken.promise.then(() => true),
        sleep(5_000).then(() => false),
      ]),
      true,
      'cancellation captures the queued snapshot',
    );
    worker = await queue.consume(
      async (turn, context) => {
        if (turn.streamId !== first.streamId) {
          successorStarted.resolve();
          return;
        }
        lateActiveSignalAborted = context.signal.aborted;
        context.signal.addEventListener(
          'abort',
          () => {
            lateActiveSignalAborted = true;
          },
          { once: true },
        );
        firstStarted.resolve();
        await releaseFirst.promise;
      },
      { ...noOrphans, concurrency: 2 },
    );
    assert.equal(
      await Promise.race([
        firstStarted.promise.then(() => true),
        sleep(5_000).then(() => false),
      ]),
      true,
      'worker claims the snapshotted turn',
    );
    releaseSnapshot.resolve();
    assert.equal(
      await Promise.race([
        cancelling.then(() => true),
        sleep(5_000).then(() => false),
      ]),
      true,
      'state-conditional cancellation settles after the claim',
    );

    const overlapped = await Promise.race([
      successorStarted.promise.then(() => true),
      sleep(1_200).then(() => false),
    ]);
    releaseFirst.resolve();
    assert.equal(
      lateActiveSignalAborted,
      true,
      'the post-mutation active scan signals a locally claimed handler',
    );
    assert.equal(
      overlapped,
      false,
      'a stale queued snapshot cannot delete the now-active FIFO owner',
    );
    const successorRan = await Promise.race([
      successorStarted.promise.then(() => true),
      sleep(5_000).then(() => false),
    ]);
    assert.equal(
      successorRan,
      true,
      'the successor eventually becomes eligible',
    );
    await waitForAsync(
      async () =>
        (await queue.getTurnActivity({
          chatId: first.chatId,
          userId: first.userId,
        })) === 'idle',
      'claimed turn and successor finish commit-driven cleanup',
    );
  } finally {
    releaseSnapshot.resolve();
    releaseFirst.resolve();
    mutableBoss.findJobs = originalFindJobs;
    await cancelling?.catch(() => undefined);
    await worker?.[Symbol.asyncDispose]();
    await boss.stop({ graceful: false });
    await pglite.close();
  }
});

test('delivers cancellation to a local handler registered after cancel returns', async () => {
  const pglite = new PGlite();
  const boss = new PgBoss({ db: fromPglite(pglite), backend: 'pglite' });
  boss.on('error', () => {});
  await boss.start();
  const queue = new PgBossTurnQueue(boss, {
    pollingIntervalSeconds: 0.5,
    schema: 'pgboss',
  });
  await queue.initialize();
  const first = ref('late-registration', 1);
  const second = ref('late-registration', 2);

  type Work = (...args: unknown[]) => Promise<string>;
  const mutableBoss = boss as unknown as { work: Work };
  const originalWork = mutableBoss.work.bind(boss);
  const claimed = Promise.withResolvers<void>();
  const registerHandler = Promise.withResolvers<void>();
  mutableBoss.work = async (...args) => {
    const [name, options, candidate] = args;
    const handler = candidate as (
      jobs: Array<{ data: TurnRef }>,
    ) => Promise<void>;
    return originalWork(name, options, async (jobs: unknown) => {
      const turns = jobs as Array<{ data: TurnRef }>;
      if (name === queue.queue && turns[0]?.data.streamId === first.streamId) {
        claimed.resolve();
        await registerHandler.promise;
      }
      return handler(turns);
    });
  };

  const firstStarted = Promise.withResolvers<void>();
  const releaseFirst = Promise.withResolvers<void>();
  const successorStarted = Promise.withResolvers<void>();
  let firstSignalAborted = false;
  let worker: AsyncDisposable | undefined;
  let otherWorker: AsyncDisposable | undefined;
  try {
    worker = await queue.consume(
      async (turn, context) => {
        if (turn.streamId !== first.streamId) {
          successorStarted.resolve();
          return;
        }
        firstSignalAborted = context.signal.aborted;
        firstStarted.resolve();
        await releaseFirst.promise;
      },
      { ...noOrphans, concurrency: 2 },
    );
    await queue.push(first);
    await queue.push(second);
    assert.equal(
      await Promise.race([
        claimed.promise.then(() => true),
        sleep(5_000).then(() => false),
      ]),
      true,
      'pg-boss claims the turn before adapter controller registration',
    );
    await queue.cancel(first.streamId);
    otherWorker = await queue.consume(async () => {}, noOrphans);
    await otherWorker[Symbol.asyncDispose]();
    otherWorker = undefined;
    registerHandler.resolve();
    assert.equal(
      await Promise.race([
        firstStarted.promise.then(() => true),
        sleep(5_000).then(() => false),
      ]),
      true,
      'delayed handler registers',
    );
    assert.equal(
      firstSignalAborted,
      true,
      'the cancellation tombstone aborts a late local registration',
    );
    const overlapped = await Promise.race([
      successorStarted.promise.then(() => true),
      sleep(1_200).then(() => false),
    ]);
    releaseFirst.resolve();
    assert.equal(overlapped, false);
    assert.equal(
      await Promise.race([
        successorStarted.promise.then(() => true),
        sleep(5_000).then(() => false),
      ]),
      true,
      'successor runs after the interrupted handler exits',
    );
    await waitForAsync(
      async () =>
        (await queue.getTurnActivity({
          chatId: first.chatId,
          userId: first.userId,
        })) === 'idle',
      'late-registration turn and successor clean up',
    );
  } finally {
    registerHandler.resolve();
    releaseFirst.resolve();
    mutableBoss.work = originalWork;
    await otherWorker?.[Symbol.asyncDispose]();
    await worker?.[Symbol.asyncDispose]();
    await boss.stop({ graceful: false });
    await pglite.close();
  }
});

test('fails fast when a custom-adapter schema is omitted and accepts it explicitly', async () => {
  const pglite = new PGlite();
  const schema = 'custom_pgboss';
  const decoyBoss = new PgBoss({
    db: fromPglite(pglite),
    backend: 'pglite',
  });
  decoyBoss.on('error', () => {});
  await decoyBoss.start();
  const decoyQueue = new PgBossTurnQueue(decoyBoss, {
    pollingIntervalSeconds: 0.5,
    schema: 'pgboss',
  });
  await decoyQueue.initialize();
  await decoyBoss.stop({ graceful: false });

  const boss = new PgBoss({
    db: fromPglite(pglite),
    backend: 'pglite',
    schema,
  });
  boss.on('error', () => {});
  await boss.start();
  try {
    assert.throws(
      () =>
        new PgBossTurnQueue(boss, {
          expireInSeconds: Number.POSITIVE_INFINITY,
          pollingIntervalSeconds: 0.5,
          schema,
        }),
      /expireInSeconds must be a finite positive duration/,
    );
    const mismatched = new PgBossTurnQueue(boss, {
      pollingIntervalSeconds: 0.5,
    });
    await assert.rejects(
      mismatched.initialize(),
      /pass the PgBoss schema in options\.schema/,
    );

    type CreateQueue = (...args: unknown[]) => Promise<void>;
    const mutableBoss = boss as unknown as { createQueue: CreateQueue };
    const originalCreateQueue = mutableBoss.createQueue.bind(boss);
    const createdQueues: string[] = [];
    mutableBoss.createQueue = async (...args) => {
      createdQueues.push(String(args[0]));
      return originalCreateQueue(...args);
    };
    const queue = new PgBossTurnQueue(boss, {
      pollingIntervalSeconds: 0.5,
      schema,
    });
    try {
      await queue.initialize();
    } finally {
      mutableBoss.createQueue = originalCreateQueue;
    }
    assert.deepStrictEqual(createdQueues, [queue.deadLetterQueue, queue.queue]);
    const queued = ref('custom-schema', 1);
    await queue.push(queued);
    await queue.cancel(queued.streamId);
    assert.equal(
      await queue.getCurrentTurn({
        chatId: queued.chatId,
        userId: queued.userId,
      }),
      undefined,
    );
  } finally {
    await boss.stop({ graceful: false });
    await pglite.close();
  }
});
