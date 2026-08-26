import { PGlite } from '@electric-sql/pglite';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { Pool } from 'pg';
import { type Db, PgBoss, fromPglite } from 'pg-boss';

import {
  type ScheduledTaskTransaction,
  ScheduledTasks,
} from '@deepagents/experimental/zukhruf/schedules';
import { isDockerAvailable, withPostgresContainer } from '@deepagents/test';

const dockerAvailable = await isDockerAvailable();
const FAST_POLLING = {
  batchSize: 3,
  pollingIntervalSeconds: 0.5,
  notifyPollingIntervalSeconds: 0.5,
} as const;

interface TestExecutionConfig {
  destination: string;
}

type ExecutionState =
  | {
      status: 'queued' | 'running';
      startedAt: number | null;
    }
  | {
      status: 'completed' | 'failed' | 'cancelled';
      startedAt: number | null;
      finishedAt: number;
      error: string | null;
      title: string | null;
      summary: string | null;
    };

class TestExecutor {
  readonly executions = new Map<
    string,
    { id: string; runId: string; state: ExecutionState }
  >();
  readonly launches: Array<{
    runId: string;
    ownerId: string;
    prompt: string;
    executionConfig: TestExecutionConfig;
  }> = [];
  afterLaunch: (() => void) | undefined;
  launchGate: Promise<void> | undefined;
  launchStarted: (() => void) | undefined;

  async launch(input: {
    runId: string;
    ownerId: string;
    prompt: string;
    executionConfig: TestExecutionConfig;
  }): Promise<{ executionId: string }> {
    this.launches.push(input);
    this.launchStarted?.();
    await this.launchGate;
    let execution = [...this.executions.values()].find(
      ({ runId }) => runId === input.runId,
    );
    if (!execution) {
      execution = {
        id: `execution-${this.executions.size + 1}`,
        runId: input.runId,
        state: { status: 'running', startedAt: Date.now() },
      };
      this.executions.set(execution.id, execution);
    }
    this.afterLaunch?.();
    return { executionId: execution.id };
  }

  async inspect(input: {
    runId: string;
    ownerId: string;
    executionId: string;
    executionConfig: TestExecutionConfig;
  }): Promise<ExecutionState> {
    const execution = this.executions.get(input.executionId);
    if (!execution) throw new Error(`missing execution ${input.executionId}`);
    return execution.state;
  }

  async cancel(input: {
    runId: string;
    ownerId: string;
    executionId: string;
    executionConfig: TestExecutionConfig;
  }): Promise<void> {
    const execution = this.executions.get(input.executionId);
    if (!execution || isTerminal(execution.state.status)) return;
    execution.state = {
      status: 'cancelled',
      startedAt: execution.state.startedAt,
      finishedAt: Date.now(),
      error: null,
      title: null,
      summary: null,
    };
  }

  finish(executionId: string, status: 'completed' | 'failed'): void {
    const execution = this.executions.get(executionId);
    if (!execution) throw new Error(`missing execution ${executionId}`);
    execution.state = {
      status,
      startedAt: execution.state.startedAt,
      finishedAt: Date.now(),
      error: status === 'failed' ? 'execution failed' : null,
      title: 'Finished work',
      summary: 'The external execution finished.',
    };
  }
}

interface Harness extends AsyncDisposable {
  boss: PgBoss;
  database: PGlite;
  executor: TestExecutor;
  queue: string;
  scheduled: ScheduledTasks<TestExecutionConfig>;
}

