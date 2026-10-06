import { simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { InMemoryFs } from 'just-bash';
import spawn, { SubprocessError } from 'nano-spawn';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { describe, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { PgBoss } from 'pg-boss';

import {
  type AgentSandbox,
  PollingChangeSource,
  PostgresContextStore,
  PostgresStreamStore,
  StreamManager,
  createBashTool,
  createVirtualSandbox,
} from '@deepagents/context';
import {
  type AgentDeclaration,
  AgentRuntime,
  PgBossTurnQueue,
  SqliteMailboxStore,
  defineStack,
} from '@deepagents/experimental/zukhruf';
import { Postgres } from '@deepagents/test';

const testPostgres = new Postgres();

const userTurn = (id: string, text: string) => ({
  message: {
    id,
    role: 'user' as const,
    parts: [{ type: 'text' as const, text }],
  },
  trigger: 'submit-message' as const,
});

const usage = {
  inputTokens: {
    total: 1,
    noCache: 1,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 2, text: 2, reasoning: undefined },
} as const;

const fixture = join(import.meta.dirname, 'crash-worker.fixture.ts');

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
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
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

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('zukhruf crash recovery — worker process killed mid-turn', () => {
  it('stops an owned crash-worker when its parent test process exits', async (t) => {
    await using container = await testPostgres.database();
    await using resources = new AsyncDisposableStack();

    const ownerSource = `
          import { spawn } from 'node:child_process';
          const fixture = spawn(
            process.execPath,
            ${JSON.stringify([fixture, container.connectionString])},
            { stdio: ['ignore', 'pipe', 'pipe'] },
          );
          console.log('FIXTURE ' + fixture.pid);
          fixture.stdout.pipe(process.stdout);
          fixture.stderr.pipe(process.stderr);
          setInterval(() => {}, 1 << 30);
        `;
    const subprocess = spawn(
      process.execPath,
      ['--input-type=module', '--eval', ownerSource],
      { stdin: 'ignore' },
    );
    const completed = Promise.allSettled([subprocess]);
    const owner = await subprocess.nodeChildProcess;
    resources.defer(async () => {
      owner.kill('SIGKILL');
      await completed;
    });
    assert.ok(owner.stdout);
    using lines = createInterface({
      input: owner.stdout,
      signal: AbortSignal.timeout(30_000),
    });
    const output = lines[Symbol.asyncIterator]();
    const first = await output.next();
    assert.ok(!first.done, 'owner exited before reporting the fixture PID');
    const match = first.value.match(/^FIXTURE (\d+)$/);
    assert.ok(match, first.value);
    const fixturePid = Number(match[1]);
    resources.defer(() => {
      if (isProcessAlive(fixturePid)) process.kill(fixturePid, 'SIGKILL');
    });

    for await (const line of output) {
      if (line !== 'WORKER READY') continue;
      owner.kill('SIGTERM');
      await assert.rejects(subprocess, {
        name: 'SubprocessError',
        signalName: 'SIGTERM',
      });
      await t.waitFor(() => assert.equal(isProcessAlive(fixturePid), false), {
        interval: 100,
        timeout: 5_000,
      });
      return;
    }
    assert.fail('owner output ended before WORKER READY');
  });

  it('heartbeat lapse fails the job; the DLQ reconciler flips the stream and unblocks the chat', async () => {
    await using container = await testPostgres.database();

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
    const streams = new StreamManager({
      store: streamStore,
      changeSource: new PollingChangeSource({ reads: streamStore }),
    });
    const runtimeSetup = new AgentRuntime(declaration(fastModel(calls)));
    const stack = defineStack(async () => ({
      store,
      streams,
      queue,
      mailboxStore,
    }));
    const runtime = await runtimeSetup.initialize(stack);
    const conversation = { chatId: 'crash-chat', userId: 'u1' };

    try {
      await using resources = new AsyncDisposableStack();
      const first = await runtime.enqueue(
        conversation,
        userTurn(crypto.randomUUID(), 'a very long task'),
      );

      const subprocess = spawn(
        process.execPath,
        [fixture, container.connectionString],
        { stdin: 'ignore' },
      );
      const completed = Promise.allSettled([subprocess]);
      const child = await subprocess.nodeChildProcess;
      resources.defer(async () => {
        child.kill('SIGKILL');
        await completed;
      });

      try {
        await waitForStatus(streamStore, first.id, ['running'], 30_000);
      } catch (error) {
        child.kill('SIGKILL');
        const result = await subprocess.catch((failure: unknown) => {
          assert.ok(failure instanceof SubprocessError);
          return failure;
        });
        throw new Error(
          `${(error as Error).message}\nchild stderr:\n${result.stderr}`,
        );
      }

      child.kill('SIGKILL');
      await assert.rejects(subprocess, {
        name: 'SubprocessError',
        signalName: 'SIGKILL',
      });

      await using worker = await runtime.work();
      await waitForStatus(streamStore, first.id, ['failed'], 120_000);
      const failed = await streamStore.getStream(first.id);
      assert.ok(failed?.error, 'orphaned stream carries an error message');

      const second = await runtime.enqueue(
        conversation,
        userTurn(crypto.randomUUID(), 'after the crash'),
      );
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
      await boss.stop({ graceful: false });
      mailboxStore.close();
      await streamStore.close();
      await store.close();
    }
  });
});
