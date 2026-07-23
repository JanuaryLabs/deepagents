import { PGlite } from '@electric-sql/pglite';
import assert from 'node:assert';
import { describe, it } from 'node:test';
import {
  type FindJobsOptions,
  type JobWithMetadata,
  PgBoss,
  fromPglite,
} from 'pg-boss';

import type {
  PgBossTurnQueueOptions,
  TurnQueue,
  TurnRef,
} from '@deepagents/experimental/zukhruf';
import { PgBossTurnQueue } from '@deepagents/experimental/zukhruf';

/**
 * Behavioral contract every TurnQueue implementation must pass.
 *
 * The runtime is built on exactly these guarantees — several of which the
 * pg-boss implementation gets from backend-specific behavior (duplicate job
 * id resolves null, job rows retained after completion, key blocking on
 * failure). This suite pins them as observable behavior so swapping or
 * upgrading a backend cannot silently change the semantics.
 *
 * Instantiate per implementation:
 * ```ts
 * turnQueueContract('PgBossTurnQueue (pglite)', async () => {
 *   ...build a fresh, isolated queue...
 *   return { queue, [Symbol.asyncDispose]: async () => { ...teardown... } };
 * });
 * ```
 */
export interface TurnQueueHarness extends AsyncDisposable {
  queue: TurnQueue;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function pgliteTransaction(
  pglite: PGlite,
): NonNullable<PgBossTurnQueueOptions['withTransaction']> {
  return (operation) =>
    pglite.transaction((transaction) => operation(fromPglite(transaction)));
}

async function waitFor(
  condition: () => boolean,
  what: string,
  timeoutMs = 10_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await sleep(25);
  }
  throw new Error(`timed out waiting for: ${what}`);
}

