import { PGlite } from '@electric-sql/pglite';
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { PgBoss, fromPglite } from 'pg-boss';

import {
  PgBossWakeScheduler,
  type Wake,
} from '@deepagents/experimental/zukhruf';
import { isDockerAvailable, withPostgresContainer } from '@deepagents/test';

const dockerAvailable = await isDockerAvailable();

test('PgBossWakeScheduler delivers opaque data at or after its due time', async () => {
  const database = new PGlite();
  const boss = new PgBoss({
    db: fromPglite(database),
    backend: 'pglite',
    schedule: false,
  });
  boss.on('error', () => {});
  await boss.start();
  const scheduler = new PgBossWakeScheduler<{ value: string }>(boss, {
    queue: 'wake-scheduler-delivery',
    pollingIntervalSeconds: 0.5,
  });
  const otherTree = new PgBossWakeScheduler<{ value: string }>(boss, {
    queue: 'wake-scheduler-other-tree',
    pollingIntervalSeconds: 0.5,
  });
  await scheduler.initialize();
  await otherTree.initialize();

  try {
    const runAt = new Date(Date.now() + 500);
    const wake: Wake<{ value: string }> = {
      id: crypto.randomUUID(),
      runAt,
      data: { value: 'opaque' },
    };
    const delivered = Promise.withResolvers<Wake<{ value: string }>>();
    const otherTreeDeliveries: Wake<{ value: string }>[] = [];

    await scheduler.schedule(wake);
    await using _otherTreeConsumer = await otherTree.consume(
      async (received) => {
        otherTreeDeliveries.push(received);
      },
    );
    await using _consumer = await scheduler.consume(async (received) => {
      delivered.resolve(received);
    });

    assert.equal(
      await Promise.race([
        delivered.promise.then(() => true),
        sleep(200).then(() => false),
      ]),
      false,
      'future wake is not delivered early',
    );
    const received = await Promise.race([
      delivered.promise,
      sleep(5_000).then(() => {
        throw new Error('timed out waiting for wake');
      }),
    ]);
    assert.deepEqual(received, wake);
    assert.deepEqual(otherTreeDeliveries, []);
    assert.ok(Date.now() >= runAt.getTime());
  } finally {
    await boss.stop({ graceful: false });
    await database.close();
  }
});

async function pgliteHarness() {
  const queue = 'wake-scheduler-contract';
  const database = new PGlite();
  const boss = new PgBoss({
    db: fromPglite(database),
    backend: 'pglite',
    schedule: false,
  });
  boss.on('error', () => {});
  await boss.start();
  const scheduler = new PgBossWakeScheduler<{ value: string }>(boss, {
    queue,
    pollingIntervalSeconds: 0.5,
  });
  await scheduler.initialize();
  return {
    boss,
    database,
    queue,
    scheduler,
    async [Symbol.asyncDispose]() {
      await boss.stop({ graceful: false });
      await database.close();
    },
  };
}

function dueWake(value: string): Wake<{ value: string }> {
  return {
    id: crypto.randomUUID(),
    runAt: new Date(),
    data: { value },
  };
}

async function waitForCount(
  t: TestContext,
  values: unknown[],
  count: number,
  label: string,
) {
  await t.waitFor(() => assert.equal(values.length, count, label), {
    interval: 25,
    timeout: 6_000,
  });
}

test('PgBossWakeScheduler deduplicates equal wakes and rejects conflicting id reuse', async (t) => {
  await using h = await pgliteHarness();
  const wake = dueWake('same');
  await h.scheduler.schedule(wake);
  await h.scheduler.schedule(wake);
  await assert.rejects(
    h.scheduler.schedule({ ...wake, data: { value: 'different' } }),
    /already in use/,
  );

  const seen: Wake<{ value: string }>[] = [];
  await using _consumer = await h.scheduler.consume(async (received) => {
    seen.push(received);
  });
  await waitForCount(t, seen, 1, 'one equal wake is delivered');
  await t.waitFor(
    async () =>
      assert.equal(
        (await h.boss.findJobs(h.queue, { id: wake.id })).length,
        0,
        'spent receipt is deleted',
      ),
    { interval: 25, timeout: 6_000 },
  );
  await sleep(700);
  assert.deepEqual(seen, [wake]);
});

test('PgBossWakeScheduler cancels a wake before it is claimed', async () => {
  await using h = await pgliteHarness();
  const wake = { ...dueWake('cancelled'), runAt: new Date(Date.now() + 300) };
  await h.scheduler.schedule(wake);
  await h.scheduler.cancel(wake.id);
  let delivered = false;
  await using _consumer = await h.scheduler.consume(async () => {
    delivered = true;
  });
  await sleep(1_100);
  assert.equal(delivered, false);
  await h.scheduler.cancel(wake.id);
});