async function pgliteHarness(
  configure?: (state: {
    executor: TestExecutor;
    afterTransaction: () => Promise<void>;
  }) => void,
): Promise<Harness> {
  const database = new PGlite();
  const boss = new PgBoss({
    db: fromPglite(database),
    backend: 'pglite',
    schedule: false,
    useListenNotify: true,
  });
  boss.on('error', () => {});
  await boss.start();
  const executor = new TestExecutor();
  const queue = `scheduled-tasks-${randomUUID()}`;
  const configurable = {
    executor,
    afterTransaction: async () => {},
  };
  configure?.(configurable);
  const transaction: ScheduledTaskTransaction = (operation) =>
    database.transaction(async (tx) => {
      const result = await operation(fromPglite(tx));
      await configurable.afterTransaction();
      return result;
    });
  const scheduled = new ScheduledTasks({
    boss,
    queue,
    queueOptions: { notify: true },
    reconciliationIntervalMs: 50,
    transaction,
    executor,
  });
  await scheduled.initialize();
  return {
    boss,
    database,
    executor,
    queue,
    scheduled,
    async [Symbol.asyncDispose]() {
      await boss.stop({ graceful: false });
      await database.close();
    },
  };
}

test('Run now launches one generic execution without moving the recurrence cursor', async (t) => {
  await using harness = await pgliteHarness();
  const { executor, scheduled } = harness;
  await using _worker = await scheduled.work(FAST_POLLING);
  const task = await scheduled.create('owner-1', {
    idempotencyKey: 'daily-report',
    name: 'Daily report',
    prompt: 'Prepare the report',
    recurrence: futureRecurrence(60_000, 'FREQ=DAILY;COUNT=2'),
    timezone: 'UTC',
    executionConfig: { destination: 'reports' },
  });

  const run = await scheduled.runNow('owner-1', task.id, 'manual-1');
  await waitForRun(t, scheduled, 'owner-1', run.id, 'running');

  assert.equal(
    (await scheduled.get('owner-1', task.id)).nextRunAt,
    task.nextRunAt,
  );
  assert.deepEqual(executor.launches[0], {
    runId: run.id,
    ownerId: 'owner-1',
    prompt: 'Prepare the report',
    executionConfig: { destination: 'reports' },
  });
  const executionId = executor.launches.length
    ? [...executor.executions.keys()][0]
    : '';
  executor.finish(executionId, 'completed');
  const completed = await waitForRun(
    t,
    scheduled,
    'owner-1',
    run.id,
    'completed',
  );
  assert.equal(completed.reviewStatus, 'pending_review');
  assert.equal(completed.title, 'Finished work');
  assert.equal(completed.summary, 'The external execution finished.');
});

test('missed occurrences collapse into one catch-up while later runs may overlap', async (t) => {
  await using harness = await pgliteHarness();
  const { executor, scheduled } = harness;
  const catchUp = await scheduled.create('owner-1', {
    idempotencyKey: 'catch-up',
    name: 'Catch up',
    prompt: 'Catch up once',
    recurrence: futureRecurrence(600, 'FREQ=SECONDLY;COUNT=3'),
    timezone: 'UTC',
    executionConfig: { destination: 'catch-up' },
  });
  await sleep(3_000);
  await using _worker = await scheduled.work(FAST_POLLING);
  await t.waitFor(
    async () =>
      assert.equal((await scheduled.listRuns('owner-1', catchUp.id)).length, 1),
    { interval: 20, timeout: 5_000 },
  );
  assert.equal(
    (await scheduled.get('owner-1', catchUp.id)).status,
    'completed',
  );

  const overlap = await scheduled.create('owner-1', {
    idempotencyKey: 'overlap',
    name: 'Overlap',
    prompt: 'Run independently',
    recurrence: futureRecurrence(1_500, 'FREQ=SECONDLY;COUNT=2'),
    timezone: 'UTC',
    executionConfig: { destination: 'overlap' },
  });
  await t.waitFor(
    async () => {
      const runs = await scheduled.listRuns('owner-1', overlap.id);
      assert.equal(runs.length, 2);
      assert.equal(
        runs.every(({ status }) => status === 'running'),
        true,
      );
    },
    { interval: 20, timeout: 6_000 },
  );
  assert.equal(executor.executions.size, 3);
  const [later, earlier] = await scheduled.listRuns('owner-1', overlap.id);
  assert.ok(earlier.externalExecutionId);
  executor.finish(earlier.externalExecutionId, 'failed');
  await waitForRun(t, scheduled, 'owner-1', earlier.id, 'failed');
  assert.equal((await scheduled.getRun('owner-1', later.id)).status, 'running');
});