async function waitForAsync(
  condition: () => Promise<boolean>,
  what: string,
  timeoutMs = 10_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
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

function continuationRef(chat: string): TurnRef {
  return {
    kind: 'continuation',
    streamId: `turn/${chat}#continuation:${crypto.randomUUID()}`,
    chatId: chat,
    userId: 'u1',
  };
}

const noOrphans = { onOrphaned: async () => {} };

export function turnQueueContract(
  name: string,
  makeQueue: () => Promise<TurnQueueHarness>,
) {
  describe(`TurnQueue contract — ${name}`, () => {
    it('serializes caller-side control work without a consumer', async () => {
      await using h = await makeQueue();
      let active = 0;
      let maxActive = 0;

      await Promise.all(
        [1, 2].map((attempt) =>
          h.queue.serialize('control', async () => {
            active++;
            maxActive = Math.max(maxActive, active);
            await sleep(25 * attempt);
            active--;
          }),
        ),
      );

      assert.equal(maxActive, 1);
    });

    it('delivers a turn pushed before any consumer existed, payload intact', async () => {
      await using h = await makeQueue();
      const pushed = ref('durable', 1);
      await h.queue.push(pushed);
      await sleep(300);

      const seen: TurnRef[] = [];
      await using _consumer = await h.queue.consume(async (turn) => {
        seen.push(turn);
      }, noOrphans);

      await waitFor(() => seen.length === 1, 'late consumer receives turn');
      assert.deepStrictEqual(seen[0], pushed);
    });

    it('reports queued and active scheduler work until the turn settles', async () => {
      await using h = await makeQueue();
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
          async () => (await h.queue.getTurnActivity(conversation)) === 'idle',
          'settled turn disappears from scheduler status',
        );
      } finally {
        release.resolve();
      }
    });

    it('finds and cancels every copy of the oldest queued stream id', async () => {
      await using h = await makeQueue();
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
        () => seen.length === 1,
        'successor runs after cancellation',
      );
      assert.deepStrictEqual(seen, [second]);
    });

    it('cancelling an active turn aborts its handler without overlapping its successor', async () => {
      await using h = await makeQueue();
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
          await new Promise<void>((resolve) => {
            context.signal.addEventListener('abort', () => resolve(), {
              once: true,
            });
          });
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

    it('a duplicate push never delivers concurrently, out of order, or not at all', async () => {
      await using h = await makeQueue();
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

      await waitFor(() => deliveries >= 1, 'turn delivered at least once');
      await sleep(1500);
      // At-least-once: an implementation may dedup (1) or redeliver (2),
      // but never lose the turn, exceed the duplicate count, or interleave.
      assert.ok(
        deliveries >= 1 && deliveries <= 2,
        `deliveries: ${deliveries}`,
      );
      assert.equal(maxActive, 1, 'duplicates never run concurrently');
    });

    it('turns in one chat run strictly FIFO, one at a time', async () => {
      await using h = await makeQueue();
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

      await waitFor(() => events.length === 6, 'all three turns finished');
      assert.deepStrictEqual(events, [
        'start input-1',
        'end input-1',
        'start input-2',
        'end input-2',
        'start input-3',
        'end input-3',
      ]);
    });

    it('turns in different chats can overlap', async () => {
      await using h = await makeQueue();
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

      await waitFor(() => Boolean(outcome.a && outcome.b), 'both chats done');
      assert.equal(
        outcome.a,
        'overlapped',
        'chat A finished only after chat B started — cross-chat concurrency',
      );
    });

    it('caps active handlers at the consume concurrency', async () => {
      await using h = await makeQueue();
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

      await waitFor(() => done === 6, 'all six chats processed', 20_000);
      assert.ok(
        maxActive <= 2,
        `never more than the configured concurrency (saw ${maxActive})`,
      );
    });

    it('a crashing handler surfaces exactly once via onOrphaned, then the chat unblocks', async () => {
      await using h = await makeQueue();
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

    it('an orphan callback failure cannot keep the next same-chat turn blocked', async () => {
      await using h = await makeQueue();
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
        () => invocations.includes(next.input),
        'source acknowledgement unblocks the successor despite callback failure',
        5_000,
      );
      assert.ok(orphanAttempts >= 1);
      assert.deepStrictEqual(invocations, [boom.input, next.input]);
    });

    it('a parked turn is not redelivered until resumeParked; revival preserves order', async () => {
      await using h = await makeQueue();
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
      await waitFor(() => parked.length === 2, 'both turns parked');
      await sleep(1500);
      assert.deepStrictEqual(
        parked,
        ['input-1', 'input-2'],
        'parked once each — no redelivery',
      );
      assert.deepStrictEqual(ran, [], 'nothing executed while parked');

      gateOpen = true;
      await sleep(1200);
      assert.deepStrictEqual(ran, [], 'opening the gate alone revives nothing');

      await h.queue.resumeParked('gated');
      await waitFor(() => ran.length === 2, 'parked turns revived');
      assert.deepStrictEqual(
        ran,
        ['input-1', 'input-2'],
        'original FIFO order preserved',
      );
    });

    it('a continuation outranks revived parked turns of its chat', async () => {
      await using h = await makeQueue();
      const ran: string[] = [];

      let parkCount = 0;
      const gatekeeper = await h.queue.consume(async (_turn, context) => {
        parkCount++;
        await context.park();
      }, noOrphans);
      await h.queue.push(ref('ranked', 1));
      await waitFor(() => parkCount === 1, 'turn parked');
      await gatekeeper[Symbol.asyncDispose]();

      await h.queue.push(continuationRef('ranked'));
      await h.queue.resumeParked('ranked');

      await using _consumer = await h.queue.consume(async (turn) => {
        ran.push(turn.kind);
      }, noOrphans);

      await waitFor(() => ran.length === 2, 'both delivered');
      assert.deepStrictEqual(
        ran,
        ['continuation', 'ask'],
        'continuation runs before the revived (older created_on) parked turn',
      );
    });

    it('disposal stops delivery; a later consumer picks up the backlog', async () => {
      await using h = await makeQueue();
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
      await waitFor(() => executions === 1, 'new consumer drains the backlog');
    });
  });
}

turnQueueContract('PgBossTurnQueue (pglite)', async () => {
  const pglite = new PGlite();
  const boss = new PgBoss({ db: fromPglite(pglite), backend: 'pglite' });
  boss.on('error', () => {});
  await boss.start();
  const queue = new PgBossTurnQueue(boss, {
    pollingIntervalSeconds: 0.5,
    schema: 'pgboss',
    withTransaction: pgliteTransaction(pglite),
  });
  await queue.initialize();
  return {
    queue,
    async [Symbol.asyncDispose]() {
      await boss.stop({ graceful: false });
      await pglite.close();
    },
  };
});

it('does not delete or overlap a turn claimed after the cancellation snapshot', async () => {
  const pglite = new PGlite();
  const boss = new PgBoss({ db: fromPglite(pglite), backend: 'pglite' });
  boss.on('error', () => {});
  await boss.start();
  const queue = new PgBossTurnQueue(boss, {
    pollingIntervalSeconds: 0.5,
    schema: 'pgboss',
    withTransaction: pgliteTransaction(pglite),
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

it('delivers cancellation to a local handler registered after cancel returns', async () => {
  const pglite = new PGlite();
  const boss = new PgBoss({ db: fromPglite(pglite), backend: 'pglite' });
  boss.on('error', () => {});
  await boss.start();
  const queue = new PgBossTurnQueue(boss, {
    pollingIntervalSeconds: 0.5,
    schema: 'pgboss',
    withTransaction: pgliteTransaction(pglite),
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

it('fails fast when a custom-adapter schema is omitted and accepts it explicitly', async () => {
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
    withTransaction: pgliteTransaction(pglite),
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
      withTransaction: pgliteTransaction(pglite),
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
