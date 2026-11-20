import { Postgres } from '@zukhruf/testing/postgres';
import { MockLanguageModelV4 } from 'ai/test';
import { InMemoryFs } from 'just-bash';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { PgBoss } from 'pg-boss';

import { createVirtualSandbox } from '@deepagents/context';
import {
  AgentRuntime,
  MessageDeliveryModes,
  PostgresAgentStorage,
  createInterAgentCommunication,
  defineAgent,
  defineSandbox,
  defineStack,
} from '@deepagents/experimental/zukhruf';

import {
  textResult,
  toolCallResult,
} from '../../testing/stream-results.fixture.ts';
import { userTurn } from '../../testing/user-turn.fixture.ts';

const testPostgres = new Postgres({ environment: process.env });

test("a child's FINAL_ANSWER reaches its parent's wait_agent on a PostgreSQL stack, and disposing the runtime leaves the host's pool open", async () => {
  await using resources = new AsyncDisposableStack();
  const database = resources.use(await testPostgres.database());
  const pool = database.pool();
  const boss = new PgBoss({ connectionString: database.connectionString });
  boss.on('error', () => {});
  await boss.start();
  resources.defer(() => boss.stop({ graceful: false }));
  const sandbox = defineSandbox(async () =>
    createVirtualSandbox({ fs: new InMemoryFs() }),
  );
  const rootModel = new MockLanguageModelV4({
    doStream: [
      toolCallResult({
        toolCallId: 'spawn',
        toolName: 'spawn_agent',
        input: JSON.stringify({
          task_name: 'research',
          agent_type: 'worker',
          message: 'Find the answer',
          fork_turns: 'none',
        }),
      }),
      toolCallResult({
        toolCallId: 'wait',
        toolName: 'wait_agent',
        input: JSON.stringify({ timeout_ms: 30_000 }),
      }),
      textResult('root done'),
    ],
  });
  const root = defineAgent({
    name: 'root',
    sandbox,
    instructions: [],
    model: rootModel,
    subagents: [
      defineAgent({
        name: 'worker',
        sandbox,
        instructions: [],
        model: new MockLanguageModelV4({
          doStream: async () => textResult('child result'),
        }),
      }),
    ],
  });
  const stack = defineStack(async (stackResources) => ({
    storage: stackResources.use(
      await PostgresAgentStorage.create({
        pool,
        boss,
        queue: { pollingIntervalSeconds: 0.5 },
      }),
    ),
  }));

  {
    await using host = await new AgentRuntime(root).initialize(stack);
    await using worker = await host.work({ concurrency: 2 });
    void worker;
    const turn = await host.enqueue(
      { chatId: randomUUID(), userId: 'user-1' },
      userTurn(randomUUID(), 'Research it'),
    );
    for await (const chunk of turn.stream) assert.ok(chunk.type);
  }

  const afterWait = JSON.stringify(rootModel.doStreamCalls[2]?.prompt);
  assert.deepStrictEqual(
    {
      modelCalls: rootModel.doStreamCalls.length,
      waited: afterWait.includes('"timed_out":false'),
      childResultVisible: afterWait.includes('child result'),
      // Read from the mailbox's own table: a substituted in-memory mailbox
      // would satisfy every prompt assertion above.
      consumedFinalAnswers: (
        await pool.query(
          'SELECT communication_id FROM "public"."zukhruf_mailbox_consumed_terminal_ids"',
        )
      ).rowCount,
      poolOpen: (await pool.query<{ alive: number }>('SELECT 1 AS alive')).rows,
    },
    {
      modelCalls: 3,
      waited: true,
      childResultVisible: true,
      consumedFinalAnswers: 1,
      poolOpen: [{ alive: 1 }],
    },
  );
});

test('a trigger delivery whose wake push fails leaves no mail and no wake stream, and a retry delivers both', async () => {
  await using resources = new AsyncDisposableStack();
  const database = resources.use(await testPostgres.database());
  const pool = database.pool();
  const boss = new PgBoss({ connectionString: database.connectionString });
  boss.on('error', () => {});
  await boss.start();
  resources.defer(() => boss.stop({ graceful: false }));
  const storage = resources.use(
    await PostgresAgentStorage.create({ pool, boss }),
  );
  const sandbox = defineSandbox(async () =>
    createVirtualSandbox({ fs: new InMemoryFs() }),
  );
  await using host = await new AgentRuntime(
    defineAgent({
      name: 'root',
      sandbox,
      instructions: [],
      model: new MockLanguageModelV4({
        doStream: async () => textResult('unused'),
      }),
    }),
  ).initialize(defineStack(async () => ({ storage })));
  const recipient = { chatId: randomUUID(), userId: 'user-1' };
  const mail = createInterAgentCommunication({
    author: { chatId: randomUUID(), userId: 'user-1' },
    recipient,
    content: 'wake me',
  });
  // Platform setup no storage operation exposes: every job insert fails
  // inside the delivery's transaction.
  await pool.query(`CREATE FUNCTION fail_job_insert() RETURNS trigger
    LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'simulated queue push failure'; END $$`);
  await pool.query(`CREATE TRIGGER fail_push BEFORE INSERT ON pgboss.job
    FOR EACH ROW EXECUTE FUNCTION fail_job_insert()`);

  const failure = await host
    .deliver(mail, MessageDeliveryModes.TriggerTurn)
    .then(
      () => 'delivered',
      (error: unknown) => (Error.isError(error) ? error.message : 'unknown'),
    );
  const afterFailure = {
    failure,
    mail: await storage.mailboxStore.hasPending(recipient),
    streams: await storage.streams.store.listStreamIds(),
    turn: await storage.queue.getTurnActivity(recipient),
  };
  await pool.query('DROP TRIGGER fail_push ON pgboss.job');
  await host.deliver(mail, MessageDeliveryModes.TriggerTurn);

  assert.deepStrictEqual(
    {
      afterFailure,
      afterRetry: {
        mail: await storage.mailboxStore.hasPendingTriggerTurn(recipient),
        streams: (await storage.streams.store.listStreamIds()).length,
        turn: await storage.queue.getTurnActivity(recipient),
      },
    },
    {
      afterFailure: {
        failure: 'simulated queue push failure',
        mail: false,
        streams: [],
        turn: 'idle',
      },
      afterRetry: { mail: true, streams: 1, turn: 'queued' },
    },
  );
});