test('duplicate delivery of one occurrence creates one run and one successor', async (t) => {
  await using harness = await pgliteHarness();
  const { boss, executor, queue, scheduled } = harness;
  const task = await scheduled.create('owner-1', {
    idempotencyKey: 'duplicate-occurrence',
    name: 'Duplicate occurrence',
    prompt: 'Run once',
    recurrence: futureRecurrence(2_000, 'FREQ=DAILY;COUNT=2'),
    timezone: 'UTC',
    executionConfig: { destination: 'duplicate' },
  });
  type Work = (...args: unknown[]) => Promise<string>;
  const mutableBoss = boss as unknown as { work: Work };
  const originalWork = mutableBoss.work.bind(boss);
  let duplicated = false;
  mutableBoss.work = (name, options, candidate) =>
    originalWork(name, options, async (jobs: unknown[]) => {
      const handler = candidate as (jobs: unknown[]) => Promise<void>;
      await handler(jobs);
      if (!duplicated) {
        duplicated = true;
        await handler(jobs);
      }
    });
  await using _worker = await scheduled.work(FAST_POLLING);
  mutableBoss.work = originalWork;

  await t.waitFor(
    async () => {
      const runs = await scheduled.listRuns('owner-1', task.id);
      assert.equal(runs.length, 1);
      assert.equal(runs[0]?.status, 'running');
    },
    { interval: 20, timeout: 5_000 },
  );
  assert.equal(duplicated, true);
  assert.equal(executor.launches.length, 1);
  const claimableOccurrences = (
    await boss.findJobs<{ kind: string }>(queue)
  ).filter(
    ({ data, state }) =>
      data.kind === 'occurrence' &&
      state !== 'completed' &&
      state !== 'cancelled' &&
      state !== 'failed',
  );
  assert.equal(claimableOccurrences.length, 1);
});

test('management changes future work while archive preserves independently reviewable runs', async (t) => {
  await using harness = await pgliteHarness();
  const { executor, scheduled } = harness;
  await using _worker = await scheduled.work(FAST_POLLING);
  const task = await scheduled.create('owner-1', {
    idempotencyKey: 'managed',
    name: 'Managed',
    prompt: 'Original prompt',
    recurrence: futureRecurrence(60_000, 'FREQ=DAILY;COUNT=2'),
    timezone: 'UTC',
    executionConfig: { destination: 'old' },
  });
  assert.equal((await scheduled.pause('owner-1', task.id)).status, 'paused');
  const edited = await scheduled.update('owner-1', task.id, {
    prompt: 'Edited prompt',
    executionConfig: { destination: 'new' },
  });
  assert.equal(edited.nextRunAt, null);
  const resumed = await scheduled.resume('owner-1', task.id);
  assert.equal(resumed.status, 'active');

  const run = await scheduled.runNow('owner-1', task.id, 'managed-now');
  await waitForRun(t, scheduled, 'owner-1', run.id, 'running');
  const executionId = [...executor.executions.keys()][0];
  assert.equal(
    (await scheduled.archive('owner-1', task.id)).status,
    'archived',
  );
  assert.equal(executor.executions.get(executionId)?.state.status, 'running');
  executor.finish(executionId, 'completed');
  await waitForRun(t, scheduled, 'owner-1', run.id, 'completed');
  assert.equal(
    (await scheduled.markReviewed('owner-1', run.id)).reviewStatus,
    'reviewed',
  );
  assert.equal(
    (await scheduled.archiveRun('owner-1', run.id)).reviewStatus,
    'archived',
  );
  assert.equal((await scheduled.listRuns('owner-1', task.id)).length, 1);
  assert.equal(
    (await scheduled.getRun('owner-1', run.id)).prompt,
    'Edited prompt',
  );
  assert.deepEqual(
    (await scheduled.getRun('owner-1', run.id)).executionConfig,
    {
      destination: 'new',
    },
  );

  await scheduled.purge('owner-1', task.id);
  await assert.rejects(() => scheduled.get('owner-1', task.id), /not found/);
  assert.equal(executor.executions.has(executionId), true);
});

