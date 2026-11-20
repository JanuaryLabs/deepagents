import { Postgres } from '@zukhruf/testing/postgres';
import { MockLanguageModelV4 } from 'ai/test';
import { InMemoryFs } from 'just-bash';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { PgBoss } from 'pg-boss';

import {
  PostgresContextStore,
  PostgresStreamStore,
  createVirtualSandbox,
} from '@deepagents/context';
import {
  AgentRuntime,
  PgBossTurnQueue,
  PostgresMailboxStore,
  defineAgent,
  defineSandbox,
  defineStack,
} from '@deepagents/experimental/zukhruf';

import {
  textResult,
  toolCallResult,
} from '../../testing/stream-results.fixture.ts';
import { streamsFor } from '../../testing/streams-for.fixture.ts';
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
  const stack = defineStack(async (stackResources) => {
    const store = await PostgresContextStore.create({ pool });
    stackResources.defer(() => store.close());
    const streamStore = await PostgresStreamStore.create({ pool });
    stackResources.defer(() => streamStore.close());
    return {
      store,
      streams: streamsFor(streamStore),
      queue: await PgBossTurnQueue.create(boss, {
        pollingIntervalSeconds: 0.5,
      }),
      mailboxStore: await PostgresMailboxStore.create({ pool }),
    };
  });

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