test('PgBossWakeScheduler retries a handler failure', async (t) => {
  await using h = await pgliteHarness();
  const attempts: string[] = [];
  const wake = dueWake('retry');
  await h.scheduler.schedule(wake);
  await using _consumer = await h.scheduler.consume(async ({ data }) => {
    attempts.push(data.value);
    if (attempts.length === 1) throw new Error('transient handler failure');
  });
  await waitForCount(t, attempts, 2, 'failed handler is retried');
  assert.deepEqual(attempts, ['retry', 'retry']);
});

test('PgBossWakeScheduler cancellation after claim permits one handler but no redelivery', async (t) => {
  await using h = await pgliteHarness();
  const wake = dueWake('claim-race');
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const attempts: string[] = [];
  await h.scheduler.schedule(wake);
  await using _consumer = await h.scheduler.consume(async ({ data }) => {
    attempts.push(data.value);
    started.resolve();
    await release.promise;
  });
  await started.promise;
  await h.scheduler.cancel(wake.id);
  release.resolve();
  await waitForCount(t, attempts, 1, 'claimed handler runs once');
  await sleep(1_100);
  assert.deepEqual(attempts, ['claim-race']);
});

test('PgBossWakeScheduler disposal stops claims and a replacement consumes the wake', async (t) => {
  await using h = await pgliteHarness();
  const seen: string[] = [];
  const first = await h.scheduler.consume(async ({ data }) => {
    seen.push(data.value);
  });
  await first[Symbol.asyncDispose]();
  await h.scheduler.schedule(dueWake('after-dispose'));
  await sleep(700);
  assert.equal(seen.length, 0);

  await using _replacement = await h.scheduler.consume(async ({ data }) => {
    seen.push(data.value);
  });
  await waitForCount(t, seen, 1, 'replacement receives backlog');
  assert.deepEqual(seen, ['after-dispose']);
});

test('PgBossWakeScheduler keeps a future wake across a pg-boss restart', async (t) => {
  const queue = 'wake-scheduler-restart';
  const database = new PGlite();
  const firstBoss = new PgBoss({
    db: fromPglite(database),
    backend: 'pglite',
    schedule: false,
  });
  firstBoss.on('error', () => {});
  await firstBoss.start();
  const wake = { ...dueWake('restart'), runAt: new Date(Date.now() + 500) };
  const firstScheduler = new PgBossWakeScheduler<{ value: string }>(firstBoss, {
    queue,
    pollingIntervalSeconds: 0.5,
  });
  await firstScheduler.initialize();
  await firstScheduler.schedule(wake);
  await firstBoss.stop({ graceful: false });

  const secondBoss = new PgBoss({
    db: fromPglite(database),
    backend: 'pglite',
    schedule: false,
  });
  secondBoss.on('error', () => {});
  try {
    await secondBoss.start();
    const secondScheduler = new PgBossWakeScheduler<{ value: string }>(
      secondBoss,
      { queue, pollingIntervalSeconds: 0.5 },
    );
    await secondScheduler.initialize();
    const seen: Wake<{ value: string }>[] = [];
    await using _consumer = await secondScheduler.consume(async (received) => {
      seen.push(received);
    });
    await waitForCount(t, seen, 1, 'restarted scheduler receives wake');
    assert.deepEqual(seen, [wake]);
  } finally {
    await secondBoss.stop({ graceful: false });
    await database.close();
  }
});