test('schedule validation and every operation preserve owner isolation', async () => {
  await using harness = await pgliteHarness();
  const { scheduled } = harness;
  const input = {
    idempotencyKey: 'private',
    name: 'Private',
    prompt: 'Owner-only work',
    recurrence: futureRecurrence(60_000, 'FREQ=DAILY;COUNT=2'),
    timezone: 'UTC',
    executionConfig: { destination: 'private' },
  };
  const task = await scheduled.create('owner-1', input);

  assert.deepEqual(await scheduled.list('owner-2'), []);
  await assert.rejects(() => scheduled.get('owner-2', task.id), /not found/);
  await assert.rejects(() => scheduled.pause('owner-2', task.id), /not found/);
  await assert.rejects(
    () => scheduled.runNow('owner-2', task.id, 'foreign-run'),
    /not found/,
  );
  await assert.rejects(
    () => scheduled.create('owner-1', { ...input, timezone: 'Not/A_Zone' }),
    /timezone/,
  );
  await assert.rejects(
    () =>
      scheduled.create('owner-1', {
        ...input,
        idempotencyKey: 'past',
        recurrence: 'DTSTART:20200101T000000Z\nRRULE:FREQ=DAILY;COUNT=1',
      }),
    /no future occurrence/,
  );
});

test('cancelling during launch cancels the external execution instead of orphaning it', async (t) => {
  await using harness = await pgliteHarness();
  const { executor, scheduled } = harness;
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  executor.launchStarted = started.resolve;
  executor.launchGate = release.promise;
  await using _worker = await scheduled.work(FAST_POLLING);
  const task = await scheduled.create('owner-1', {
    idempotencyKey: 'cancel-race',
    name: 'Cancel race',
    prompt: 'Wait during launch',
    recurrence: futureRecurrence(60_000, 'FREQ=DAILY;COUNT=2'),
    timezone: 'UTC',
    executionConfig: { destination: 'cancel' },
  });
  const run = await scheduled.runNow('owner-1', task.id, 'cancel-now');
  await started.promise;

  assert.equal(
    (await scheduled.cancelRun('owner-1', run.id)).status,
    'cancelled',
  );
  release.resolve();
  await t.waitFor(
    () =>
      assert.equal(
        [...executor.executions.values()][0]?.state.status,
        'cancelled',
      ),
    { interval: 20, timeout: 5_000 },
  );
  assert.equal((await scheduled.getRun('owner-1', run.id)).status, 'cancelled');
});

test('a crash after idempotent launch retries the same run and external execution', async (t) => {
  let failAfterLaunch = false;
  let firstLaunch = true;
  await using harness = await pgliteHarness((state) => {
    state.executor.afterLaunch = () => {
      if (!firstLaunch) return;
      firstLaunch = false;
      failAfterLaunch = true;
    };
    state.afterTransaction = async () => {
      if (!failAfterLaunch) return;
      failAfterLaunch = false;
      throw new Error('simulated crash before execution binding');
    };
  });
  const { executor, scheduled } = harness;
  await using _worker = await scheduled.work(FAST_POLLING);
  const task = await scheduled.create('owner-1', {
    idempotencyKey: 'launch-crash',
    name: 'Launch crash',
    prompt: 'Launch idempotently',
    recurrence: futureRecurrence(60_000, 'FREQ=DAILY;COUNT=2'),
    timezone: 'UTC',
    executionConfig: { destination: 'crash' },
  });
  const run = await scheduled.runNow('owner-1', task.id, 'launch-once');
  await waitForRun(t, scheduled, 'owner-1', run.id, 'running');

  assert.equal(executor.launches.length, 2);
  assert.equal(executor.executions.size, 1);
  assert.equal(executor.launches[0]?.runId, executor.launches[1]?.runId);
});

