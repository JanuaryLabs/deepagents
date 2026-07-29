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
import { mkdtempDisposable, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { Client } from 'pg';
import { PgBoss } from 'pg-boss';
import { z } from 'zod';

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
  defineTool,
} from '@deepagents/experimental/zukhruf';
import { withPostgresContainer } from '@deepagents/test';

const fixture = new URL('./approval-dispatch.fixture.ts', import.meta.url);
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
  approvalJobs(chatId: string): Promise<Array<{ id: string; state: string }>>;
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
  jobId?: string;
  approvalStatus?: 'queued' | 'already-queued' | 'already-applied';
  error?: string;
}

test(
  'concurrent approve and deny from independent processes create one queued approval job and apply one winner',
  { timeout: 45_000 },
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
        await worker[Symbol.asyncDispose]();
        worker = undefined;

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
        assert.deepEqual(
          results.map((result) => result.status),
          ['fulfilled', 'fulfilled'],
        );
        assert.deepEqual(
          results.map((result) => result.approvalStatus).toSorted(),
          ['already-queued', 'queued'],
        );
        assert.equal(results[0]?.jobId, results[1]?.jobId);
        const jobs = await host.approvalJobs(conversation.chatId);
        assert.equal(jobs.length, 1);
        assert.equal(jobs[0]?.id, results[0]?.jobId);
        assert.equal(jobs[0]?.state, 'created');
        assert.equal(
          approvalPart(
            await host.runtime.observe(conversation).engine.getMessages(),
          )?.state,
          'approval-requested',
        );

        worker = await host.runtime.work();
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
        const state = approvalPart(messages)?.state;
        assert.ok(state === 'output-available' || state === 'output-denied');
        assert.equal(track.toolRuns, state === 'output-available' ? 1 : 0);
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
  'duplicate approvals from independent processes create one queued approval job and execute once',
  { timeout: 45_000 },
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
        await worker[Symbol.asyncDispose]();
        worker = undefined;

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
        assert.deepEqual(
          results.map((result) => result.approvalStatus).toSorted(),
          ['already-queued', 'queued'],
        );
        assert.equal(results[0]?.jobId, results[1]?.jobId);
        const jobs = await host.approvalJobs(conversation.chatId);
        assert.equal(jobs.length, 1);
        assert.equal(jobs[0]?.id, results[0]?.jobId);
        assert.equal(
          approvalPart(
            await host.runtime.observe(conversation).engine.getMessages(),
          )?.state,
          'approval-requested',
        );

        worker = await host.runtime.work();
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
  'an approval stays queued and pending without a worker, then outranks later turns after restart',
  { timeout: 45_000 },
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
        const queued = await firstHost.runtime.approve(conversation, {
          toolCallId: part.toolCallId,
        });
        assert.equal(queued.status, 'queued');
        assert.deepEqual(track.calls, ['send it']);
        assert.equal(track.toolRuns, 0, 'nothing executes without a worker');
        assert.equal(
          approvalPart(
            await firstHost.runtime.observe(conversation).engine.getMessages(),
          )?.state,
          'approval-requested',
        );
        assert.equal(
          (await firstHost.approvalJobs(conversation.chatId)).length,
          1,
        );

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
          30_000,
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
  'retry after the approval job is deleted uses settled context and creates no new job',
  { timeout: 45_000 },
  async () => {
    await withScenario(async (scenario) => {
      const track = { calls: [], toolRuns: 0 } satisfies ApprovalTrack;
      const host = await createHost(scenario, approvalDeclaration(track));
      let worker: AsyncDisposable | undefined;
      try {
        worker = await host.runtime.work();
        const conversation = {
          chatId: `approval-retry-${crypto.randomUUID()}`,
          userId: 'user-1',
        };
        const part = await pauseForApproval(host.runtime, conversation);
        await worker[Symbol.asyncDispose]();
        worker = undefined;

        const queued = await host.runtime.approve(conversation, {
          toolCallId: part.toolCallId,
        });
        assert.equal(queued.status, 'queued');
        assert.equal((await host.approvalJobs(conversation.chatId)).length, 1);

        worker = await host.runtime.work();
        const settled = await waitForConversation(
          host.runtime,
          conversation,
          (messages) =>
            track.calls.length === 2 &&
            approvalPart(messages)?.state === 'output-available',
          'the queued approval to settle',
        );
        await waitForApprovalJobCount(host, conversation.chatId, 0);

        const applied = await host.runtime.approve(conversation, {
          toolCallId: part.toolCallId,
        });

        assert.equal(applied.status, 'already-applied');
        assert.equal(applied.jobId, queued.jobId);
        assert.equal((await host.approvalJobs(conversation.chatId)).length, 0);
        assert.deepEqual(
          await host.runtime.observe(conversation).engine.getMessages(),
          settled,
        );
        assert.equal(track.toolRuns, 1);
        assert.deepEqual(track.calls, ['send it', 'send it']);
      } finally {
        await worker?.[Symbol.asyncDispose]();
        await host.close();
      }
    });
  },
);

