import { PGlite } from '@electric-sql/pglite';
import assert from 'node:assert';
import { describe, it } from 'node:test';
import { PgBoss, fromPglite } from 'pg-boss';

import {
  PgBossTurnQueue,
  type TurnRef,
} from '@deepagents/experimental/zukhruf';
import { timebox } from '@deepagents/test';

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

function ref(chat: string, n: number): TurnRef {
  return {
    kind: 'ask',
    streamId: `turn/${chat}#${n}:${crypto.randomUUID()}`,
    chatId: chat,
    userId: 'u1',
    input: `input-${n}`,
  };
}

const noOrphans = { onOrphaned: async () => {} };

async function makeQueue() {
  const pglite = new PGlite();
  // maintenanceIntervalSeconds defaults to several hours; drop it to 1s so the
  // retention DELETE actually runs during a test (the load-bearing test relies
  // on a control job being deleted in real time).
  const boss = new PgBoss({
    db: fromPglite(pglite),
    backend: 'pglite',
    maintenanceIntervalSeconds: 1,
  });
  boss.on('error', () => {});
  await boss.start();
  const queue = new PgBossTurnQueue(boss, {
    pollingIntervalSeconds: 0.5,
    schema: 'pgboss',
  });
  await queue.initialize();
  return {
    queue,
    boss,
    async [Symbol.asyncDispose]() {
      await boss.stop({ graceful: false });
      await pglite.close();
    },
  };
}

describe('PgBossTurnQueue — retention & commit-GC (pglite)', () => {
  it('never time-deletes terminal jobs, so a parked turn has no retention deadline', async () => {
    await using h = await makeQueue();
    const queue = await h.boss.getQueue(h.queue.queue);
    assert.equal(
      queue?.deleteAfterSeconds,
      0,
      'deleteAfterSeconds:0 — a parked (cancelled) turn survives until its approval resolves',
    );
  });

  it('deletes a job the moment its turn commits — completed turns do not accumulate', async () => {
    await using h = await makeQueue();
    const seen: string[] = [];
    await using _consumer = await h.queue.consume(async (turn) => {
      seen.push(turn.streamId); // commit: handler returns without parking
    }, noOrphans);

    await h.queue.push(ref('c1', 1));
    await h.queue.push(ref('c1', 2));
    await waitFor(() => seen.length === 2, 'both turns committed');
    await sleep(300);

    const remaining = await h.boss.findJobs(h.queue.queue, { key: 'c1' });
    assert.deepStrictEqual(
      remaining.map((j) => j.state),
      [],
      'committed jobs deleted by commit-GC — nothing accumulates',
    );
  });

  it('keeps a parked turn through a maintenance pass, then revives and cleans it up', async () => {
    await using h = await makeQueue();
    let gateOpen = false;
    let parkCount = 0;
    const ran: string[] = [];
    await using _consumer = await h.queue.consume(async (turn, ctx) => {
      if (!gateOpen) {
        parkCount += 1;
        await ctx.park();
        return;
      }
      ran.push(turn.streamId);
    }, noOrphans);

    await h.queue.push(ref('gchat', 1));
    await waitFor(() => parkCount === 1, 'turn parked');

    const parked = await h.boss.findJobs(h.queue.queue, { key: 'gchat' });
    assert.deepStrictEqual(
      parked.map((j) => j.state),
      ['cancelled'],
      'parked turn is cancelled, not run and not deleted by commit-GC',
    );
    assert.deepStrictEqual(ran, [], 'nothing ran while gated');

    await h.boss.supervise(h.queue.queue); // the maintenance pass that would time-delete a job
    await sleep(300);
    const survived = await h.boss.findJobs(h.queue.queue, { key: 'gchat' });
    assert.deepStrictEqual(
      survived.map((j) => j.state),
      ['cancelled'],
      'parked turn survives maintenance (no retention deadline)',
    );

    gateOpen = true;
    await h.queue.resumeParked('gchat');
    await waitFor(() => ran.length === 1, 'revived turn runs');
    await sleep(300);
    const done = await h.boss.findJobs(h.queue.queue, { key: 'gchat' });
    assert.deepStrictEqual(
      done.map((j) => j.state),
      [],
      'revived turn commits and its job is deleted',
    );
  });

  it('deleteAfterSeconds:0 is load-bearing: a parked turn outlives a retention window that deletes a job without it', async () => {
    await using h = await makeQueue(); // our turns queue uses deleteAfterSeconds:0

    // A control queue whose terminal jobs DO expire, on a 1-second clock.
    const control = 'control-retention';
    await h.boss.createQueue(control, {
      policy: 'key_strict_fifo',
      retryLimit: 0,
      deleteAfterSeconds: 1,
    });

    // Park a real turn on our (durable) queue.
    let parkCount = 0;
    await using _consumer = await h.queue.consume(async (_turn, ctx) => {
      parkCount += 1;
      await ctx.park();
    }, noOrphans);
    await h.queue.push(ref('gchat', 1));
    await waitFor(() => parkCount === 1, 'turn parked on the durable queue');

    // A cancelled control job that IS on a retention clock (deleteAfterSeconds:1).
    const controlId = await h.boss.send(
      control,
      { t: 'c' },
      { singletonKey: 'k' },
    );
    await h.boss.fetch(control, {}); // → active
    await h.boss.cancel(control, controlId!); // → cancelled

    // Poll real wall-clock time until retention actually deletes the control
    // job — that is the proof the retention window has elapsed for real.
    await timebox(
      async () => {
        await h.boss.supervise(control);
        if (await h.boss.getJobById(control, controlId!)) {
          throw new Error('control job not deleted yet');
        }
      },
      { maxRetryTime: 20_000, minTimeout: 300 },
    );

    // The same window elapsed for our parked turn — it survives only because
    // the turns queue disables terminal-job deletion (deleteAfterSeconds:0).
    const durable = await h.boss.findJobs(h.queue.queue, { key: 'gchat' });
    assert.deepStrictEqual(
      durable.map((j) => j.state),
      ['cancelled'],
      'parked turn outlived a retention window that deleted a control job lacking deleteAfterSeconds:0',
    );
  });
});
