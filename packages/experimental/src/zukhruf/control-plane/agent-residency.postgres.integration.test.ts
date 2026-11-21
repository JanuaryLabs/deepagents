import { type LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { waitFor } from '@zukhruf/testing/async';
import { Postgres, type PostgresDatabase } from '@zukhruf/testing/postgres';
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import assert from 'node:assert/strict';
import test from 'node:test';
import { PgBoss } from 'pg-boss';
import { z } from 'zod';

import {
  type AgentDeclaration,
  type AgentHost,
  AgentRuntime,
  AgentThreadLimitError,
  type ConversationId,
  PostgresAgentStorage,
  Team,
  defineAgent,
  defineStack,
} from '@deepagents/experimental/zukhruf';

import { buildSandbox } from '../../testing/build-sandbox.fixture.ts';
import { usage } from '../../testing/usage.fixture.ts';
import { userTurn } from '../../testing/user-turn.fixture.ts';

const testPostgres = new Postgres({ environment: process.env });

const ROOT = { chatId: 'root-chat', userId: 'user-1' };

/** Conversation metadata as `AgentThread.toMetadata` writes it. */
const threadPathSchema = z.looseObject({
  zukhruf: z.looseObject({ path: z.string() }),
});

function text(value: string) {
  return {
    stream: simulateReadableStream<LanguageModelV4StreamPart>({
      chunks: [
        { type: 'text-start', id: 'text' },
        { type: 'text-delta', id: 'text', delta: value },
        { type: 'text-end', id: 'text' },
        { type: 'finish', finishReason: { unified: 'stop', raw: '' }, usage },
      ],
    }),
  };
}

function spawnStep(taskName: string) {
  return {
    stream: simulateReadableStream<LanguageModelV4StreamPart>({
      chunks: [
        {
          type: 'tool-call',
          toolCallId: `spawn-${taskName}-${crypto.randomUUID()}`,
          toolName: 'spawn_agent',
          input: JSON.stringify({
            agent_type: 'worker',
            task_name: taskName,
            message: `work on ${taskName}`,
            fork_turns: 'all',
          }),
        },
        {
          type: 'finish',
          finishReason: { unified: 'tool-calls', raw: '' },
          usage,
        },
      ],
    }),
  };
}

/**
 * A root whose every turn spawns the next scripted task and answers the
 * spawn's result with text; `beforeSpawn` runs before the step is returned.
 */
function rootSpawning(
  tasks: string[],
  beforeSpawn: (taskName: string) => Promise<void> = async () => {},
): AgentDeclaration {
  return defineAgent({
    name: 'root',
    model: new MockLanguageModelV4({
      doStream: async ({ prompt }) => {
        if (prompt.at(-1)?.role === 'tool') return text('root noted it');
        const task = tasks.shift();
        if (!task) return text('nothing to spawn');
        await beforeSpawn(task);
        return spawnStep(task);
      },
    }),
    sandbox: buildSandbox,
    instructions: [],
    subagents: [
      defineAgent({
        name: 'worker',
        model: new MockLanguageModelV4({ doStream: async () => text('done') }),
        sandbox: buildSandbox,
        instructions: [],
      }),
    ],
  });
}

async function startedBoss(
  resources: AsyncDisposableStack,
  database: PostgresDatabase,
): Promise<PgBoss> {
  const boss = new PgBoss({ connectionString: database.connectionString });
  boss.on('error', () => {});
  await boss.start();
  resources.defer(() => boss.stop({ graceful: false }));
  return boss;
}

/** A host with its own pool and PgBoss on `database`. */
async function hostOn(
  resources: AsyncDisposableStack,
  database: PostgresDatabase,
  root: AgentDeclaration,
  maxConcurrentThreadsPerSession: number,
) {
  const boss = await startedBoss(resources, database);
  const storage = resources.use(
    await PostgresAgentStorage.create({
      pool: database.pool(),
      boss,
      queue: { pollingIntervalSeconds: 0.5 },
    }),
  );
  const runtime = resources.use(
    await new AgentRuntime(root).initialize(
      defineStack(async () => ({
        storage,
        multiAgent: Team.codex({
          maxConcurrentThreads: maxConcurrentThreadsPerSession,
        }),
      })),
    ),
  );
  return { runtime, storage };
}

async function treeOf(
  runtime: AgentHost,
): Promise<Map<string, ConversationId>> {
  const history = await runtime.listHistory(ROOT.userId);
  const root = history.find((item) => item.chatId === ROOT.chatId);
  return new Map(
    (root?.children ?? []).map((child) => [
      child.path,
      { chatId: child.chatId, userId: ROOT.userId },
    ]),
  );
}

async function runRootTurn(
  runtime: AgentHost,
  id: string,
  signal: AbortSignal,
): Promise<void> {
  const turn = await runtime.enqueue(ROOT, userTurn(id, 'spawn the next'));
  await waitFor(
    async () =>
      assert.equal(
        (await runtime.observe(ROOT).status(turn.id))?.status,
        'completed',
      ),
    { signal },
  );
}

// Twenty rounds of two full admissions each: on a database server shared with
// the whole suite a round takes seconds, past the suite's per-test limit.
test(
  'two hosts with their own PgBoss on one database admit exactly one of two concurrent turns to idle sub-agents at a limit of 2, every time',
  { timeout: 600_000 },
  async (t) => {
    await using resources = new AsyncDisposableStack();
    const database = resources.use(await testPostgres.database());
    const first = await hostOn(
      resources,
      database,
      rootSpawning(['a', 'b']),
      2,
    );
    const second = await hostOn(resources, database, rootSpawning([]), 2);
    {
      // Arrange two idle children: each spawn runs to completion before the next.
      await using worker = await first.runtime.work();
      for (const id of ['spawn-a', 'spawn-b']) {
        await runRootTurn(first.runtime, id, t.signal);
        await waitFor(
          async () => {
            const children = (await first.runtime.listHistory(ROOT.userId))
              .find((item) => item.chatId === ROOT.chatId)
              ?.children?.map((child) => child.state);
            assert.ok(children?.length);
            assert.ok(children.every((state) => state === 'completed'));
          },
          { signal: t.signal },
        );
      }
      void worker;
    }
    const tree = await treeOf(first.runtime);
    const a = tree.get('/root/a');
    const b = tree.get('/root/b');
    assert.ok(a && b);

    const rounds: string[] = [];
    for (let round = 0; round < 20; round++) {
      const outcomes = await Promise.allSettled([
        first.runtime.enqueue(a, userTurn(`a-${round}`, 'go')),
        second.runtime.enqueue(b, userTurn(`b-${round}`, 'go')),
      ]);
      rounds.push(
        outcomes
          .map((outcome) =>
            outcome.status === 'fulfilled'
              ? 'admitted'
              : outcome.reason instanceof AgentThreadLimitError
                ? 'refused'
                : String(outcome.reason),
          )
          .toSorted()
          .join(','),
      );
      for (const [index, outcome] of outcomes.entries()) {
        if (outcome.status !== 'fulfilled') continue;
        await (index === 0 ? first : second).runtime
          .observe(index === 0 ? a : b)
          .cancel(outcome.value.id);
      }
    }

    assert.deepStrictEqual(
      rounds,
      Array.from({ length: 20 }, () => 'admitted,refused'),
    );
  },
);

test('a session terminated in the middle of a spawn admission leaves no child chat, stream or job, and a retried spawn creates the child', async (t) => {
  await using resources = new AsyncDisposableStack();
  const database = resources.use(await testPostgres.database());
  const observer = database.pool();
  // Platform setup no storage operation exposes: hold writes to the streams
  // table, so the spawn admission stops at its stream after writing the
  // child chat and its forked history.
  const holder = await observer.connect();
  resources.defer(() => holder.release());
  let held = false;
  const host = await hostOn(
    resources,
    database,
    rootSpawning(['child', 'child'], async () => {
      if (held) return;
      held = true;
      await holder.query('BEGIN');
      await holder.query('LOCK TABLE "public"."streams" IN EXCLUSIVE MODE');
    }),
    2,
  );
  await using worker = await host.runtime.work();
  void worker;
  const jobsOfChildren = async () =>
    (
      await observer.query<{ jobs: number }>(
        `SELECT count(*)::int AS jobs FROM pgboss.job
         WHERE name = 'zukhruf-turns' AND data->>'chatId' <> $1`,
        [ROOT.chatId],
      )
    ).rows[0]?.jobs;

  const killed = await host.runtime.enqueue(
    ROOT,
    userTurn('spawn-killed', 'spawn the child'),
  );
  const holderPid = (
    await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
  ).rows[0]?.pid;
  // The admission is the one backend the holder blocks that holds a tree
  // lock; the root turn's own stream writes wait on the holder too.
  const pid = await waitFor(
    async () => {
      const { rows } = await observer.query<{ pid: number }>(
        `SELECT activity.pid FROM pg_stat_activity AS activity
         WHERE $1 = ANY(pg_blocking_pids(activity.pid))
           AND EXISTS (SELECT 1 FROM pg_locks
             WHERE pg_locks.pid = activity.pid
               AND pg_locks.locktype = 'advisory' AND pg_locks.granted)`,
        [holderPid],
      );
      assert.equal(rows.length, 1);
      return rows[0]?.pid;
    },
    { signal: t.signal, interval: 25 },
  );
  await observer.query('SELECT pg_terminate_backend($1)', [pid]);
  await holder.query('ROLLBACK');
  await waitFor(
    async () =>
      assert.equal(
        (await host.runtime.observe(ROOT).status(killed.id))?.status,
        'completed',
      ),
    { signal: t.signal },
  );
  const afterKill = {
    chats: (await host.storage.store.listChats({ userId: ROOT.userId })).map(
      (chat) => threadPathSchema.parse(chat.metadata).zukhruf.path,
    ),
    streams: (await host.storage.streams.store.listStreamIds()).length,
    jobs: await jobsOfChildren(),
  };

  assert.deepStrictEqual(afterKill, { chats: ['/root'], streams: 1, jobs: 0 });

  await runRootTurn(host.runtime, 'spawn-retried', t.signal);

  // The retried admission wrote the child's turn: it runs to completion.
  await waitFor(
    async () =>
      assert.deepStrictEqual(
        (await host.runtime.listHistory(ROOT.userId))[0]?.children?.map(
          (child) => [child.path, child.state],
        ),
        [['/root/child', 'completed']],
      ),
    { signal: t.signal },
  );
});