test('rolling back schedule creation rolls back its pg-boss wake', async () => {
  let fail = true;
  await using harness = await pgliteHarness((state) => {
    state.afterTransaction = async () => {
      if (!fail) return;
      fail = false;
      throw new Error('rollback create');
    };
  });
  const { boss, queue, scheduled } = harness;

  await assert.rejects(
    () =>
      scheduled.create('owner-1', {
        idempotencyKey: 'rolled-back',
        name: 'Rolled back',
        prompt: 'Never persist',
        recurrence: futureRecurrence(60_000, 'FREQ=DAILY;COUNT=2'),
        timezone: 'UTC',
        executionConfig: { destination: 'rollback' },
      }),
    /rollback create/,
  );
  assert.deepEqual(await scheduled.list('owner-1'), []);
  assert.deepEqual(await boss.findJobs(queue), []);
});

test('a queued run survives coordinator and pg-boss restart', async (t) => {
  const database = new PGlite();
  const db = fromPglite(database);
  const executor = new TestExecutor();
  const queue = `scheduled-restart-${randomUUID()}`;
  const transaction: ScheduledTaskTransaction = (operation) =>
    database.transaction((tx) => operation(fromPglite(tx)));
  const firstBoss = new PgBoss({ db, backend: 'pglite', schedule: false });
  firstBoss.on('error', () => {});
  await firstBoss.start();
  const first = new ScheduledTasks({
    boss: firstBoss,
    queue,
    reconciliationIntervalMs: 50,
    transaction,
    executor,
  });
  await first.initialize();
  const task = await first.create('owner-1', {
    idempotencyKey: 'restart',
    name: 'Restart',
    prompt: 'Survive restart',
    recurrence: futureRecurrence(60_000, 'FREQ=DAILY;COUNT=2'),
    timezone: 'UTC',
    executionConfig: { destination: 'restart' },
  });
  const run = await first.runNow('owner-1', task.id, 'before-restart');
  await firstBoss.stop({ graceful: false });

  const secondBoss = new PgBoss({ db, backend: 'pglite', schedule: false });
  secondBoss.on('error', () => {});
  await secondBoss.start();
  const restarted = new ScheduledTasks({
    boss: secondBoss,
    queue,
    reconciliationIntervalMs: 50,
    transaction,
    executor,
  });
  await restarted.initialize();
  try {
    await using _worker = await restarted.work(FAST_POLLING);
    await waitForRun(t, restarted, 'owner-1', run.id, 'running');
    assert.equal(executor.executions.size, 1);
  } finally {
    await secondBoss.stop({ graceful: false });
    await database.close();
  }
});

test(
  'real PostgreSQL competing workers launch one execution for one run',
  { skip: !dockerAvailable },
  async (t) => {
    await withPostgresContainer(async ({ connectionString }) => {
      const pool = new Pool({ connectionString });
      const firstBoss = new PgBoss({ connectionString, schedule: false });
      const secondBoss = new PgBoss({ connectionString, schedule: false });
      firstBoss.on('error', () => {});
      secondBoss.on('error', () => {});
      await firstBoss.start();
      await secondBoss.start();
      const transaction: ScheduledTaskTransaction = async (operation) => {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const database: Db = {
            executeSql: (text, values) => client.query(text, values),
          };
          const result = await operation(database);
          await client.query('COMMIT');
          return result;
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }
      };
      const executor = new TestExecutor();
      const queue = `scheduled-workers-${randomUUID()}`;
      const first = new ScheduledTasks({
        boss: firstBoss,
        queue,
        reconciliationIntervalMs: 50,
        transaction,
        executor,
      });
      const second = new ScheduledTasks({
        boss: secondBoss,
        queue,
        reconciliationIntervalMs: 50,
        transaction,
        executor,
      });
      await first.initialize();
      await second.initialize();
      try {
        await using _firstWorker = await first.work(FAST_POLLING);
        await using _secondWorker = await second.work(FAST_POLLING);
        const task = await first.create('owner-1', {
          idempotencyKey: 'competing-workers',
          name: 'Competing workers',
          prompt: 'Launch once',
          recurrence: futureRecurrence(60_000, 'FREQ=DAILY;COUNT=2'),
          timezone: 'UTC',
          executionConfig: { destination: 'postgres' },
        });
        const run = await first.runNow('owner-1', task.id, 'one-run');

        await waitForRun(t, first, 'owner-1', run.id, 'running');
        assert.equal(executor.launches.length, 1);
        assert.equal(executor.executions.size, 1);
      } finally {
        await secondBoss.stop({ graceful: false });
        await firstBoss.stop({ graceful: false });
        await pool.end();
      }
    });
  },
);

