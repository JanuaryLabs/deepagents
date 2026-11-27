import { untilAborted } from '@zukhruf/async';
import { waitFor } from '@zukhruf/testing/async';
import { Postgres } from '@zukhruf/testing/postgres';
import { MockLanguageModelV4 } from 'ai/test';
import assert from 'node:assert/strict';
import { suite, test } from 'node:test';
import { PgBoss } from 'pg-boss';

import {
  type AgentDeclaration,
  AgentRuntime,
  PostgresAgentStorage,
  defineAgent,
  defineStack,
} from '@deepagents/experimental/zukhruf';

import { buildSandbox } from '../../testing/build-sandbox.fixture.ts';
import { textResult } from '../../testing/stream-results.fixture.ts';
import { usage } from '../../testing/usage.fixture.ts';
import { userTurn } from '../../testing/user-turn.fixture.ts';

const testPostgres = new Postgres({ environment: process.env });

const QUESTION = 'How do I renew my passport in Jordan?';

type PostgresPool = Parameters<typeof PostgresAgentStorage.create>[0]['pool'];

function titleResult(title: string) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ title }) }],
    finishReason: { unified: 'stop' as const, raw: '' },
    usage,
    warnings: [],
  };
}

function clerk(titleModel: MockLanguageModelV4) {
  return defineAgent({
    name: 'clerk',
    model: new MockLanguageModelV4({
      doStream: async () => textResult('Done.'),
    }),
    sandbox: buildSandbox(),
    instructions: [],
    title: { model: titleModel },
  });
}

/** One process's runtime on the shared database, with its own pg-boss. */
async function host(
  resources: AsyncDisposableStack,
  database: { connectionString: string; pool(): PostgresPool },
  root: AgentDeclaration,
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
  return resources.use(
    await new AgentRuntime(root).initialize(
      defineStack(async () => ({ storage })),
    ),
  );
}

suite('session titles on Postgres', () => {
  test('a rename made while the title model runs survives the generated title', async (t) => {
    await using resources = new AsyncDisposableStack();
    const database = resources.use(await testPostgres.database());
    const release = Promise.withResolvers<void>();
    const titleModel = new MockLanguageModelV4({
      doGenerate: async () => {
        await release.promise;
        return titleResult('Passport renewal');
      },
    });
    const runtime = await host(resources, database, clerk(titleModel));
    resources.use(await runtime.work());
    const conversation = { chatId: 'renamed', userId: 'owner' };

    const turn = await runtime.enqueue(
      conversation,
      userTurn('first', QUESTION),
    );
    await waitFor(() => assert.equal(titleModel.doGenerateCalls.length, 1), {
      interval: 50,
      signal: t.signal,
    });
    await runtime.setSessionTitle(conversation, 'My passport');
    release.resolve();
    await untilAborted(Array.fromAsync(turn.stream), t.signal);

    assert.equal(
      (await runtime.observe(conversation).status(turn.id))?.status,
      'completed',
    );
    assert.deepStrictEqual(
      (await runtime.listHistory('owner')).map(({ title }) => title),
      ['My passport'],
    );
  });

  test('a second host over the same database never titles a session the first host titled', async (t) => {
    await using resources = new AsyncDisposableStack();
    const database = resources.use(await testPostgres.database());
    const firstTitleModel = new MockLanguageModelV4({
      doGenerate: async () => titleResult('Passport renewal'),
    });
    const secondTitleModel = new MockLanguageModelV4({
      doGenerate: async () => titleResult('Second title'),
    });
    const first = await host(resources, database, clerk(firstTitleModel));
    const second = await host(resources, database, clerk(secondTitleModel));
    const conversation = { chatId: 'shared', userId: 'owner' };

    {
      await using _worker = await first.work();
      const turn = await first.enqueue(
        conversation,
        userTurn('first', QUESTION),
      );
      await untilAborted(Array.fromAsync(turn.stream), t.signal);
    }
    resources.use(await second.work());
    const next = await second.enqueue(
      conversation,
      userTurn('second', 'And the fee?'),
    );
    await untilAborted(Array.fromAsync(next.stream), t.signal);

    assert.equal(
      (await second.observe(conversation).status(next.id))?.status,
      'completed',
    );
    assert.deepStrictEqual(
      {
        first: firstTitleModel.doGenerateCalls.length,
        second: secondTitleModel.doGenerateCalls.length,
      },
      { first: 1, second: 0 },
    );
    assert.deepStrictEqual(
      (await second.listHistory('owner')).map(({ title }) => title),
      ['Passport renewal'],
    );
  });
});
