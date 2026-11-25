import { waitFor } from '@zukhruf/testing/async';
import { Postgres } from '@zukhruf/testing/postgres';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PgBoss } from 'pg-boss';

import {
  PgBossTurnQueue,
  type TurnRef,
} from '@deepagents/experimental/zukhruf';

const testPostgres = new Postgres({ environment: process.env });

const unobserved = {
  onOrphaned: async () => {},
  onSettled: async () => {},
};

function ref(chat: string): TurnRef {
  return {
    kind: 'message',
    streamId: `turn/${chat}:${crypto.randomUUID()}`,
    chatId: chat,
    userId: 'u1',
    message: {
      id: 'message-1',
      role: 'user',
      parts: [{ type: 'text', text: 'input' }],
    },
    trigger: 'submit-message',
  };
}

describe('PgBossTurnQueue retention (postgres)', () => {
  it('runs a turn parked past the queue retention exactly once after resumeParked, through a maintenance pass that deletes expired queued jobs', async (t) => {
    await using database = await testPostgres.database();
    await using resources = new AsyncDisposableStack();
    const boss = new PgBoss({
      connectionString: database.connectionString,
      maintenanceIntervalSeconds: 1,
    });
    boss.on('error', () => {});
    await boss.start();
    resources.defer(() => boss.stop({ graceful: false }));
    const queue = await PgBossTurnQueue.create(boss, {
      pollingIntervalSeconds: 0.5,
    });
    const retentionSeconds = 6;
    await boss.updateQueue(queue.queue, { retentionSeconds });

    {
      let parks = 0;
      await using _parking = await queue.consume(async (_turn, ctx) => {
        parks += 1;
        await ctx.park();
      }, unobserved);
      await queue.push(ref('parked'));
      await waitFor(() => assert.equal(parks, 1), {
        signal: t.signal,
        interval: 25,
      });
    }

    await waitFor(
      async () => {
        await boss.supervise(queue.queue);
        const [job] = await boss.findJobs(queue.queue, { key: 'parked' });
        assert.ok(job, 'the parked job exists');
        assert.ok(
          job.keepUntil.getTime() < Date.now() - 1_000,
          'the parked job is past its keep_until',
        );
      },
      { signal: t.signal, interval: 300 },
    );
    assert.deepStrictEqual(
      (await boss.findJobs(queue.queue, { key: 'parked' })).map(
        (job) => job.state,
      ),
      ['cancelled'],
      'a parked turn outlives the queue retention',
    );

    await queue.resumeParked('parked');

    const controlId = await boss.send(
      queue.queue,
      { control: true },
      { singletonKey: 'control', retentionSeconds: 1 },
    );
    assert.ok(controlId);
    await waitFor(
      async () => {
        await boss.supervise(queue.queue);
        assert.deepStrictEqual(
          await boss.findJobs(queue.queue, { id: controlId }),
          [],
          'a maintenance pass after the resume deleted an expired queued job',
        );
      },
      { signal: t.signal, interval: 300 },
    );
    assert.deepStrictEqual(
      (await boss.findJobs(queue.queue, { key: 'parked' })).map(
        (job) => job.state,
      ),
      ['created'],
      'the revived turn survives the maintenance pass',
    );

    const received: string[] = [];
    await using _consumer = await queue.consume(async (turn) => {
      received.push(turn.chatId);
    }, unobserved);
    await waitFor(
      async () => {
        assert.deepStrictEqual(
          await boss.findJobs(queue.queue, { key: 'parked' }),
          [],
          'the revived turn ran and its job is deleted',
        );
      },
      { signal: t.signal, interval: 50 },
    );
    assert.deepStrictEqual(received, ['parked']);
  });
});