test(
  'sibling approvals create distinct jobs and the final sibling resumes the original turn once',
  { timeout: 45_000 },
  async () => {
    await withScenario(async (scenario) => {
      const track = { calls: [], toolRuns: 0 } satisfies ApprovalTrack;
      const host = await createHost(scenario, approvalDeclaration(track));
      let worker: AsyncDisposable | undefined;
      try {
        worker = await host.runtime.work();
        const conversation = {
          chatId: `sibling-approvals-${crypto.randomUUID()}`,
          userId: 'user-1',
        };
        const parts = await pauseForApprovals(
          host.runtime,
          conversation,
          'send both',
        );
        assert.equal(parts.length, 2);
        await worker[Symbol.asyncDispose]();
        worker = undefined;

        const first = await host.runtime.approve(conversation, {
          toolCallId: parts[0]!.toolCallId,
        });
        const second = await host.runtime.approve(conversation, {
          toolCallId: parts[1]!.toolCallId,
        });
        assert.equal(first.status, 'queued');
        assert.equal(second.status, 'queued');
        assert.notEqual(first.jobId, second.jobId);

        const jobs = await host.approvalJobs(conversation.chatId);
        assert.equal(jobs.length, 2);
        assert.equal(new Set(jobs.map((job) => job.id)).size, 2);
        assert.deepEqual(
          approvalParts(
            await host.runtime.observe(conversation).engine.getMessages(),
          ).map((part) => part.state),
          ['approval-requested', 'approval-requested'],
        );

        worker = await host.runtime.work();
        const messages = await waitForConversation(
          host.runtime,
          conversation,
          (current) =>
            track.calls.length === 2 &&
            approvalParts(current).every(
              (part) => part.state === 'output-available',
            ),
          'both sibling approvals to settle',
        );

        assert.equal(track.toolRuns, 2);
        assert.deepEqual(track.calls, ['send both', 'send both']);
        assert.equal(
          messages.filter((message) => message.role === 'assistant').length,
          1,
        );
      } finally {
        await worker?.[Symbol.asyncDispose]();
        await host.close();
      }
    });
  },
);