test(
  'PgBossWakeScheduler preserves deduplication, retry, cancellation, and restart on PostgreSQL',
  { skip: dockerAvailable ? false : 'Docker is unavailable' },
  async (t) => {
    await withPostgresContainer(async (container) => {
      const queue = 'wake-scheduler-contract';
      const firstBoss = new PgBoss({
        connectionString: container.connectionString,
        schedule: false,
      });
      firstBoss.on('error', () => {});
      await firstBoss.start();
      const firstScheduler = new PgBossWakeScheduler<{ value: string }>(
        firstBoss,
        { queue, pollingIntervalSeconds: 0.5 },
      );
      await firstScheduler.initialize();

      const retried = dueWake('postgres-retry');
      await firstScheduler.schedule(retried);
      await firstScheduler.schedule(retried);
      const attempts: string[] = [];
      const consumer = await firstScheduler.consume(async ({ data }) => {
        attempts.push(data.value);
        if (attempts.length === 1) throw new Error('retry on postgres');
      });
      await waitForCount(
        t,
        attempts,
        2,
        'postgres retries one deduplicated wake',
      );
      await consumer[Symbol.asyncDispose]();

      const claimed = dueWake('postgres-claim-race');
      const claimedStarted = Promise.withResolvers<void>();
      const releaseClaimed = Promise.withResolvers<void>();
      const claimedAttempts: string[] = [];
      await firstScheduler.schedule(claimed);
      const claimedConsumer = await firstScheduler.consume(async ({ data }) => {
        claimedAttempts.push(data.value);
        claimedStarted.resolve();
        await releaseClaimed.promise;
      });
      await claimedStarted.promise;
      await firstScheduler.cancel(claimed.id);
      releaseClaimed.resolve();
      await waitForCount(
        t,
        claimedAttempts,
        1,
        'claimed postgres wake runs once',
      );
      await claimedConsumer[Symbol.asyncDispose]();

      const cancelled = {
        ...dueWake('postgres-cancel'),
        runAt: new Date(Date.now() + 300),
      };
      await firstScheduler.schedule(cancelled);
      await firstScheduler.cancel(cancelled.id);

      const restart = {
        ...dueWake('postgres-restart'),
        runAt: new Date(Date.now() + 500),
      };
      await firstScheduler.schedule(restart);
      const afterDispose = dueWake('postgres-after-dispose');
      await firstScheduler.schedule(afterDispose);
      await firstBoss.stop({ graceful: false });

      const secondBoss = new PgBoss({
        connectionString: container.connectionString,
        schedule: false,
      });
      secondBoss.on('error', () => {});
      try {
        await secondBoss.start();
        const secondScheduler = new PgBossWakeScheduler<{ value: string }>(
          secondBoss,
          { queue, pollingIntervalSeconds: 0.5 },
        );
        await secondScheduler.initialize();
        const seen: string[] = [];
        await using _replacement = await secondScheduler.consume(
          async ({ data }) => {
            seen.push(data.value);
          },
        );
        await waitForCount(t, seen, 2, 'replacement receives restart backlog');
        await sleep(700);
        assert.deepEqual(seen.toSorted(), [
          'postgres-after-dispose',
          'postgres-restart',
        ]);
        await t.waitFor(
          async () =>
            assert.equal(
              (
                await secondBoss.findJobs(queue, {
                  id: afterDispose.id,
                })
              ).length,
              0,
            ),
          { interval: 25, timeout: 6_000 },
        );
      } finally {
        await secondBoss.stop({ graceful: false });
      }
    });
  },
);

test(
  'PgBossWakeScheduler retries after a PostgreSQL worker dies mid-handler',
  { skip: dockerAvailable ? false : 'Docker is unavailable' },
  async (t) => {
    await withPostgresContainer(async (container) => {
      const queue = 'wake-scheduler-worker-death';
      const bossOptions = {
        connectionString: container.connectionString,
        schedule: false as const,
        monitorIntervalSeconds: 1,
        superviseIntervalSeconds: 1,
        maintenanceIntervalSeconds: 1,
      };
      const firstBoss = new PgBoss(bossOptions);
      firstBoss.on('error', () => {});
      await firstBoss.start();
      const firstScheduler = new PgBossWakeScheduler<{ value: string }>(
        firstBoss,
        {
          queue,
          pollingIntervalSeconds: 0.5,
          heartbeatSeconds: 10,
          expireInSeconds: 60,
        },
      );
      await firstScheduler.initialize();
      await firstScheduler.schedule(dueWake('worker-death'));
      const started = Promise.withResolvers<void>();
      await firstScheduler.consume(async () => {
        started.resolve();
        await new Promise<never>(() => {});
      });
      await started.promise;
      await firstBoss.stop({ graceful: false });

      const secondBoss = new PgBoss(bossOptions);
      secondBoss.on('error', () => {});
      try {
        await secondBoss.start();
        const secondScheduler = new PgBossWakeScheduler<{ value: string }>(
          secondBoss,
          {
            queue,
            pollingIntervalSeconds: 0.5,
            heartbeatSeconds: 10,
            expireInSeconds: 60,
          },
        );
        await secondScheduler.initialize();
        const seen: string[] = [];
        await using _replacement = await secondScheduler.consume(
          async ({ data }) => {
            seen.push(data.value);
          },
        );
        await t.waitFor(() => assert.deepEqual(seen, ['worker-death']), {
          interval: 100,
          timeout: 20_000,
        });
      } finally {
        await secondBoss.stop({ graceful: false });
      }
    });
  },
);
