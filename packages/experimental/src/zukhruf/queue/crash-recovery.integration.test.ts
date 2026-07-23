import { simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { InMemoryFs } from 'just-bash';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { PgBoss } from 'pg-boss';

import {
  type AgentSandbox,
  PostgresContextStore,
  PostgresStreamStore,
  createBashTool,
  createVirtualSandbox,
} from '@deepagents/context';
import {
  type AgentDeclaration,
  AgentRuntime,
  PgBossTurnQueue,
  SqliteMailboxStore,
} from '@deepagents/experimental/zukhruf';
import { isDockerAvailable, withPostgresContainer } from '@deepagents/test';

const usage = {
  inputTokens: {
    total: 1,
    noCache: 1,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 2, text: 2, reasoning: undefined },
} as const;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const fixture = fileURLToPath(
  new URL('./crash-worker.fixture.ts', import.meta.url),
);

function fastModel(calls: string[]) {
  return new MockLanguageModelV4({
    doStream: async ({ prompt }) => {
      const messages = prompt as Array<{
        role: string;
        content: Array<{ type: string; text?: string }>;
      }>;
      const text =
        messages
          .filter((m) => m.role === 'user')
          .at(-1)
          ?.content.filter((p) => p.type === 'text')
          .map((p) => p.text ?? '')
          .join('') ?? '';
      calls.push(text);
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: 'text-start', id: 't1' },
            { type: 'text-delta', id: 't1', delta: `reply:${text}` },
            { type: 'text-end', id: 't1' },
            {
              type: 'finish',
              finishReason: { unified: 'stop', raw: '' },
              usage,
            },
          ],
        }),
      };
    },
  });
}

function declaration(model: AgentDeclaration['model']): AgentDeclaration {
  return {
    name: 'crash-agent',
    model,
    sandbox: async (): Promise<AgentSandbox> =>
      createBashTool({
        sandbox: await createVirtualSandbox({ fs: new InMemoryFs() }),
      }),
    instructions: [],
  };
}

async function waitForStatus(
  streamStore: PostgresStreamStore,
  id: string,
  accept: string[],
  timeoutMs: number,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await streamStore.getStreamStatus(id);
    if (status && accept.includes(status)) return status;
    await sleep(200);
  }
  throw new Error(
    `timed out after ${timeoutMs}ms waiting for ${accept.join('/')} on ${id} ` +
      `(last: ${await streamStore.getStreamStatus(id)})`,
  );
}

async function collectText(stream: ReadableStream) {
  let text = '';
  for await (const part of stream as ReadableStream<{
    type: string;
    delta?: string;
  }>) {
    if (part.type === 'text-delta') text += part.delta ?? '';
  }
  return text;
}

const docker = await isDockerAvailable();

describe(
  'zukhruf crash recovery — worker process killed mid-turn',
  { skip: !docker },
  () => {
    it('heartbeat lapse fails the job; the DLQ reconciler flips the stream and unblocks the chat', async () => {
      await withPostgresContainer(async (container) => {
        const streamStore = new PostgresStreamStore({
          pool: container.connectionString,
        });
        await streamStore.initialize();
        const store = new PostgresContextStore({
          pool: container.connectionString,
        });
        await store.initialize();

        const boss = new PgBoss({
          connectionString: container.connectionString,
          monitorIntervalSeconds: 2,
          superviseIntervalSeconds: 2,
        });
        boss.on('error', () => {});
        await boss.start();
        const queue = new PgBossTurnQueue(boss, {
          heartbeatSeconds: 10,
          pollingIntervalSeconds: 0.5,
        });
        await queue.initialize();

        const calls: string[] = [];
        const mailboxStore = new SqliteMailboxStore(':memory:');
        const runtime = new AgentRuntime(declaration(fastModel(calls)), {
          store,
          streamStore,
          queue,
          mailboxStore,
        });
        const conversation = { chatId: 'crash-chat', userId: 'u1' };

        let child: ReturnType<typeof spawn> | undefined;
        let worker: AsyncDisposable | undefined;
        try {
          const first = await runtime.enqueue(conversation, {
            id: crypto.randomUUID(),
            input: 'a very long task',
          });

          child = spawn('node', [fixture, container.connectionString], {
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          const childStderr: string[] = [];
          child.stderr?.on('data', (d) => childStderr.push(String(d)));

          try {
            await waitForStatus(streamStore, first.id, ['running'], 30_000);
          } catch (error) {
            throw new Error(
              `${(error as Error).message}\nchild stderr:\n${childStderr.join('')}`,
            );
          }

          child.kill('SIGKILL');

          worker = await runtime.work();
          await waitForStatus(streamStore, first.id, ['failed'], 120_000);
          const failed = await streamStore.getStream(first.id);
          assert.ok(failed?.error, 'orphaned stream carries an error message');

          const second = await runtime.enqueue(conversation, {
            id: crypto.randomUUID(),
            input: 'after the crash',
          });
          const text = await collectText(second.stream);
          assert.equal(text, 'reply:after the crash', 'chat unblocked');
          assert.deepStrictEqual(
            calls,
            ['after the crash'],
            'crashed turn never re-ran',
          );
          assert.equal(await streamStore.getStreamStatus(first.id), 'failed');

          const remaining = await boss.findJobs(queue.queue, {
            key: 'crash-chat',
          });
          assert.deepStrictEqual(
            remaining.map((j) => j.state),
            [],
            'DLQ reconciler deleted the crashed source job and the successor was GC-ed on commit — no orphan job accumulates in the main queue',
          );
        } finally {
          child?.kill('SIGKILL');
          if (worker) await worker[Symbol.asyncDispose]();
          await boss.stop({ graceful: false });
          mailboxStore.close();
          await streamStore.close();
          await store.close();
        }
      });
    });
  },
);
