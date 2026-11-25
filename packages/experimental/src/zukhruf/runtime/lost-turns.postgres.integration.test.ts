import { untilAborted } from '@zukhruf/async';
import { waitFor } from '@zukhruf/testing/async';
import { Postgres } from '@zukhruf/testing/postgres';
import { MockLanguageModelV4 } from 'ai/test';
import assert from 'node:assert/strict';
import { suite, test } from 'node:test';
import { PgBoss } from 'pg-boss';

import {
  AgentRuntime,
  PostgresAgentStorage,
  defineAgent,
  defineStack,
} from '@deepagents/experimental/zukhruf';

import { buildSandbox } from '../../testing/build-sandbox.fixture.ts';
import { textResult } from '../../testing/stream-results.fixture.ts';
import { userTurn } from '../../testing/user-turn.fixture.ts';

const testPostgres = new Postgres({ environment: process.env });

const turnQueue = 'zukhruf-turns';

const root = defineAgent({
  name: 'root',
  model: new MockLanguageModelV4({
    doStream: async () => textResult('done'),
  }),
  sandbox: buildSandbox(),
  instructions: [],
});

/** One process's runtime on the shared database, with its own pg-boss. */
async function host(
  resources: AsyncDisposableStack,
  database: { connectionString: string; pool(): PostgresPool },
) {
  const boss = new PgBoss({
    connectionString: database.connectionString,
    maintenanceIntervalSeconds: 1,
  });
  boss.on('error', () => {});
  await boss.start();
  resources.defer(() => boss.stop({ graceful: false }));
  const storage = resources.use(
    await PostgresAgentStorage.create({
      pool: database.pool(),
      boss,
      queue: { pollingIntervalSeconds: 0.5 },
    }),
  );
  const runtime = resources.use(
    await new AgentRuntime(root).initialize(
      defineStack(async () => ({ storage })),
    ),
  );
  return { boss, storage, runtime };
}

type PostgresPool = Parameters<typeof PostgresAgentStorage.create>[0]['pool'];

suite('lost turns on Postgres', () => {
  test('two runtimes starting together on one Postgres database fail a lost turn once, and both start working', async (t) => {
    await using resources = new AsyncDisposableStack();
    const database = resources.use(await testPostgres.database());
    const first = await host(resources, database);
    const second = await host(resources, database);
    await first.boss.updateQueue(turnQueue, { retentionSeconds: 1 });
    const lost = await first.runtime.enqueue(
      { chatId: 'lost', userId: 'u1' },
      userTurn('lost-turn', 'lost'),
    );
    await waitFor(
      async () => {
        await first.boss.supervise(turnQueue);
        assert.deepStrictEqual(
          await first.boss.findJobs(turnQueue, { data: { streamId: lost.id } }),
          [],
        );
      },
      { interval: 100, signal: t.signal },
    );

    const workers = await Promise.all([
      first.runtime.work(),
      second.runtime.work(),
    ]);
    for (const worker of workers) resources.use(worker);

    assert.deepStrictEqual(
      await untilAborted(Array.fromAsync(lost.stream), t.signal),
      [
        {
          type: 'error',
          errorText: 'turn lost: its queue job was deleted before it ran',
        },
      ],
    );
    assert.deepStrictEqual(
      await first.storage.streams.store.getChunks(lost.id),
      [],
      'no sweep appended output to the lost stream',
    );
    const next = await second.runtime.enqueue(
      { chatId: 'after', userId: 'u1' },
      userTurn('after-turn', 'after'),
    );
    assert.deepStrictEqual(
      (await untilAborted(Array.fromAsync(next.stream), t.signal)).filter(
        (chunk) => chunk.type === 'text-delta',
      ),
      [{ type: 'text-delta', id: 'text-1', delta: 'done' }],
    );
  });
});
