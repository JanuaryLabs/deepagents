import { simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { InMemoryFs } from 'just-bash';
import { once } from 'node:events';
import { appendFile, readFile } from 'node:fs/promises';
import { PgBoss } from 'pg-boss';
import { z } from 'zod';

import {
  type AgentModel,
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
  defineAgent,
  defineTool,
} from '@deepagents/experimental/zukhruf';

const [mode, connectionString, queueName, mailboxPath, ...rest] =
  process.argv.slice(2);
if (!mode || !connectionString || !queueName || !mailboxPath) {
  throw new Error('approval dispatch fixture arguments are incomplete');
}

if (mode === 'decision') {
  await runDecision(rest);
} else if (mode === 'crash-worker') {
  await runCrashWorker(rest);
} else {
  throw new Error(`unknown approval dispatch fixture mode: ${mode}`);
}

async function runDecision(args: string[]): Promise<void> {
  const [conversationJson, decision, toolCallId] = args;
  if (!conversationJson || !decision || !toolCallId) {
    throw new Error('decision fixture arguments are incomplete');
  }
  const conversation = JSON.parse(conversationJson) as {
    chatId: string;
    userId: string;
  };
  const host = await createHost(
    defineAgent({
      name: 'approval-agent',
      model: {} as AgentModel,
      sandbox: async () => ({}) as AgentSandbox,
      instructions: [],
    }),
  );
  try {
    await send({ type: 'ready' });
    await once(process, 'message');
    try {
      const turn =
        decision === 'approve'
          ? await host.runtime.approve(conversation, { toolCallId })
          : await host.runtime.deny(conversation, {
              toolCallId,
              reason: 'concurrent denial',
            });
      await send({
        type: 'result',
        decision,
        status: 'fulfilled',
        id: turn.id,
      });
    } catch (error) {
      await send({
        type: 'result',
        decision,
        status: 'rejected',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  } finally {
    await host.close();
    process.disconnect?.();
  }
}

async function runCrashWorker(args: string[]): Promise<void> {
  const [markerPath, recovery] = args;
  if (!markerPath) throw new Error('crash worker marker path is required');
  const usage = {
    inputTokens: {
      total: 1,
      noCache: 1,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: { total: 1, text: 1, reasoning: undefined },
  } as const;
  const chunks = [
    { type: 'text-start' as const, id: 'text' },
    { type: 'text-delta' as const, id: 'text', delta: 'continued' },
    { type: 'text-end' as const, id: 'text' },
    {
      type: 'finish' as const,
      finishReason: { unified: 'stop' as const, raw: '' },
      usage,
    },
  ];
  const host = await createHost(
    defineAgent({
      name: 'approval-agent',
      model: new MockLanguageModelV4({
        doStream: async () => ({
          stream: simulateReadableStream({ chunks }),
        }),
      }),
      sandbox: async (): Promise<AgentSandbox> =>
        createBashTool({
          sandbox: await createVirtualSandbox({ fs: new InMemoryFs() }),
        }),
      instructions: [],
      tools: {
        sendEmail: defineTool({
          description: 'Send an email',
          inputSchema: z.object({ to: z.string() }),
          needsApproval: true,
          ...(recovery === 'idempotent'
            ? { recovery: 'idempotent' as const }
            : {}),
          execute: async ({ to }, { toolCallId }) => {
            if (recovery === 'idempotent') {
              await recordOnce(markerPath, `${toolCallId}:sent:${to}`);
            } else {
              await appendFile(markerPath, `child:${process.pid}\n`);
            }
            await send({ type: 'tool-started' });
            await new Promise<never>(() => {});
          },
        }),
      },
    }),
  );
  await host.runtime.work({ concurrency: 2 });
  await send({ type: 'ready' });
  await new Promise<never>(() => {});
}

async function recordOnce(path: string, entry: string): Promise<void> {
  try {
    if ((await readFile(path, 'utf8')).split('\n').includes(entry)) return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await appendFile(path, `${entry}\n`);
}

async function createHost(
  declaration: AgentDeclaration,
): Promise<{ runtime: AgentRuntime; close(): Promise<void> }> {
  const boss = new PgBoss({
    connectionString,
    monitorIntervalSeconds: 2,
    superviseIntervalSeconds: 2,
  });
  boss.on('error', () => {});
  await boss.start();
  const queue = new PgBossTurnQueue(boss, {
    queue: queueName,
    heartbeatSeconds: 10,
    pollingIntervalSeconds: 0.5,
  });
  await queue.initialize();
  const store = new PostgresContextStore({ pool: connectionString });
  const streamStore = new PostgresStreamStore({ pool: connectionString });
  await store.initialize();
  await streamStore.initialize();
  const mailboxStore = new SqliteMailboxStore(mailboxPath);
  return {
    runtime: new AgentRuntime(declaration, {
      store,
      streamStore,
      queue,
      mailboxStore,
    }),
    async close() {
      await boss.stop({ graceful: false });
      await store.close();
      await streamStore.close();
      mailboxStore.close();
    },
  };
}

function send(message: Record<string, unknown>): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!process.send) {
      reject(new Error('approval dispatch fixture requires IPC'));
      return;
    }
    process.send(message, (error) => (error ? reject(error) : resolve()));
  });
}
