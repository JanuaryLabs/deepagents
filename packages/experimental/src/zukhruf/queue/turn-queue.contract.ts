import assert from 'node:assert';
import { describe, it } from 'node:test';

import type { TurnQueue, TurnRef } from './turn-queue.ts';

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