test(
  'real PostgreSQL commits duplicate management calls as one schedule and run',
  { skip: !dockerAvailable },
  async () => {
    await withPostgresContainer(async ({ connectionString }) => {
      const pool = new Pool({ connectionString });
      const boss = new PgBoss({ connectionString, schedule: false });
      boss.on('error', () => {});
      await boss.start();
      const transaction: ScheduledTaskTransaction = async (operation) => {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const database: Db = {
            executeSql: (text, values) => client.query(text, values),
          };
          const result = await operation(database);
          await client.query('COMMIT');
          return result;
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }
      };
      const executor = new TestExecutor();
      const queue = `scheduled-postgres-${randomUUID()}`;
      const scheduled = new ScheduledTasks({
        boss,
        queue,
        reconciliationIntervalMs: 50,
        transaction,
        executor,
      });
      await scheduled.initialize();
      try {
        const input = {
          idempotencyKey: 'same-create',
          name: 'Same create',
          prompt: 'Persist once',
          recurrence: futureRecurrence(60_000, 'FREQ=DAILY;COUNT=2'),
          timezone: 'UTC',
          executionConfig: { destination: 'postgres' },
        };
        const [first, second] = await Promise.all([
          scheduled.create('owner-1', input),
          scheduled.create('owner-1', input),
        ]);
        assert.equal(first.id, second.id);
        const [firstRun, secondRun] = await Promise.all([
          scheduled.runNow('owner-1', first.id, 'same-run'),
          scheduled.runNow('owner-1', first.id, 'same-run'),
        ]);
        assert.equal(firstRun.id, secondRun.id);
        const jobs = await boss.findJobs<{ kind: string }>(queue);
        const claimable = jobs.filter(
          ({ state }) => state !== 'cancelled' && state !== 'failed',
        );
        assert.equal(
          claimable.filter(({ data }) => data.kind === 'occurrence').length,
          1,
        );
        assert.equal(
          claimable.filter(({ data }) => data.kind === 'dispatch').length,
          1,
        );
      } finally {
        await boss.stop({ graceful: false });
        await pool.end();
      }
    });
  },
);

async function waitForRun(
  t: TestContext,
  scheduled: ScheduledTasks<TestExecutionConfig>,
  ownerId: string,
  runId: string,
  status: 'running' | 'completed' | 'failed',
) {
  let run = await scheduled.getRun(ownerId, runId);
  await t.waitFor(
    async () => {
      run = await scheduled.getRun(ownerId, runId);
      assert.equal(run.status, status);
    },
    { interval: 20, timeout: 6_000 },
  );
  return run;
}

function futureRecurrence(offsetMs: number, rule: string): string {
  const date = new Date(Date.now() + offsetMs);
  date.setUTCMilliseconds(0);
  const dtstart = date
    .toISOString()
    .replaceAll('-', '')
    .replaceAll(':', '')
    .replace('.000', '');
  return `DTSTART:${dtstart}\nRRULE:${rule}`;
}

function isTerminal(status: ExecutionState['status']): boolean {
  return (
    status === 'completed' || status === 'failed' || status === 'cancelled'
  );
}
