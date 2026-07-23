import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';
import {
  type ToolSet,
  type UIMessage,
  isToolUIPart,
  simulateReadableStream,
} from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { InMemoryFs } from 'just-bash';
import assert from 'node:assert/strict';
import { type ChildProcess, fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { PgBoss } from 'pg-boss';
import { z } from 'zod';

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
  defineTool,
} from '@deepagents/experimental/zukhruf';
import { isDockerAvailable, withPostgresContainer } from '@deepagents/test';

const fixture = new URL('./approval-dispatch.fixture.ts', import.meta.url);
const docker = await isDockerAvailable();
const usage = {
  inputTokens: {
    total: 1,
    noCache: 1,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
} as const;

interface ApprovalTrack {
  calls: string[];
  toolRuns: number;
}

interface Scenario {
  connectionString: string;
  queueName: string;
  mailboxPath: string;
  markerPath: string;
}

interface RuntimeHost {
  runtime: AgentRuntime;
  close(): Promise<void>;
}

interface FixtureProcess {
  child: ChildProcess;
  stderr: string[];
}

interface DecisionResult {
  type: 'result';
  decision: 'approve' | 'deny';
  status: 'fulfilled' | 'rejected';
  id?: string;
  error?: string;
}

test(
  'conflicting approvals from independent processes produce one durable decision',
  { skip: !docker, timeout: 45_000 },
  async () => {
    await withScenario(async (scenario) => {
      const track = { calls: [], toolRuns: 0 } satisfies ApprovalTrack;
      const host = await createHost(scenario, approvalDeclaration(track));
      let worker: AsyncDisposable | undefined;
      const children: FixtureProcess[] = [];
      try {
        worker = await host.runtime.work();
        const conversation = {
          chatId: `approval-race-${crypto.randomUUID()}`,
          userId: 'user-1',
        };
        await pauseForApproval(host.runtime, conversation);

        const approve = await startDecisionProcess(
          scenario,
          conversation,
          'approve',
        );
        children.push(approve);
        const deny = await startDecisionProcess(scenario, conversation, 'deny');
        children.push(deny);

        const results = await Promise.all([
          runDecision(approve),
          runDecision(deny),
        ]);
        assert.equal(
          results.filter((result) => result.status === 'fulfilled').length,
          1,
        );
        assert.match(
          results.find((result) => result.status === 'rejected')?.error ?? '',
          /approval already answered with a different decision/,
        );

        const messages = await waitForConversation(
          host.runtime,
          conversation,
          (current) =>
            track.calls.length === 2 &&
            ['output-available', 'output-denied'].includes(
              approvalPart(current)?.state ?? '',
            ),
          'the winning approval continuation',
        );
        const approveWon =
          results.find((result) => result.decision === 'approve')?.status ===
          'fulfilled';
        assert.equal(
          approvalPart(messages)?.state,
          approveWon ? 'output-available' : 'output-denied',
        );
        assert.equal(track.toolRuns, approveWon ? 1 : 0);
        assert.deepEqual(track.calls, ['send it', 'send it']);
        assert.equal(
          messages.filter((message) => message.role === 'assistant').length,
          1,
          'the decision continues the original assistant turn exactly once',
        );
      } finally {
        await worker?.[Symbol.asyncDispose]();
        await Promise.all(children.map(stopFixtureProcess));
        await host.close();
      }
    });
  },
);

test(
  'duplicate approvals from independent processes execute the tool exactly once',
  { skip: !docker, timeout: 45_000 },
  async () => {
    await withScenario(async (scenario) => {
      const track = { calls: [], toolRuns: 0 } satisfies ApprovalTrack;
      const host = await createHost(scenario, approvalDeclaration(track));
      let worker: AsyncDisposable | undefined;
      const children: FixtureProcess[] = [];
      try {
        worker = await host.runtime.work();
        const conversation = {
          chatId: `double-approval-${crypto.randomUUID()}`,
          userId: 'user-1',
        };
        await pauseForApproval(host.runtime, conversation);

        const first = await startDecisionProcess(
          scenario,
          conversation,
          'approve',
        );
        children.push(first);
        const second = await startDecisionProcess(
          scenario,
          conversation,
          'approve',
        );
        children.push(second);
        const results = await Promise.all([
          runDecision(first),
          runDecision(second),
        ]);

        assert.deepEqual(
          results.map((result) => result.status),
          ['fulfilled', 'fulfilled'],
        );
        assert.equal(new Set(results.map((result) => result.id)).size, 1);
        const messages = await waitForConversation(
          host.runtime,
          conversation,
          (current) =>
            track.calls.length === 2 &&
            approvalPart(current)?.state === 'output-available',
          'the idempotent approval continuation',
        );
        assert.equal(track.toolRuns, 1);
        assert.deepEqual(track.calls, ['send it', 'send it']);
        assert.equal(
          messages.filter((message) => message.role === 'assistant').length,
          1,
        );
      } finally {
        await worker?.[Symbol.asyncDispose]();
        await Promise.all(children.map(stopFixtureProcess));
        await host.close();
      }
    });
  },
);

test(
  'an approval accepted without a worker survives restart and preserves later-turn FIFO',
  { skip: !docker, timeout: 45_000 },
  async () => {
    await withScenario(async (scenario) => {
      const track = { calls: [], toolRuns: 0 } satisfies ApprovalTrack;
      const declaration = approvalDeclaration(track);
      let firstHost: RuntimeHost | undefined;
      let secondHost: RuntimeHost | undefined;
      let firstWorker: AsyncDisposable | undefined;
      let secondWorker: AsyncDisposable | undefined;
      try {
        firstHost = await createHost(scenario, declaration);
        firstWorker = await firstHost.runtime.work();
        const conversation = {
          chatId: `approval-restart-${crypto.randomUUID()}`,
          userId: 'user-1',
        };
        const part = await pauseForApproval(firstHost.runtime, conversation);
        await firstWorker[Symbol.asyncDispose]();
        firstWorker = undefined;

        await firstHost.runtime.enqueue(conversation, {
          id: crypto.randomUUID(),
          input: 'second',
        });
        await firstHost.runtime.enqueue(conversation, {
          id: crypto.randomUUID(),
          input: 'third',
        });
        await firstHost.runtime.approve(conversation, {
          toolCallId: part.toolCallId,
        });
        assert.deepEqual(track.calls, ['send it']);
        assert.equal(track.toolRuns, 0, 'nothing executes without a worker');

        await firstHost.close();
        firstHost = undefined;
        secondHost = await createHost(scenario, declaration);
        secondWorker = await secondHost.runtime.work({ concurrency: 2 });

        const messages = await waitForConversation(
          secondHost.runtime,
          conversation,
          (current) =>
            track.calls.length === 4 &&
            messageText(current.at(-1)) === 'reply:third',
          'the restarted worker to finish the continuation and backlog',
        );
        assert.deepEqual(track.calls, [
          'send it',
          'send it',
          'second',
          'third',
        ]);
        assert.equal(track.toolRuns, 1);
        assert.equal(approvalPart(messages)?.state, 'output-available');
      } finally {
        await firstWorker?.[Symbol.asyncDispose]();
        await secondWorker?.[Symbol.asyncDispose]();
        await firstHost?.close();
        await secondHost?.close();
      }
    });
  },
);

test(
  'a worker killed after an approved tool starts does not duplicate the tool or strand later turns',
  { skip: !docker, timeout: 60_000 },
  async () => {
    await withScenario(async (scenario) => {
      const track = { calls: [], toolRuns: 0 } satisfies ApprovalTrack;
      const declaration = approvalDeclaration(track, scenario.markerPath);
      let firstHost: RuntimeHost | undefined;
      let recoveryHost: RuntimeHost | undefined;
      let firstWorker: AsyncDisposable | undefined;
      let recoveryWorker: AsyncDisposable | undefined;
      let crashedWorker: FixtureProcess | undefined;
      try {
        firstHost = await createHost(scenario, declaration);
        firstWorker = await firstHost.runtime.work();
        const conversation = {
          chatId: `approval-crash-${crypto.randomUUID()}`,
          userId: 'user-1',
        };
        const part = await pauseForApproval(firstHost.runtime, conversation);
        await firstWorker[Symbol.asyncDispose]();
        firstWorker = undefined;
        await firstHost.runtime.enqueue(conversation, {
          id: crypto.randomUUID(),
          input: 'after crash',
        });

        crashedWorker = await startCrashWorker(scenario);
        await firstHost.runtime.approve(conversation, {
          toolCallId: part.toolCallId,
        });
        await waitForFixtureMessage(crashedWorker, 'tool-started', 15_000);
        assert.equal((await markerLines(scenario.markerPath)).length, 1);
        crashedWorker.child.kill('SIGKILL');
        await waitForExit(crashedWorker.child);

        await firstHost.close();
        firstHost = undefined;
        recoveryHost = await createHost(scenario, declaration);
        recoveryWorker = await recoveryHost.runtime.work({ concurrency: 2 });

        const messages = await waitForConversation(
          recoveryHost.runtime,
          conversation,
          (current) =>
            approvalPart(current)?.state === 'output-error' &&
            messageText(current.at(-1)) === 'reply:after crash',
          'orphan reconciliation and the parked follow-up',
          45_000,
        );
        assert.equal(approvalPart(messages)?.state, 'output-error');
        assert.equal((await markerLines(scenario.markerPath)).length, 1);
        assert.deepEqual(track.calls, ['send it', 'after crash']);
        assert.equal(
          track.toolRuns,
          0,
          'the recovery worker never reruns the tool',
        );
      } finally {
        await firstWorker?.[Symbol.asyncDispose]();
        await recoveryWorker?.[Symbol.asyncDispose]();
        if (crashedWorker) await stopFixtureProcess(crashedWorker);
        await firstHost?.close();
        await recoveryHost?.close();
      }
    });
  },
);

test(
  'an idempotent approved tool recovers automatically after its worker is killed',
  { skip: !docker, timeout: 60_000 },
  async () => {
    await withScenario(async (scenario) => {
      const track = { calls: [], toolRuns: 0 } satisfies ApprovalTrack;
      const declaration = approvalDeclaration(
        track,
        scenario.markerPath,
        'idempotent',
      );
      let firstHost: RuntimeHost | undefined;
      let recoveryHost: RuntimeHost | undefined;
      let firstWorker: AsyncDisposable | undefined;
      let recoveryWorker: AsyncDisposable | undefined;
      let crashedWorker: FixtureProcess | undefined;
      try {
        firstHost = await createHost(scenario, declaration);
        firstWorker = await firstHost.runtime.work();
        const conversation = {
          chatId: `approval-idempotent-crash-${crypto.randomUUID()}`,
          userId: 'user-1',
        };
        const part = await pauseForApproval(firstHost.runtime, conversation);
        await firstWorker[Symbol.asyncDispose]();
        firstWorker = undefined;
        await firstHost.runtime.enqueue(conversation, {
          id: crypto.randomUUID(),
          input: 'after crash',
        });

        crashedWorker = await startCrashWorker(scenario, 'idempotent');
        await firstHost.runtime.approve(conversation, {
          toolCallId: part.toolCallId,
        });
        await waitForFixtureMessage(crashedWorker, 'tool-started', 15_000);
        assert.deepEqual(await markerLines(scenario.markerPath), [
          'approval-call:sent:a@b.c',
        ]);
        crashedWorker.child.kill('SIGKILL');
        await waitForExit(crashedWorker.child);

        await firstHost.close();
        firstHost = undefined;
        recoveryHost = await createHost(scenario, declaration);
        recoveryWorker = await recoveryHost.runtime.work({ concurrency: 2 });

        const messages = await waitForConversation(
          recoveryHost.runtime,
          conversation,
          (current) =>
            ['output-available', 'output-error'].includes(
              approvalPart(current)?.state ?? '',
            ) && messageText(current.at(-1)) === 'reply:after crash',
          'idempotent approval recovery and the parked follow-up',
          45_000,
        );
        assert.equal(approvalPart(messages)?.state, 'output-available');
        assert.deepEqual(await markerLines(scenario.markerPath), [
          'approval-call:sent:a@b.c',
        ]);
        assert.deepEqual(track.calls, ['send it', 'send it', 'after crash']);
        assert.equal(track.toolRuns, 1);
      } finally {
        await firstWorker?.[Symbol.asyncDispose]();
        await recoveryWorker?.[Symbol.asyncDispose]();
        if (crashedWorker) await stopFixtureProcess(crashedWorker);
        await firstHost?.close();
        await recoveryHost?.close();
      }
    });
  },
);

test(
  'an idempotent approved tool gets at most one automatic crash replay',
  { skip: !docker, timeout: 90_000 },
  async () => {
    await withScenario(async (scenario) => {
      const track = { calls: [], toolRuns: 0 } satisfies ApprovalTrack;
      const declaration = approvalDeclaration(
        track,
        scenario.markerPath,
        'idempotent',
      );
      let firstHost: RuntimeHost | undefined;
      let finalHost: RuntimeHost | undefined;
      let firstWorker: AsyncDisposable | undefined;
      let finalWorker: AsyncDisposable | undefined;
      let firstCrash: FixtureProcess | undefined;
      let recoveryCrash: FixtureProcess | undefined;
      try {
        firstHost = await createHost(scenario, declaration);
        firstWorker = await firstHost.runtime.work();
        const conversation = {
          chatId: `approval-idempotent-recovery-crash-${crypto.randomUUID()}`,
          userId: 'user-1',
        };
        const part = await pauseForApproval(firstHost.runtime, conversation);
        await firstWorker[Symbol.asyncDispose]();
        firstWorker = undefined;
        await firstHost.runtime.enqueue(conversation, {
          id: crypto.randomUUID(),
          input: 'after crash',
        });

        firstCrash = await startCrashWorker(scenario, 'idempotent');
        await firstHost.runtime.approve(conversation, {
          toolCallId: part.toolCallId,
        });
        await waitForFixtureMessage(firstCrash, 'tool-started', 15_000);
        firstCrash.child.kill('SIGKILL');
        await waitForExit(firstCrash.child);
        await firstHost.close();
        firstHost = undefined;

        recoveryCrash = await startCrashWorker(scenario, 'idempotent');
        await waitForFixtureMessage(recoveryCrash, 'tool-started', 30_000);
        recoveryCrash.child.kill('SIGKILL');
        await waitForExit(recoveryCrash.child);

        finalHost = await createHost(scenario, declaration);
        finalWorker = await finalHost.runtime.work({ concurrency: 2 });
        const messages = await waitForConversation(
          finalHost.runtime,
          conversation,
          (current) =>
            approvalPart(current)?.state === 'output-error' &&
            messageText(current.at(-1)) === 'reply:after crash',
          'the failed recovery attempt and the parked follow-up',
          45_000,
        );
        assert.equal(approvalPart(messages)?.state, 'output-error');
        assert.deepEqual(await markerLines(scenario.markerPath), [
          'approval-call:sent:a@b.c',
        ]);
        assert.deepEqual(track.calls, ['send it', 'after crash']);
        assert.equal(track.toolRuns, 0);
      } finally {
        await firstWorker?.[Symbol.asyncDispose]();
        await finalWorker?.[Symbol.asyncDispose]();
        if (firstCrash) await stopFixtureProcess(firstCrash);
        if (recoveryCrash) await stopFixtureProcess(recoveryCrash);
        await firstHost?.close();
        await finalHost?.close();
      }
    });
  },
);

function approvalDeclaration(
  track: ApprovalTrack,
  markerPath?: string,
  recovery?: 'idempotent',
): AgentDeclaration {
  const tools: ToolSet = {
    sendEmail: defineTool({
      description: 'Send an email',
      inputSchema: z.object({ to: z.string() }),
      needsApproval: true,
      ...(recovery ? { recovery } : {}),
      execute: async ({ to }, { toolCallId }) => {
        track.toolRuns++;
        if (markerPath) {
          const { appendFile } = await import('node:fs/promises');
          const existing = await markerLines(markerPath);
          if (
            recovery !== 'idempotent' ||
            !existing.some((line) => line.startsWith(`${toolCallId}:`))
          ) {
            await appendFile(
              markerPath,
              recovery === 'idempotent'
                ? `${toolCallId}:sent:${to}\n`
                : `parent:${process.pid}\n`,
            );
          }
        }
        return `sent:${to}`;
      },
    }),
  };
  const model = new MockLanguageModelV4({
    doStream: async ({ prompt }) => {
      const input = lastUserText(prompt);
      track.calls.push(input);
      const callsForInput = track.calls.filter((call) => call === input).length;
      const raw = JSON.stringify(prompt);
      let chunks: LanguageModelV4StreamPart[];
      if (input === 'send it' && callsForInput === 1) {
        chunks = [
          {
            type: 'tool-call',
            toolCallId: 'approval-call',
            toolName: 'sendEmail',
            input: JSON.stringify({ to: 'a@b.c' }),
          },
          {
            type: 'finish',
            finishReason: { unified: 'tool-calls', raw: '' },
            usage,
          },
        ];
      } else {
        const text =
          input === 'send it'
            ? raw.includes('sent:')
              ? 'done:send it'
              : 'denied:send it'
            : `reply:${input}`;
        chunks = textResponse(text);
      }
      return { stream: simulateReadableStream({ chunks }) };
    },
  });
  return {
    name: 'approval-agent',
    model,
    sandbox: async (): Promise<AgentSandbox> =>
      createBashTool({
        sandbox: await createVirtualSandbox({ fs: new InMemoryFs() }),
      }),
    instructions: [],
    tools,
  };
}

function textResponse(text: string): LanguageModelV4StreamPart[] {
  return [
    { type: 'text-start', id: 'text' },
    { type: 'text-delta', id: 'text', delta: text },
    { type: 'text-end', id: 'text' },
    { type: 'finish', finishReason: { unified: 'stop', raw: '' }, usage },
  ];
}

function lastUserText(prompt: unknown): string {
  const messages = prompt as Array<{
    role: string;
    content: Array<{ type: string; text?: string }>;
  }>;
  return (
    messages
      .filter((message) => message.role === 'user')
      .at(-1)
      ?.content.filter((part) => part.type === 'text')
      .map((part) => part.text ?? '')
      .join('') ?? ''
  );
}

async function createHost(
  scenario: Scenario,
  declaration: AgentDeclaration,
): Promise<RuntimeHost> {
  const boss = new PgBoss({
    connectionString: scenario.connectionString,
    monitorIntervalSeconds: 2,
    superviseIntervalSeconds: 2,
  });
  boss.on('error', () => {});
  await boss.start();
  const queue = new PgBossTurnQueue(boss, {
    queue: scenario.queueName,
    heartbeatSeconds: 10,
    pollingIntervalSeconds: 0.5,
  });
  await queue.initialize();
  const store = new PostgresContextStore({ pool: scenario.connectionString });
  const streamStore = new PostgresStreamStore({
    pool: scenario.connectionString,
  });
  await store.initialize();
  await streamStore.initialize();
  const mailboxStore = new SqliteMailboxStore(scenario.mailboxPath);
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

async function pauseForApproval(
  runtime: AgentRuntime,
  conversation: { chatId: string; userId: string },
) {
  const turn = await runtime.enqueue(conversation, {
    id: crypto.randomUUID(),
    input: 'send it',
  });
  await collectText(turn.stream);
  const messages = await runtime.observe(conversation).engine.getMessages();
  const part = approvalPart(messages);
  assert.ok(part);
  assert.equal(part.state, 'approval-requested');
  return part;
}

function approvalPart(messages: UIMessage[]) {
  for (const message of messages) {
    const part = message.parts.find(isToolUIPart);
    if (part) return part;
  }
  return undefined;
}

function messageText(message: UIMessage | undefined): string {
  return (
    message?.parts
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('') ?? ''
  );
}

async function collectText(stream: ReadableStream): Promise<string> {
  let text = '';
  for await (const chunk of stream as ReadableStream<{
    type: string;
    delta?: string;
  }>) {
    if (chunk.type === 'text-delta') text += chunk.delta ?? '';
  }
  return text;
}

async function waitForConversation(
  runtime: AgentRuntime,
  conversation: { chatId: string; userId: string },
  predicate: (messages: UIMessage[]) => boolean,
  label: string,
  timeoutMs = 15_000,
): Promise<UIMessage[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const messages = await runtime.observe(conversation).engine.getMessages();
    if (predicate(messages)) return messages;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function withScenario(
  run: (scenario: Scenario) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'zukhruf-approval-dispatch-'));
  try {
    const result = await withPostgresContainer(async (container) => {
      await run({
        connectionString: container.connectionString,
        queueName: `approval-${crypto.randomUUID()}`,
        mailboxPath: join(directory, 'mailbox.sqlite'),
        markerPath: join(directory, 'tool-runs'),
      });
      return true;
    });
    assert.equal(
      result,
      true,
      'PostgreSQL integration environment unavailable',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function startDecisionProcess(
  scenario: Scenario,
  conversation: { chatId: string; userId: string },
  decision: 'approve' | 'deny',
): Promise<FixtureProcess> {
  const handle = startFixture([
    'decision',
    scenario.connectionString,
    scenario.queueName,
    scenario.mailboxPath,
    JSON.stringify(conversation),
    decision,
    'approval-call',
  ]);
  await waitForFixtureMessage(handle, 'ready');
  return handle;
}

async function startCrashWorker(
  scenario: Scenario,
  recovery?: 'idempotent',
): Promise<FixtureProcess> {
  const handle = startFixture([
    'crash-worker',
    scenario.connectionString,
    scenario.queueName,
    scenario.mailboxPath,
    scenario.markerPath,
    ...(recovery ? [recovery] : []),
  ]);
  await waitForFixtureMessage(handle, 'ready');
  return handle;
}

function startFixture(args: string[]): FixtureProcess {
  const child = fork(fixture, args, {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  const stderr: string[] = [];
  child.stderr?.on('data', (chunk) => stderr.push(String(chunk)));
  return { child, stderr };
}

async function runDecision(handle: FixtureProcess): Promise<DecisionResult> {
  const result = waitForFixtureMessage(handle, 'result');
  handle.child.send({ type: 'start' });
  const message = await result;
  assert.ok(isDecisionResult(message));
  return message;
}

function waitForFixtureMessage(
  handle: FixtureProcess,
  type: string,
  timeoutMs = 15_000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => finish(new Error(`timed out waiting for child message ${type}`)),
      timeoutMs,
    );
    const onMessage = (message: unknown) => {
      if (isRecord(message) && message.type === type)
        finish(undefined, message);
    };
    const onError = (error: Error) => finish(error);
    const onExit = (code: number | null, signal: NodeJS.Signals | null) =>
      finish(
        new Error(
          `fixture exited before ${type}: code=${code} signal=${signal}\n${handle.stderr.join('')}`,
        ),
      );
    const finish = (error?: Error, message?: Record<string, unknown>): void => {
      clearTimeout(timer);
      handle.child.off('message', onMessage);
      handle.child.off('error', onError);
      handle.child.off('exit', onExit);
      if (error) reject(error);
      else if (message) resolve(message);
      else reject(new Error(`fixture returned no ${type} message`));
    };
    handle.child.on('message', onMessage);
    handle.child.on('error', onError);
    handle.child.on('exit', onExit);
  });
}

async function stopFixtureProcess(handle: FixtureProcess): Promise<void> {
  if (handle.child.exitCode !== null || handle.child.signalCode !== null)
    return;
  handle.child.kill('SIGTERM');
  await waitForExit(handle.child);
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await once(child, 'exit');
}

async function markerLines(path: string): Promise<string[]> {
  try {
    return (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean);
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return [];
    throw error;
  }
}

function isDecisionResult(value: unknown): value is DecisionResult {
  return (
    isRecord(value) &&
    value.type === 'result' &&
    (value.decision === 'approve' || value.decision === 'deny') &&
    (value.status === 'fulfilled' || value.status === 'rejected')
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