test(
  'a worker killed after an approved tool starts does not duplicate the tool or strand later turns',
  { timeout: 60_000 },
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
  'an approval claimed before its decision is persisted survives worker death',
  { timeout: 60_000 },
  async () => {
    await withScenario(async (scenario) => {
      const track = { calls: [], toolRuns: 0 } satisfies ApprovalTrack;
      const declaration = approvalDeclaration(track);
      let firstHost: RuntimeHost | undefined;
      let recoveryHost: RuntimeHost | undefined;
      let firstWorker: AsyncDisposable | undefined;
      let recoveryWorker: AsyncDisposable | undefined;
      let crashedWorker: FixtureProcess | undefined;
      let messageLock: Client | undefined;
      try {
        firstHost = await createHost(scenario, declaration);
        firstWorker = await firstHost.runtime.work();
        const conversation = {
          chatId: `approval-pre-persist-crash-${crypto.randomUUID()}`,
          userId: 'user-1',
        };
        const part = await pauseForApproval(firstHost.runtime, conversation);
        const paused = (
          await firstHost.runtime.observe(conversation).engine.getMessages()
        ).at(-1);
        assert.ok(paused);
        await firstWorker[Symbol.asyncDispose]();
        firstWorker = undefined;

        crashedWorker = await startCrashWorker(scenario);
        messageLock = new Client({
          connectionString: scenario.connectionString,
        });
        await messageLock.connect();
        await messageLock.query('BEGIN');
        const locked = await messageLock.query(
          'SELECT id FROM "public"."messages" WHERE id = $1 FOR UPDATE',
          [paused.id],
        );
        assert.equal(locked.rowCount, 1);

        const queued = await firstHost.runtime.approve(conversation, {
          toolCallId: part.toolCallId,
        });
        assert.equal(queued.status, 'queued');
        await waitForApprovalJobState(firstHost, conversation.chatId, 'active');
        crashedWorker.child.kill('SIGKILL');
        await waitForExit(crashedWorker.child);
        await messageLock.query('ROLLBACK');
        await messageLock.end();
        messageLock = undefined;

        assert.equal(
          approvalPart(
            await firstHost.runtime.observe(conversation).engine.getMessages(),
          )?.state,
          'approval-requested',
          'the killed worker did not persist the decision',
        );
        assert.equal(track.toolRuns, 0);

        await firstHost.close();
        firstHost = undefined;
        recoveryHost = await createHost(scenario, declaration);
        recoveryWorker = await recoveryHost.runtime.work();

        const messages = await waitForConversation(
          recoveryHost.runtime,
          conversation,
          (current) =>
            track.calls.length === 2 &&
            approvalPart(current)?.state === 'output-available',
          'the claimed approval to recover without another caller retry',
          45_000,
        );
        assert.equal(approvalPart(messages)?.state, 'output-available');
        assert.equal(track.toolRuns, 1);
        assert.deepEqual(track.calls, ['send it', 'send it']);
      } finally {
        if (messageLock) {
          await messageLock.query('ROLLBACK');
          await messageLock.end();
        }
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
  { timeout: 60_000 },
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
  { timeout: 90_000 },
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
      if (
        (input === 'send it' || input === 'send both') &&
        callsForInput === 1
      ) {
        const toolCalls: LanguageModelV4StreamPart[] =
          input === 'send both'
            ? [
                {
                  type: 'tool-call',
                  toolCallId: 'approval-call-a',
                  toolName: 'sendEmail',
                  input: JSON.stringify({ to: 'a@b.c' }),
                },
                {
                  type: 'tool-call',
                  toolCallId: 'approval-call-b',
                  toolName: 'sendEmail',
                  input: JSON.stringify({ to: 'b@c.d' }),
                },
              ]
            : [
                {
                  type: 'tool-call',
                  toolCallId: 'approval-call',
                  toolName: 'sendEmail',
                  input: JSON.stringify({ to: 'a@b.c' }),
                },
              ];
        chunks = [
          ...toolCalls,
          {
            type: 'finish',
            finishReason: { unified: 'tool-calls', raw: '' },
            usage,
          },
        ];
      } else {
        const text =
          input === 'send it' || input === 'send both'
            ? raw.includes('sent:')
              ? `done:${input}`
              : `denied:${input}`
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
  const streams = new StreamManager({
    store: streamStore,
    changeSource: new PollingChangeSource({ reads: streamStore }),
  });
  return {
    runtime: new AgentRuntime(declaration, {
      store,
      streams,
      queue,
      mailboxStore,
    }),
    async approvalJobs(chatId) {
      const jobs = await boss.findJobs<{ kind?: string }>(queue.queue, {
        key: chatId,
      });
      return jobs
        .filter((job) => job.data.kind === 'approval')
        .map((job) => ({ id: job.id, state: job.state }));
    },
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
  const parts = await pauseForApprovals(runtime, conversation, 'send it');
  assert.equal(parts.length, 1);
  return parts[0]!;
}

async function pauseForApprovals(
  runtime: AgentRuntime,
  conversation: { chatId: string; userId: string },
  input: string,
) {
  const turn = await runtime.enqueue(conversation, {
    id: crypto.randomUUID(),
    input,
  });
  await collectText(turn.stream);
  const messages = await runtime.observe(conversation).engine.getMessages();
  const parts = approvalParts(messages);
  assert.ok(parts.length > 0);
  assert.ok(parts.every((part) => part.state === 'approval-requested'));
  return parts;
}

function approvalPart(messages: UIMessage[]) {
  return approvalParts(messages)[0];
}

function approvalParts(messages: UIMessage[]) {
  return messages.flatMap((message) => message.parts.filter(isToolUIPart));
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
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const messages = await runtime.observe(conversation).engine.getMessages();
    if (predicate(messages)) return messages;
    await sleep(25);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function waitForApprovalJobCount(
  host: RuntimeHost,
  chatId: string,
  count: number,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if ((await host.approvalJobs(chatId)).length === count) return;
    await sleep(25);
  }
  throw new Error(`timed out waiting for ${count} approval jobs`);
}

async function waitForApprovalJobState(
  host: RuntimeHost,
  chatId: string,
  state: string,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const jobs = await host.approvalJobs(chatId);
    if (jobs.some((job) => job.state === state)) return;
    await sleep(25);
  }
  throw new Error(`timed out waiting for an approval job in ${state}`);
}

async function withScenario(
  run: (scenario: Scenario) => Promise<void>,
): Promise<void> {
  await using directory = await mkdtempDisposable(
    join(tmpdir(), 'zukhruf-approval-dispatch-'),
  );
  const result = await withPostgresContainer(async (container) => {
    await run({
      connectionString: container.connectionString,
      queueName: `approval-${crypto.randomUUID()}`,
      mailboxPath: join(directory.path, 'mailbox.sqlite'),
      markerPath: join(directory.path, 'tool-runs'),
    });
    return true;
  });
  assert.equal(result, true, 'PostgreSQL integration environment unavailable');
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

async function waitForFixtureMessage(
  handle: FixtureProcess,
  type: string,
  timeoutMs = 15_000,
): Promise<Record<string, unknown>> {
  const result = Promise.withResolvers<Record<string, unknown>>();
  using _timeout = setTimeout(
    () =>
      result.reject(new Error(`timed out waiting for child message ${type}`)),
    timeoutMs,
  );
  const onMessage = (message: unknown) => {
    if (isRecord(message) && message.type === type) result.resolve(message);
  };
  const onError = (error: Error) => result.reject(error);
  const onExit = (code: number | null, signal: NodeJS.Signals | null) =>
    result.reject(
      new Error(
        `fixture exited before ${type}: code=${code} signal=${signal}\n${handle.stderr.join('')}`,
      ),
    );
  handle.child.on('message', onMessage);
  handle.child.on('error', onError);
  handle.child.on('exit', onExit);
  try {
    return await result.promise;
  } finally {
    handle.child.off('message', onMessage);
    handle.child.off('error', onError);
    handle.child.off('exit', onExit);
  }
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
