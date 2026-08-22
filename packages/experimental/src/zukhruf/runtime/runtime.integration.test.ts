import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { PGlite } from '@electric-sql/pglite';
import {
  type ToolSet,
  type UIMessage,
  type UIMessageChunk,
  isTextUIPart,
  isToolUIPart,
  readUIMessageStream,
  simulateReadableStream,
} from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { InMemoryFs } from 'just-bash';
import assert from 'node:assert/strict';
import { mkdir, mkdtempDisposable, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { PgBoss, fromPglite } from 'pg-boss';
import { z } from 'zod';

import {
  type AgentSandbox,
  type DisposableSandbox,
  InMemoryContextStore,
  PollingChangeSource,
  SqliteStreamStore,
  StreamManager,
  createBashTool,
  createVirtualSandbox,
  fragment,
  once,
  reminder,
} from '@deepagents/context';
import {
  type AgentDeclaration,
  AgentRuntime,
  type AgentRuntimeOptions,
  AgentThread,
  PgBossTurnQueue,
  SqliteMailboxStore,
  type TurnRef,
  defineAgent,
  defineSandbox,
  defineTool,
} from '@deepagents/experimental/zukhruf';
import {
  type Schedules,
  scheduleFiles,
  schedules,
} from '@deepagents/experimental/zukhruf/schedules';
import { settleWithin, timebox } from '@deepagents/test';

const usage = {
  inputTokens: {
    total: 1,
    noCache: 1,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 2, text: 2, reasoning: undefined },
} as const;

const turn = (input: string) => ({ id: `ask:${crypto.randomUUID()}`, input });

interface ModelTrack {
  active: number;
  maxActive: number;
  calls: string[];
}

function lastUserText(prompt: unknown): string {
  const messages = prompt as Array<{
    role: string;
    content: Array<{ type: string; text?: string }>;
  }>;
  const lastUser = messages.filter((m) => m.role === 'user').at(-1);
  return (
    lastUser?.content
      .filter((part) => part.type === 'text')
      .map((part) => part.text ?? '')
      .join('') ?? ''
  );
}

/**
 * Replies `reply:<user text>`; throws when the user text contains "boom".
 * Keyed on prompt content (not call index) so AI SDK retries can't skew it.
 * `gate` couples two calls: a "gate-wait" turn holds its stream open until a
 * "gate-open" turn starts (or a 5s fallback), proving cross-chat overlap.
 */
function scriptedModel(
  track: ModelTrack,
  options?: { chunkDelayInMs?: number; gate?: PromiseWithResolvers<void> },
) {
  return new MockLanguageModelV4({
    doStream: async ({ prompt }) => {
      const text = lastUserText(prompt);
      track.calls.push(text);
      if (text.includes('boom')) throw new Error('model crashed');
      track.active++;
      track.maxActive = Math.max(track.maxActive, track.active);
      if (text.includes('gate-open')) options?.gate?.resolve();

      const deltas = text.includes('gate-wait')
        ? [awaitGate(options?.gate), `reply:${text}`]
        : [`reply:${text}`];

      return {
        stream: buildStream(deltas, options?.chunkDelayInMs ?? 0).pipeThrough(
          new TransformStream({
            flush: () => {
              track.active--;
            },
          }),
        ),
      };
    },
  });
}

function awaitGate(gate?: PromiseWithResolvers<void>): Promise<string> {
  const opened = gate?.promise.then(() => 'opened ') ?? Promise.resolve('');
  return Promise.race([opened, sleep(5000).then(() => 'gate-timeout ')]);
}

function buildStream(
  deltas: Array<string | Promise<string>>,
  chunkDelayInMs: number,
) {
  return new ReadableStream({
    async start(controller) {
      controller.enqueue({ type: 'text-start', id: 't1' });
      for (const delta of deltas) {
        if (chunkDelayInMs) await sleep(chunkDelayInMs);
        controller.enqueue({
          type: 'text-delta',
          id: 't1',
          delta: await delta,
        });
      }
      controller.enqueue({ type: 'text-end', id: 't1' });
      controller.enqueue({
        type: 'finish',
        finishReason: { unified: 'stop', raw: '' },
        usage,
      });
      controller.close();
    },
  });
}

function slowModel(track: ModelTrack) {
  return new MockLanguageModelV4({
    doStream: async ({ prompt }) => {
      track.calls.push(lastUserText(prompt));
      return {
        stream: simulateReadableStream({
          initialDelayInMs: 20,
          chunkDelayInMs: 40,
          chunks: [
            { type: 'text-start', id: 't1' },
            ...Array.from({ length: 40 }, (_, i) => ({
              type: 'text-delta' as const,
              id: 't1',
              delta: `n${i} `,
            })),
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

interface ApprovalTrack extends ModelTrack {
  toolRuns: number;
}

function approvalSetup() {
  const track: ApprovalTrack = {
    active: 0,
    maxActive: 0,
    calls: [],
    toolRuns: 0,
  };
  const tools: ToolSet = {
    sendEmail: defineTool({
      description: 'Send an email',
      inputSchema: z.object({ to: z.string() }),
      needsApproval: true,
      execute: async ({ to }) => {
        track.toolRuns++;
        return `sent:${to}`;
      },
    }),
  };
  /**
   * Asks containing "send" emit an approval-requiring tool call on their
   * FIRST model call; the continuation (second call for the same ask) replies
   * based on whether the tool result is visible (approved) or not (denied).
   * Other asks reply plainly. Keyed on prompt content, retry-proof.
   */
  const model = new MockLanguageModelV4({
    doStream: async ({ prompt }) => {
      const text = lastUserText(prompt);
      track.calls.push(text);
      const raw = JSON.stringify(prompt);
      const priorCallsForAsk = track.calls.filter((c) => c === text).length;

      let chunks: LanguageModelV4StreamPart[];
      if (!text.includes('send') || priorCallsForAsk === 1) {
        chunks = text.includes('send')
          ? [
              { type: 'text-start', id: 't1' },
              { type: 'text-delta', id: 't1', delta: 'working ' },
              { type: 'text-end', id: 't1' },
              {
                type: 'tool-call',
                toolCallId: `tc-${text.replaceAll(' ', '_')}`,
                toolName: 'sendEmail',
                input: JSON.stringify({ to: 'a@b.c' }),
              },
              {
                type: 'finish',
                finishReason: { unified: 'tool-calls', raw: '' },
                usage,
              },
            ]
          : [
              { type: 'text-start', id: 't1' },
              { type: 'text-delta', id: 't1', delta: `reply:${text}` },
              { type: 'text-end', id: 't1' },
              {
                type: 'finish',
                finishReason: { unified: 'stop', raw: '' },
                usage,
              },
            ];
      } else {
        const outcome = raw.includes('sent:')
          ? `done:${text}`
          : `denied:${text}`;
        chunks = [
          { type: 'text-start', id: 't1' },
          { type: 'text-delta', id: 't1', delta: outcome },
          { type: 'text-end', id: 't1' },
          { type: 'finish', finishReason: { unified: 'stop', raw: '' }, usage },
        ];
      }
      return {
        stream: simulateReadableStream({ chunks }),
      };
    },
  });
  return { track, tools, model };
}

function siblingApprovalSetup() {
  const track: ApprovalTrack = {
    active: 0,
    maxActive: 0,
    calls: [],
    toolRuns: 0,
  };
  const tools: ToolSet = {
    sendEmail: defineTool({
      description: 'Send an email',
      inputSchema: z.object({ to: z.string() }),
      needsApproval: true,
      execute: async ({ to }) => {
        track.toolRuns++;
        return `sent:${to}`;
      },
    }),
  };
  const model = new MockLanguageModelV4({
    doStream: async () => {
      track.calls.push('request');
      const chunks: LanguageModelV4StreamPart[] =
        track.calls.length === 1
          ? [
              {
                type: 'tool-call',
                toolCallId: 'first-email',
                toolName: 'sendEmail',
                input: JSON.stringify({ to: 'first@example.com' }),
              },
              {
                type: 'tool-call',
                toolCallId: 'second-email',
                toolName: 'sendEmail',
                input: JSON.stringify({ to: 'second@example.com' }),
              },
              {
                type: 'finish',
                finishReason: { unified: 'tool-calls', raw: '' },
                usage,
              },
            ]
          : [
              { type: 'text-start', id: 't1' },
              { type: 'text-delta', id: 't1', delta: 'both approved' },
              { type: 'text-end', id: 't1' },
              {
                type: 'finish',
                finishReason: { unified: 'stop', raw: '' },
                usage,
              },
            ];
      return { stream: simulateReadableStream({ chunks }) };
    },
  });
  return { track, tools, model };
}

async function pausedToolCall(
  runtime: {
    observe: (c: { chatId: string; userId: string }) => {
      engine: { getMessages(): Promise<UIMessage[]> };
    };
  },
  conversation: { chatId: string; userId: string },
) {
  const head = (await runtime.observe(conversation).engine.getMessages()).at(
    -1,
  );
  assert.ok(head, 'chain has a head message');
  const part = head.parts.find(isToolUIPart);
  assert.ok(part, 'head has a tool part');
  return { head, part };
}

function declaration(
  model: AgentDeclaration['model'],
  tools?: ToolSet,
): AgentDeclaration {
  return {
    name: 'test-agent',
    model,
    sandbox: async (): Promise<AgentSandbox> =>
      createBashTool({
        sandbox: await createVirtualSandbox({ fs: new InMemoryFs() }),
      }),
    instructions: [],
    tools,
  };
}

class FailOnceResumeParkedQueue extends PgBossTurnQueue {
  #shouldFail = true;

  override async resumeParked(chatId: string): Promise<void> {
    if (this.#shouldFail) {
      this.#shouldFail = false;
      throw new Error('simulated parked-turn revival outage');
    }
    await super.resumeParked(chatId);
  }
}

async function harness(
  model: AgentDeclaration['model'],
  tools?: ToolSet,
  options?: {
    queueFactory?: (boss: PgBoss) => PgBossTurnQueue;
    declaration?: AgentDeclaration;
    plugins?: (infrastructure: {
      boss: PgBoss;
      database: PGlite;
    }) => AgentRuntimeOptions['plugins'];
  },
) {
  const pglite = new PGlite();
  const boss = new PgBoss({
    db: fromPglite(pglite),
    backend: 'pglite',
    maintenanceIntervalSeconds: 1,
  });
  boss.on('error', () => {});
  await boss.start();
  const queue =
    options?.queueFactory?.(boss) ??
    new PgBossTurnQueue(boss, {
      pollingIntervalSeconds: 0.5,
      schema: 'pgboss',
    });
  await queue.initialize();
  const streamStore = new SqliteStreamStore(':memory:');
  const streams = new StreamManager({
    store: streamStore,
    changeSource: new PollingChangeSource({ reads: streamStore }),
  });
  const mailboxStore = new SqliteMailboxStore(':memory:');
  const runtime = new AgentRuntime(
    options?.declaration ?? declaration(model, tools),
    {
      store: new InMemoryContextStore(),
      streams,
      queue,
      mailboxStore,
      ...(options?.plugins
        ? { plugins: options.plugins({ boss, database: pglite }) }
        : {}),
    },
  );
  return {
    runtime,
    database: pglite,
    streamStore,
    boss,
    queue,
    async [Symbol.asyncDispose]() {
      await boss.stop({ graceful: false });
      await pglite.close();
      streamStore.close();
      mailboxStore.close();
    },
  };
}

async function collectText(stream: ReadableStream<UIMessageChunk>) {
  let message: UIMessage | undefined;
  for await (const streamedMessage of readUIMessageStream({ stream })) {
    message = streamedMessage;
  }
  return messageText(message);
}

async function waitForStatus(
  streamStore: SqliteStreamStore,
  id: string,
  accept: string[],
  timeoutMs = 10_000,
) {
  return timebox(
    async () => {
      const status = await streamStore.getStreamStatus(id);
      if (status && accept.includes(status)) return status;
      throw new Error(`timed out waiting for ${accept.join('/')} on ${id}`);
    },
    { maxRetryTime: timeoutMs, minTimeout: 25 },
  );
}

function messageText(message: UIMessage | undefined): string {
  return (
    message?.parts
      .filter(isTextUIPart)
      .map((part) => part.text)
      .join('') ?? ''
  );
}

async function waitForConversation(
  runtime: AgentRuntime,
  conversation: { chatId: string; userId: string },
  predicate: (messages: UIMessage[]) => boolean,
  label: string,
  timeoutMs = 10_000,
): Promise<UIMessage[]> {
  return timebox(
    async () => {
      const messages = await runtime.observe(conversation).engine.getMessages();
      if (predicate(messages)) return messages;
      throw new Error(`timed out waiting for ${label}`);
    },
    { maxRetryTime: timeoutMs, minTimeout: 25 },
  );
}

async function waitForText(
  runtime: AgentRuntime,
  conversation: { chatId: string; userId: string },
  expected: string,
): Promise<void> {
  await waitForConversation(
    runtime,
    conversation,
    (messages) =>
      messages.some((message) => messageText(message).includes(expected)),
    `"${expected}"`,
  );
}

describe('zukhruf runtime — host sessions', () => {
  it('creates, describes, resumes, and cancels a session before a worker starts', async () => {
    const track: ModelTrack = { active: 0, maxActive: 0, calls: [] };
    const model = scriptedModel(track);
    await using h = await harness(model);
    const conversation = { chatId: 'http-session', userId: 'user-1' };

    assert.equal(await h.runtime.sessionExists(conversation), false);
    await h.runtime.createSession(conversation);
    assert.equal(await h.runtime.sessionExists(conversation), true);
    assert.equal(
      await h.runtime.sessionExists({ ...conversation, userId: 'user-2' }),
      false,
    );
    assert.deepEqual(h.runtime.info, {
      root: 'test-agent',
      agents: [
        {
          name: 'test-agent',
          model: { provider: model.provider, modelId: model.modelId },
          tools: [],
          subagents: [],
        },
      ],
    });

    const pending = await h.runtime.enqueue(conversation, {
      id: 'message-1',
      input: 'hello',
    });
    assert.deepEqual(await h.runtime.observe(conversation).status(pending.id), {
      status: 'queued',
      startedAt: null,
      finishedAt: null,
      error: null,
    });
    assert.ok(await h.runtime.observe(conversation).resume());
    await h.runtime.observe(conversation).cancel();
    assert.equal(await h.streamStore.getStreamStatus(pending.id), 'cancelled');
    assert.equal(
      (await h.runtime.observe(conversation).status(pending.id))?.status,
      'cancelled',
    );
  });

  it('runs scheduled prompts in fresh, idempotent root sessions', async () => {
    const track: ModelTrack = { active: 0, maxActive: 0, calls: [] };
    let scheduled: Schedules | undefined;
    await using h = await harness(slowModel(track), undefined, {
      plugins: ({ boss, database }) => {
        scheduled = schedules({
          boss,
          queue: `scheduled-runtime-${crypto.randomUUID()}`,
          reconciliationIntervalMs: 50,
          transaction: (operation) =>
            database.transaction((transaction) =>
              operation(fromPglite(transaction)),
            ),
          workerOptions: { pollingIntervalSeconds: 0.5 },
        });
        return [scheduled];
      },
    });
    assert.ok(scheduled);
    const scheduleControl = scheduled;
    await Promise.all([h.runtime.initialize(), h.runtime.initialize()]);
    const cancelledTask = await scheduleControl.create('user-1', {
      idempotencyKey: 'cancelled-task',
      name: 'Cancelled task',
      prompt: 'do not run',
      recurrence: '0 9 * * 1',
      timezone: 'Asia/Amman',
      executionConfig: {},
    });
    const completedTask = await scheduleControl.create('user-1', {
      idempotencyKey: 'completed-task',
      name: 'Completed task',
      prompt: 'prepare the report',
      recurrence: '0 9 * * 1',
      timezone: 'Asia/Amman',
      executionConfig: {},
    });
    await using _worker = await h.runtime.work();

    const cancelled = await scheduleControl.runNow(
      'user-1',
      cancelledTask.id,
      'cancelled-run',
    );
    await timebox(
      async () => {
        assert.equal(
          (await scheduleControl.getRun('user-1', cancelled.id)).status,
          'running',
        );
      },
      { maxRetryTime: 10_000, minTimeout: 25 },
    );
    assert.deepEqual(
      await scheduleControl.cancelRun('user-1', cancelled.id),
      await scheduleControl.cancelRun('user-1', cancelled.id),
    );
    assert.equal(
      (await scheduleControl.getRun('user-1', cancelled.id)).status,
      'cancelled',
    );

    const launched = await scheduleControl.runNow(
      'user-1',
      completedTask.id,
      'completed-run',
    );
    assert.deepEqual(
      await scheduleControl.runNow('user-1', completedTask.id, 'completed-run'),
      launched,
    );
    const completed = await timebox(
      async () => {
        const execution = await scheduleControl.getRun('user-1', launched.id);
        if (execution.status !== 'completed') {
          throw new Error(`scheduled execution is ${execution.status}`);
        }
        return execution;
      },
      { maxRetryTime: 10_000, minTimeout: 25 },
    );
    assert.equal(completed.error, null);
    assert.equal(
      await h.runtime.sessionExists({
        chatId: launched.id,
        userId: 'user-1',
      }),
      true,
    );
  });

  it('fails a scheduled task that requires interactive approval', async () => {
    const { track, tools, model } = approvalSetup();
    let scheduled: Schedules | undefined;
    await using h = await harness(model, tools, {
      plugins: ({ boss, database }) => {
        scheduled = schedules({
          boss,
          queue: `scheduled-approval-${crypto.randomUUID()}`,
          reconciliationIntervalMs: 50,
          transaction: (operation) =>
            database.transaction((transaction) =>
              operation(fromPglite(transaction)),
            ),
          workerOptions: { pollingIntervalSeconds: 0.5 },
        });
        return [scheduled];
      },
    });
    assert.ok(scheduled);
    const scheduleControl = scheduled;
    await h.runtime.initialize();
    const task = await scheduleControl.create('user-1', {
      idempotencyKey: 'approval-task',
      name: 'Approval task',
      prompt: 'send it',
      recurrence: '0 9 * * 1',
      timezone: 'Asia/Amman',
      executionConfig: {},
    });
    await using _worker = await h.runtime.work();
    const launched = await scheduleControl.runNow(
      'user-1',
      task.id,
      'approval-run',
    );
    await waitForConversation(
      h.runtime,
      { chatId: launched.id, userId: 'user-1' },
      (messages) =>
        messages
          .at(-1)
          ?.parts.some(
            (part) => isToolUIPart(part) && part.state === 'approval-requested',
          ) ?? false,
      'scheduled approval pause',
    );

    const failed = await timebox(
      async () => {
        const run = await scheduleControl.getRun('user-1', launched.id);
        if (run.status !== 'failed') {
          throw new Error(`scheduled execution is ${run.status}`);
        }
        return run;
      },
      { maxRetryTime: 10_000, minTimeout: 25 },
    );
    assert.equal(
      failed.error,
      'Scheduled execution requires interactive tool approval',
    );
    assert.equal(track.toolRuns, 0);
  });

  it('synchronizes a Markdown schedule and runs it as a fresh root task', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'zukhruf-schedules-'),
    );
    const file = join(directory.path, 'monday-report.md');
    await writeFile(
      file,
      `---
name: Monday report
cron: "0 9 * * 1"
timezone: Asia/Amman
---
Prepare the engineering report.
`,
    );
    const track: ModelTrack = { active: 0, maxActive: 0, calls: [] };
    const source = scheduleFiles({
      directory: directory.path,
      ownerId: 'user-1',
    });
    let scheduled: Schedules | undefined;
    await using h = await harness(scriptedModel(track), undefined, {
      plugins: ({ boss, database }) => {
        scheduled = schedules({
          boss,
          queue: `scheduled-files-${crypto.randomUUID()}`,
          reconciliationIntervalMs: 50,
          transaction: (operation) =>
            database.transaction((transaction) =>
              operation(fromPglite(transaction)),
            ),
          workerOptions: { pollingIntervalSeconds: 0.5 },
          sources: [source],
        });
        return [scheduled];
      },
    });
    assert.ok(scheduled);
    const scheduleControl = scheduled;
    await h.runtime.initialize();
    const [task] = await scheduleControl.list('user-1');
    assert.equal(task.name, 'Monday report');
    assert.equal(task.recurrence, '0 9 * * 1');

    await using _worker = await h.runtime.work();
    const run = await scheduleControl.runNow('user-1', task.id, 'first-run');
    await timebox(
      async () => {
        assert.equal(
          (await scheduleControl.getRun('user-1', run.id)).status,
          'completed',
        );
      },
      { maxRetryTime: 10_000, minTimeout: 25 },
    );
    assert.deepEqual(track.calls, ['Prepare the engineering report.']);
    assert.equal(
      await h.runtime.sessionExists({ chatId: run.id, userId: 'user-1' }),
      true,
    );

    await writeFile(
      file,
      `---
cron: "30 10 * * 1"
timezone: Asia/Amman
---
Prepare the updated report.
`,
    );
    await source(scheduleControl);
    const [updated] = await scheduleControl.list('user-1');
    assert.equal(updated.id, task.id);
    assert.equal(updated.name, 'monday-report');
    assert.equal(updated.prompt, 'Prepare the updated report.');

    await unlink(file);
    await source(scheduleControl);
    assert.equal(
      (await scheduleControl.get('user-1', task.id)).status,
      'paused',
    );

    await writeFile(
      file,
      `---
cron: "30 10 * * 1"
timezone: Asia/Amman
---
Prepare the updated report.
`,
    );
    await source(scheduleControl);
    assert.equal(
      (await scheduleControl.get('user-1', task.id)).status,
      'active',
    );

    await writeFile(
      join(directory.path, 'invalid.md'),
      `---
cron: "0 9 * * 1"
---
Missing a timezone.
`,
    );
    await assert.rejects(
      source(scheduleControl),
      /Invalid schedule declaration invalid\.md/,
    );
    assert.equal(
      (await scheduleControl.get('user-1', task.id)).status,
      'active',
    );
  });

  it('blocks runtime initialization on an invalid schedule source', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'zukhruf-invalid-schedules-'),
    );
    await writeFile(
      join(directory.path, 'invalid.md'),
      `---
cron: "0 9 * * 1"
---
Missing a timezone.
`,
    );
    const track: ModelTrack = { active: 0, maxActive: 0, calls: [] };
    let scheduled: Schedules | undefined;
    await using h = await harness(scriptedModel(track), undefined, {
      plugins: ({ boss, database }) => {
        scheduled = schedules({
          boss,
          queue: `scheduled-invalid-${crypto.randomUUID()}`,
          reconciliationIntervalMs: 50,
          transaction: (operation) =>
            database.transaction((transaction) =>
              operation(fromPglite(transaction)),
            ),
          sources: [
            scheduleFiles({ directory: directory.path, ownerId: 'user-1' }),
          ],
        });
        return [scheduled];
      },
    });
    assert.ok(scheduled);
    await assert.rejects(
      h.runtime.initialize(),
      /Invalid schedule declaration invalid\.md/,
    );
    await assert.rejects(
      h.runtime.work(),
      /Invalid schedule declaration invalid\.md/,
    );
    assert.deepEqual(await scheduled.list('user-1'), []);
    assert.deepEqual(track.calls, []);
  });
});

describe('zukhruf runtime — setup failure durability', () => {
  it('records a later turn before sandbox setup fails', async () => {
    const track: ModelTrack = { active: 0, maxActive: 0, calls: [] };
    const model = scriptedModel(track);
    const agentDeclaration = declaration(model);
    let sandboxCalls = 0;
    agentDeclaration.sandbox = async (): Promise<AgentSandbox> => {
      if (++sandboxCalls === 2) throw new Error('sandbox setup failed');
      return createBashTool({
        sandbox: await createVirtualSandbox({ fs: new InMemoryFs() }),
      });
    };

    await using h = await harness(model, undefined, {
      declaration: agentDeclaration,
    });
    await using worker = await h.runtime.work();
    void worker;
    const conversation = { chatId: 'sandbox-setup-failure', userId: 'u1' };
    const first = await h.runtime.enqueue(conversation, turn('first'));
    assert.equal(await collectText(first.stream), 'reply:first');

    const failed = await h.runtime.enqueue(conversation, turn('second'));
    await waitForStatus(h.streamStore, failed.id, ['failed']);

    const observer = h.runtime.observe(conversation);
    const messages = await observer.engine.getMessages();
    const thread = AgentThread.fromMetadata(
      conversation,
      observer.engine.chat?.metadata,
    );
    assert.equal(thread?.lastTurnId, failed.id);
    assert.deepEqual(await observer.engine.headMessage(), {
      id: failed.id,
      name: 'assistant',
    });
    assert.ok(messages.some((message) => messageText(message) === 'second'));
    assert.deepEqual(track.calls, ['first']);
  });

  it('records a turn before sandbox skill discovery fails', async () => {
    const track: ModelTrack = { active: 0, maxActive: 0, calls: [] };
    const model = scriptedModel(track);
    const agentDeclaration = declaration(model);
    agentDeclaration.sandbox = defineSandbox(async () => {
      const backend = await createVirtualSandbox({ fs: new InMemoryFs() });
      await backend.writeFiles([
        {
          path: '/workspace/skills/broken/README.md',
          content: 'SKILL.md is intentionally missing',
        },
      ]);
      return backend;
    });

    await using h = await harness(model, undefined, {
      declaration: agentDeclaration,
    });
    await using worker = await h.runtime.work();
    void worker;
    const conversation = { chatId: 'skill-discovery-failure', userId: 'u1' };
    const failed = await h.runtime.enqueue(conversation, turn('use a skill'));
    await waitForStatus(h.streamStore, failed.id, ['failed']);

    const observer = h.runtime.observe(conversation);
    const messages = await observer.engine.getMessages();
    const thread = AgentThread.fromMetadata(
      conversation,
      observer.engine.chat?.metadata,
    );
    assert.equal(thread?.lastTurnId, failed.id);
    assert.deepEqual(await observer.engine.headMessage(), {
      id: failed.id,
      name: 'assistant',
    });
    assert.ok(
      messages.some((message) => messageText(message) === 'use a skill'),
    );
    assert.deepEqual(track.calls, []);
  });
});

describe('zukhruf runtime — background executor', () => {
  it('discovers explicitly uploaded sandbox skills once per conversation', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'zukhruf-skills-'),
    );
    const skillDirectory = join(directory.path, 'skills', 'forecast-sales');
    await mkdir(join(skillDirectory, 'scripts'), { recursive: true });
    const skillMd = [
      '---',
      'name: forecast-sales',
      'description: Forecast sales from historical data.',
      '---',
      '',
      '# Forecast sales',
      '',
      'Read the historical data before forecasting.',
    ].join('\n');
    await Promise.all([
      writeFile(join(skillDirectory, 'SKILL.md'), skillMd),
      writeFile(
        join(skillDirectory, 'scripts', 'forecast.js'),
        'console.log("forecast");',
      ),
    ]);

    const modelPrompts: string[] = [];
    const backends: DisposableSandbox[] = [];
    let discoveryCount = 0;
    const model = new MockLanguageModelV4({
      doStream: async ({ prompt }) => {
        modelPrompts.push(JSON.stringify(prompt));
        return { stream: buildStream(['ok'], 0) };
      },
    });
    const agentDeclaration = declaration(model);
    agentDeclaration.sandbox = defineSandbox(
      async () => {
        const backend = await createVirtualSandbox({
          fs: new InMemoryFs(),
        });
        const executeCommand = backend.executeCommand.bind(backend);
        backend.executeCommand = (command, options) => {
          if (command.includes('/agent-workspace/skills')) discoveryCount++;
          return executeCommand(command, options);
        };
        backends.push(backend);
        return backend;
      },
      {
        destination: '/agent-workspace',
        uploadDirectory: {
          source: directory.path,
          include: 'skills/**/*',
        },
      },
    );

    await using h = await harness(model, undefined, {
      declaration: agentDeclaration,
    });
    await using worker = await h.runtime.work();
    void worker;
    const conversation = { chatId: 'native-skills', userId: 'u1' };
    const first = await h.runtime.enqueue(
      conversation,
      turn('forecast next quarter'),
    );
    assert.equal(await collectText(first.stream), 'ok');

    const second = await h.runtime.enqueue(
      conversation,
      turn('forecast the following quarter'),
    );
    assert.equal(await collectText(second.stream), 'ok');

    assert.equal(modelPrompts.length, 2);
    for (const prompt of modelPrompts) {
      assert.match(prompt, /<available_skills>/);
      assert.match(prompt, /Forecast sales from historical data/);
      assert.match(prompt, /skills\/forecast-sales\/SKILL\.md/);
    }
    assert.equal(backends.length, 2);
    for (const backend of backends) {
      assert.equal(
        await backend.readFile(
          '/agent-workspace/skills/forecast-sales/SKILL.md',
        ),
        skillMd,
      );
      assert.equal(
        await backend.readFile(
          '/agent-workspace/skills/forecast-sales/scripts/forecast.js',
        ),
        'console.log("forecast");',
      );
    }
    assert.equal(discoveryCount, 1);
  });

  it('discovers skills already installed in the configured sandbox', async () => {
    const skillMd = [
      '---',
      'name: preinstalled',
      'description: Use a skill installed by the sandbox provider.',
      '---',
      '',
      '# Preinstalled',
    ].join('\n');
    const modelPrompts: string[] = [];
    let discoveryCount = 0;
    const model = new MockLanguageModelV4({
      doStream: async ({ prompt }) => {
        modelPrompts.push(JSON.stringify(prompt));
        return { stream: buildStream(['ok'], 0) };
      },
    });
    const agentDeclaration = declaration(model);
    agentDeclaration.sandbox = defineSandbox(async () => {
      const backend = await createVirtualSandbox({ fs: new InMemoryFs() });
      await backend.writeFiles([
        {
          path: '/workspace/skills/preinstalled/SKILL.md',
          content: skillMd,
        },
      ]);
      const executeCommand = backend.executeCommand.bind(backend);
      backend.executeCommand = (command, options) => {
        if (command.includes('/workspace/skills')) discoveryCount++;
        return executeCommand(command, options);
      };
      return backend;
    });

    await using h = await harness(model, undefined, {
      declaration: agentDeclaration,
    });
    await using worker = await h.runtime.work();
    void worker;
    const conversation = { chatId: 'preinstalled-skills', userId: 'u1' };
    for (const input of ['use the skill', 'use it again']) {
      const result = await h.runtime.enqueue(conversation, turn(input));
      assert.equal(await collectText(result.stream), 'ok');
    }

    assert.equal(discoveryCount, 1);
    assert.equal(modelPrompts.length, 2);
    for (const prompt of modelPrompts) {
      assert.match(prompt, /<available_skills>/);
      assert.match(prompt, /Use a skill installed by the sandbox provider/);
      assert.match(prompt, /skills\/preinstalled\/SKILL\.md/);
    }
  });

  it('resolves sandbox-bound instruction fragments with the agent sandbox', async () => {
    const modelPrompts: string[] = [];
    let sandboxCount = 0;
    const model = new MockLanguageModelV4({
      doStream: async ({ prompt }) => {
        modelPrompts.push(JSON.stringify(prompt));
        return { stream: buildStream(['ok'], 0) };
      },
    });
    const agentDeclaration = declaration(model);
    agentDeclaration.sandbox = async () => {
      const backend = await createVirtualSandbox({ fs: new InMemoryFs() });
      await backend.writeFiles([
        {
          path: '/workspace/README.md',
          content: `sandbox-${++sandboxCount}`,
        },
      ]);
      return createBashTool({ sandbox: backend });
    };
    agentDeclaration.instructions = [
      fragment('files', async ({ sandbox }) =>
        sandbox!.sandbox.readFile('/workspace/README.md'),
      ),
    ];

    await using h = await harness(model, undefined, {
      declaration: agentDeclaration,
    });
    await using worker = await h.runtime.work();
    void worker;
    const result = await h.runtime.enqueue(
      { chatId: 'sandbox-instructions', userId: 'u1' },
      turn('hi'),
    );

    assert.equal(await collectText(result.stream), 'ok');
    const second = await h.runtime.enqueue(
      { chatId: 'sandbox-instructions', userId: 'u1' },
      turn('again'),
    );
    assert.equal(await collectText(second.stream), 'ok');
    assert.match(modelPrompts[0], /sandbox-1/);
    assert.match(modelPrompts[1], /sandbox-2/);
  });

  it('folds a declaration user reminder into the first model prompt only', async () => {
    const modelInputs: string[] = [];
    const model = new MockLanguageModelV4({
      doStream: async ({ prompt }) => {
        modelInputs.push(lastUserText(prompt));
        return { stream: buildStream(['ok'], 0) };
      },
    });
    const agentDeclaration = defineAgent({
      ...declaration(model),
      instructions: [
        reminder('DECLARATION_REMINDER', {
          target: 'user',
          when: once('declaration-reminder'),
        }),
      ],
    });

    await using h = await harness(model, undefined, {
      declaration: agentDeclaration,
    });
    await using worker = await h.runtime.work();
    void worker;
    const conversation = { chatId: 'declaration-reminder', userId: 'u1' };

    for (const input of ['first', 'second']) {
      const result = await h.runtime.enqueue(conversation, turn(input));
      assert.equal(await collectText(result.stream), 'ok');
    }

    assert.equal(modelInputs.length, 2);
    assert.match(modelInputs[0], /DECLARATION_REMINDER/);
    assert.doesNotMatch(modelInputs[1], /DECLARATION_REMINDER/);
  });

  it('a detached reader reconnects via resume() and receives the full turn', async () => {
    const track: ModelTrack = { active: 0, maxActive: 0, calls: [] };
    await using h = await harness(scriptedModel(track));
    await using _worker = await h.runtime.work();

    const conversation = { chatId: 'c1', userId: 'u1' };
    const { id, stream } = await h.runtime.enqueue(conversation, turn('hi'));

    const reader = stream.getReader();
    await reader.read();
    await reader.cancel();

    const resumed = await h.runtime.observe(conversation).resume();
    assert.ok(resumed, 'resume() should return the in-flight/finished turn');
    const text = await collectText(resumed);
    assert.equal(text, 'reply:hi');

    assert.equal(await h.streamStore.getStreamStatus(id), 'completed');

    const messages = await h.runtime.observe(conversation).engine.getMessages();
    const committed = messages.find((m) => m.id === id);
    assert.ok(committed, 'assistant message committed to the chain');
    const committedText = committed.parts
      .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
      .map((p) => p.text)
      .join('');
    assert.equal(committedText, 'reply:hi');
  });

  it('resume() returns null when no turn has started', async () => {
    const track: ModelTrack = { active: 0, maxActive: 0, calls: [] };
    await using h = await harness(scriptedModel(track));
    assert.equal(
      await h.runtime.observe({ chatId: 'c2', userId: 'u1' }).resume(),
      null,
    );
  });

  it('cancel() transitions the in-flight stream to cancelled', async () => {
    const track: ModelTrack = { active: 0, maxActive: 0, calls: [] };
    await using h = await harness(slowModel(track));
    await using _worker = await h.runtime.work();

    const conversation = { chatId: 'c3', userId: 'u1' };
    const { id, stream } = await h.runtime.enqueue(conversation, turn('go'));
    await waitForStatus(h.streamStore, id, ['running']);
    await h.runtime.observe(conversation).cancel();
    await collectText(stream);
    assert.equal(await h.streamStore.getStreamStatus(id), 'cancelled');
  });

  it('cancel() after completion does not overwrite the terminal status', async () => {
    const track: ModelTrack = { active: 0, maxActive: 0, calls: [] };
    await using h = await harness(scriptedModel(track));
    await using _worker = await h.runtime.work();

    const conversation = { chatId: 'c4', userId: 'u1' };
    const { id, stream } = await h.runtime.enqueue(conversation, turn('hi'));
    await collectText(stream);
    assert.equal(await h.streamStore.getStreamStatus(id), 'completed');
    await h.runtime.observe(conversation).cancel();
    assert.equal(await h.streamStore.getStreamStatus(id), 'completed');
  });

  it('turns in the same chat run strictly FIFO, one at a time', async () => {
    const track: ModelTrack = { active: 0, maxActive: 0, calls: [] };
    await using h = await harness(
      scriptedModel(track, { chunkDelayInMs: 150 }),
    );
    await using _worker = await h.runtime.work({ concurrency: 2 });

    const conversation = { chatId: 'c5', userId: 'u1' };
    const first = await h.runtime.enqueue(conversation, turn('one'));
    const second = await h.runtime.enqueue(conversation, turn('two'));

    const [a, b] = await Promise.all([
      collectText(first.stream),
      collectText(second.stream),
    ]);
    assert.equal(a, 'reply:one');
    assert.equal(b, 'reply:two');
    assert.equal(track.maxActive, 1, 'never two active turns in one chat');
    assert.deepStrictEqual(track.calls, ['one', 'two']);

    const messages = await h.runtime.observe(conversation).engine.getMessages();
    const texts = messages.map((m) =>
      m.parts
        .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
        .map((p) => p.text)
        .join(''),
    );
    assert.deepStrictEqual(texts, ['one', 'reply:one', 'two', 'reply:two']);
  });

  it('turns in different chats run concurrently', async () => {
    const track: ModelTrack = { active: 0, maxActive: 0, calls: [] };
    const gate = Promise.withResolvers<void>();
    await using h = await harness(scriptedModel(track, { gate }));
    await using _worker = await h.runtime.work({ concurrency: 2 });

    const waiting = await h.runtime.enqueue(
      { chatId: 'c6a', userId: 'u1' },
      turn('gate-wait'),
    );
    const opening = await h.runtime.enqueue(
      { chatId: 'c6b', userId: 'u1' },
      turn('gate-open'),
    );

    const [a, b] = await Promise.all([
      collectText(waiting.stream),
      collectText(opening.stream),
    ]);
    assert.equal(
      a,
      'opened reply:gate-wait',
      'first turn finished only after the second started — chats overlap',
    );
    assert.equal(b, 'reply:gate-open');
  });

  it('cancel while queued skips execution entirely', async () => {
    const track: ModelTrack = { active: 0, maxActive: 0, calls: [] };
    await using h = await harness(scriptedModel(track));

    const conversation = { chatId: 'c7', userId: 'u1' };
    const { id, stream } = await h.runtime.enqueue(conversation, turn('never'));
    await h.runtime.observe(conversation).cancel(id);
    assert.equal(await h.streamStore.getStreamStatus(id), 'cancelled');

    await using _worker = await h.runtime.work();
    await collectText(stream);
    await sleep(1500);

    assert.equal(await h.streamStore.getStreamStatus(id), 'cancelled');
    assert.deepStrictEqual(track.calls, [], 'model never invoked');
    const messages = await h.runtime.observe(conversation).engine.getMessages();
    assert.deepStrictEqual(messages, [], 'nothing entered the chain');
  });

  it('host cancel removes the queued turn and preserves its successor', async () => {
    const track: ModelTrack = { active: 0, maxActive: 0, calls: [] };
    await using h = await harness(scriptedModel(track));

    const conversation = { chatId: 'host-cancel-queued', userId: 'u1' };
    const cancelled = await h.runtime.enqueue(conversation, turn('cancel me'));
    const successor = await h.runtime.enqueue(conversation, turn('keep me'));

    await h.runtime.observe(conversation).cancel(cancelled.id);

    assert.equal(
      await h.streamStore.getStreamStatus(cancelled.id),
      'cancelled',
    );
    assert.equal(
      (await h.queue.getCurrentTurn(conversation))?.streamId,
      successor.id,
      'only the cancelled stream receipts are removed',
    );
    assert.equal(await h.streamStore.getStreamStatus(successor.id), 'queued');
  });

  it('enqueue is idempotent on the turn id — duplicates reattach, never re-run', async () => {
    const track: ModelTrack = { active: 0, maxActive: 0, calls: [] };
    await using h = await harness(scriptedModel(track));
    await using _worker = await h.runtime.work();

    const conversation = { chatId: 'c9', userId: 'u1' };
    const ask = turn('once');

    const first = await h.runtime.enqueue(conversation, ask);
    const duplicate = await h.runtime.enqueue(conversation, ask);
    assert.equal(duplicate.id, first.id);

    const [a, b] = await Promise.all([
      collectText(first.stream),
      collectText(duplicate.stream),
    ]);
    assert.equal(a, 'reply:once');
    assert.equal(b, 'reply:once');
    assert.deepStrictEqual(track.calls, ['once'], 'model ran exactly once');

    const resubmit = await h.runtime.enqueue(conversation, {
      id: ask.id,
      input: 'a different input under the same id',
    });
    const text = await collectText(resubmit.stream);
    assert.equal(text, 'reply:once', 'post-completion resubmit replays');
    assert.deepStrictEqual(
      track.calls,
      ['once'],
      'still exactly one run — first input wins',
    );

    const messages = await h.runtime.observe(conversation).engine.getMessages();
    assert.equal(messages.length, 2, 'one user message + one assistant reply');
  });

  it('committed turns leave no jobs behind (commit-GC end-to-end)', async () => {
    const track: ModelTrack = { active: 0, maxActive: 0, calls: [] };
    await using h = await harness(scriptedModel(track));
    await using _worker = await h.runtime.work();

    const conversation = { chatId: 'gc1', userId: 'u1' };
    await collectText(
      (await h.runtime.enqueue(conversation, turn('one'))).stream,
    );
    await collectText(
      (await h.runtime.enqueue(conversation, turn('two'))).stream,
    );
    await sleep(500);

    const jobs = await h.boss.findJobs(h.queue.queue, { key: 'gc1' });
    assert.deepStrictEqual(
      jobs.map((j) => j.state),
      [],
      'both turns committed and their jobs were deleted — the queue does not accumulate',
    );
  });

  it('enqueue rejects a missing turn id', async () => {
    const track: ModelTrack = { active: 0, maxActive: 0, calls: [] };
    await using h = await harness(scriptedModel(track));
    await assert.rejects(
      h.runtime.enqueue(
        { chatId: 'c10', userId: 'u1' },
        {
          id: '',
          input: 'hi',
        },
      ),
      /turn id is required/,
    );
  });

  it('a needsApproval tool call pauses the turn: stream completes, chain head carries the pending approval', async () => {
    const { track, tools, model } = approvalSetup();
    await using h = await harness(model, tools);
    await using _worker = await h.runtime.work();

    const conversation = { chatId: 'a1', userId: 'u1' };
    const { id, stream } = await h.runtime.enqueue(
      conversation,
      turn('send it'),
    );
    const text = await collectText(stream);

    assert.equal(text, 'working ');
    assert.equal(await h.streamStore.getStreamStatus(id), 'completed');
    const { head, part } = await pausedToolCall(h.runtime, conversation);
    assert.equal(head.id, id, 'paused assistant IS the turn');
    assert.equal(part.state, 'approval-requested');
    assert.equal(track.toolRuns, 0, 'tool did not execute');
  });

  it('approve() resumes the turn: tool executes once, same assistant message accumulates', async () => {
    const { track, tools, model } = approvalSetup();
    await using h = await harness(model, tools);
    await using _worker = await h.runtime.work();

    const conversation = { chatId: 'a2', userId: 'u1' };
    const ask = await h.runtime.enqueue(conversation, turn('send it'));
    await collectText(ask.stream);
    const { part } = await pausedToolCall(h.runtime, conversation);

    const resumed = await h.runtime.approve(conversation, {
      toolCallId: part.toolCallId,
    });
    assert.equal(resumed.id, ask.id, 'continuation reuses the turn id');
    assert.equal(resumed.status, 'queued');
    assert.match(resumed.jobId, /^[0-9a-f-]{36}$/);
    await waitForText(h.runtime, conversation, 'done:send it');

    assert.equal(track.toolRuns, 1, 'tool executed exactly once');
    const messages = await h.runtime.observe(conversation).engine.getMessages();
    assert.equal(messages.length, 2, 'one user + ONE assistant message');
    const final = messages.at(-1)!;
    const toolPart = final.parts.find(isToolUIPart)!;
    assert.equal(toolPart.state, 'output-available');
    assert.equal(toolPart.output, 'sent:a@b.c');
    assert.equal(await h.streamStore.getStreamStatus(ask.id), 'completed');
  });

  it('waits for every sibling approval before resuming the original turn once', async () => {
    const { track, tools, model } = siblingApprovalSetup();
    await using h = await harness(model, tools);
    await using _worker = await h.runtime.work();
    const conversation = { chatId: 'sibling-approvals', userId: 'u1' };
    const ask = await h.runtime.enqueue(conversation, turn('send both'));
    await collectText(ask.stream);

    const first = await h.runtime.approve(conversation, {
      toolCallId: 'first-email',
    });
    assert.equal(first.status, 'queued');
    await waitForConversation(
      h.runtime,
      conversation,
      (messages) =>
        messages
          .at(-1)
          ?.parts.filter(isToolUIPart)
          .map((part) => part.state)
          .join(',') === 'approval-responded,approval-requested',
      'the first sibling approval',
    );
    assert.equal(
      await h.streamStore.getStreamStatus(ask.id),
      'completed',
      'the original pause remains terminal until every sibling is answered',
    );
    assert.equal(track.calls.length, 1, 'no continuation was sampled early');

    const pending = (
      await h.runtime.observe(conversation).engine.getMessages()
    ).at(-1)!;
    assert.deepStrictEqual(
      pending.parts.filter(isToolUIPart).map((part) => part.state),
      ['approval-responded', 'approval-requested'],
    );

    await h.runtime.deny(conversation, {
      toolCallId: 'second-email',
      reason: 'skip the second',
    });
    await waitForText(h.runtime, conversation, 'both approved');
    assert.equal(track.toolRuns, 1, 'only the approved sibling executed');
    assert.equal(track.calls.length, 2, 'exactly one continuation was sampled');
  });

  it('persists concurrent decisions for different sibling approvals', async (t) => {
    const { track, tools, model } = siblingApprovalSetup();
    await using h = await harness(model, tools);
    await using _worker = await h.runtime.work();
    const conversation = {
      chatId: 'concurrent-sibling-approvals',
      userId: 'u1',
    };
    const ask = await h.runtime.enqueue(conversation, turn('send both'));
    await collectText(ask.stream);

    await Promise.all([
      h.runtime.approve(conversation, { toolCallId: 'first-email' }),
      h.runtime.deny(conversation, {
        toolCallId: 'second-email',
        reason: 'skip the second',
      }),
    ]);
    await t.waitFor(() => assert.equal(track.calls.length, 2), {
      interval: 25,
      timeout: 3_000,
    });

    assert.equal(track.calls.length, 2, 'one continuation was sampled');
    assert.equal(track.toolRuns, 1, 'only the approved sibling executed');
    assert.equal(
      await waitForStatus(h.streamStore, ask.id, ['completed'], 3_000),
      'completed',
    );
    const final = (
      await h.runtime.observe(conversation).engine.getMessages()
    ).at(-1);
    assert.ok(final);
    assert.deepStrictEqual(
      final.parts.filter(isToolUIPart).map((part) => part.state),
      ['output-available', 'output-denied'],
    );
  });

  it('repairs parked-turn revival in the worker after the resumed turn settles', async (t) => {
    const { track, tools, model } = approvalSetup();
    await using h = await harness(model, tools, {
      queueFactory: (boss) =>
        new FailOnceResumeParkedQueue(boss, {
          pollingIntervalSeconds: 0.5,
          schema: 'pgboss',
        }),
    });
    await using _worker = await h.runtime.work({ concurrency: 2 });
    const conversation = { chatId: 'approval-revival-retry', userId: 'u1' };
    const ask = await h.runtime.enqueue(conversation, turn('send it'));
    await collectText(ask.stream);
    const { part } = await pausedToolCall(h.runtime, conversation);
    const followup = await h.runtime.enqueue(
      conversation,
      turn('after approval'),
    );
    const parkedDeadline = performance.now() + 5_000;
    let parkedState: string | undefined;
    while (performance.now() < parkedDeadline) {
      const jobs = await h.boss.findJobs(h.queue.queue, {
        key: conversation.chatId,
      });
      parkedState = jobs.find(
        (job) => (job.data as TurnRef).streamId === followup.id,
      )?.state;
      if (parkedState === 'cancelled') break;
      await sleep(25);
    }
    assert.equal(parkedState, 'cancelled', 'the follow-up is parked first');

    const queued = await h.runtime.approve(conversation, {
      toolCallId: part.toolCallId,
    });
    assert.equal(queued.status, 'queued');
    await t.waitFor(() => assert.equal(track.calls.length, 3), {
      interval: 25,
      timeout: 5_000,
    });
    assert.equal(await h.streamStore.getStreamStatus(ask.id), 'completed');
    assert.deepStrictEqual(track.calls, [
      'send it',
      'send it',
      'after approval',
    ]);
  });

  it('deny() resumes without executing: output-denied, model sees the denial', async () => {
    const { track, tools, model } = approvalSetup();
    await using h = await harness(model, tools);
    await using _worker = await h.runtime.work();

    const conversation = { chatId: 'a3', userId: 'u1' };
    await collectText(
      (await h.runtime.enqueue(conversation, turn('send it'))).stream,
    );
    const { part } = await pausedToolCall(h.runtime, conversation);

    await h.runtime.deny(conversation, {
      toolCallId: part.toolCallId,
      reason: 'not today',
    });
    await waitForText(h.runtime, conversation, 'denied:send it');
    assert.equal(track.toolRuns, 0, 'tool never executed');

    const final = (
      await h.runtime.observe(conversation).engine.getMessages()
    ).at(-1)!;
    const toolPart = final.parts.find(isToolUIPart)!;
    assert.equal(toolPart.state, 'output-denied');
    assert.deepStrictEqual(
      {
        approved: toolPart.approval?.approved,
        reason: toolPart.approval?.reason,
      },
      { approved: false, reason: 'not today' },
    );
  });

  it('turns enqueued while a chat awaits approval queue behind it, in order', async () => {
    const { track, tools, model } = approvalSetup();
    await using h = await harness(model, tools);
    await using _worker = await h.runtime.work({ concurrency: 2 });

    const conversation = { chatId: 'a4', userId: 'u1' };
    await collectText(
      (await h.runtime.enqueue(conversation, turn('send it'))).stream,
    );
    const { part } = await pausedToolCall(h.runtime, conversation);

    const second = await h.runtime.enqueue(conversation, turn('two'));
    const third = await h.runtime.enqueue(conversation, turn('three'));
    await sleep(2500);
    assert.deepStrictEqual(
      track.calls,
      ['send it'],
      'gated turns parked — model untouched while approval pends',
    );

    await h.runtime.approve(conversation, {
      toolCallId: part.toolCallId,
    });
    const [, b, c] = await Promise.all([
      waitForText(h.runtime, conversation, 'done:send it'),
      collectText(second.stream),
      collectText(third.stream),
    ]);
    assert.equal(b, 'reply:two');
    assert.equal(c, 'reply:three');
    assert.deepStrictEqual(
      track.calls,
      ['send it', 'send it', 'two', 'three'],
      'continuation first, then parked turns in original order',
    );
  });

  it('double-approve is idempotent: one continuation, one tool execution', async () => {
    const { track, tools, model } = approvalSetup();
    await using h = await harness(model, tools);
    await using _worker = await h.runtime.work();

    const conversation = { chatId: 'a5', userId: 'u1' };
    await collectText(
      (await h.runtime.enqueue(conversation, turn('send it'))).stream,
    );
    const { part } = await pausedToolCall(h.runtime, conversation);

    const first = await h.runtime.approve(conversation, {
      toolCallId: part.toolCallId,
    });
    const again = await h.runtime.approve(conversation, {
      toolCallId: part.toolCallId,
    });
    assert.equal(again.id, first.id);
    assert.equal(again.jobId, first.jobId);
    await waitForText(h.runtime, conversation, 'done:send it');
    const applied = await h.runtime.approve(conversation, {
      toolCallId: part.toolCallId,
    });
    assert.equal(applied.status, 'already-applied');
    assert.equal(applied.jobId, first.jobId);
    assert.equal(track.toolRuns, 1, 'tool executed exactly once');
  });

  it('a paused turn leaves no queue job, and approving cleans up the approval job too', async () => {
    const { tools, model } = approvalSetup();
    await using h = await harness(model, tools);
    await using _worker = await h.runtime.work();

    const conversation = { chatId: 'gc-pause', userId: 'u1' };
    await collectText(
      (await h.runtime.enqueue(conversation, turn('send it'))).stream,
    );
    const { part } = await pausedToolCall(h.runtime, conversation);

    const whilePaused = await h.boss.findJobs(h.queue.queue, {
      key: 'gc-pause',
    });
    assert.deepStrictEqual(
      whilePaused.map((j) => j.state),
      [],
      'the paused turn committed to the chain, so its job is gone — the pause lives only in the chain',
    );

    await h.runtime.approve(conversation, {
      toolCallId: part.toolCallId,
    });
    await waitForText(h.runtime, conversation, 'done:send it');
    await sleep(400);

    const afterApprove = await h.boss.findJobs(h.queue.queue, {
      key: 'gc-pause',
    });
    assert.deepStrictEqual(
      afterApprove.map((j) => j.state),
      [],
      'the approval job is deleted once it commits — nothing accumulates',
    );
  });

  it('the deny flow leaves no queue job behind', async () => {
    const { track, tools, model } = approvalSetup();
    await using h = await harness(model, tools);
    await using _worker = await h.runtime.work();

    const conversation = { chatId: 'gc-deny', userId: 'u1' };
    await collectText(
      (await h.runtime.enqueue(conversation, turn('send it'))).stream,
    );
    const { part } = await pausedToolCall(h.runtime, conversation);

    await h.runtime.deny(conversation, {
      toolCallId: part.toolCallId,
      reason: 'nope',
    });
    await waitForText(h.runtime, conversation, 'denied:send it');
    assert.equal(track.toolRuns, 0, 'tool never ran');
    await sleep(400);

    const jobs = await h.boss.findJobs(h.queue.queue, { key: 'gc-deny' });
    assert.deepStrictEqual(
      jobs.map((j) => j.state),
      [],
      'denied continuation commits and its job is deleted',
    );
  });

  it('re-executes a queued turn after pg-boss retention deletes its job', async (t) => {
    const track: ModelTrack = { active: 0, maxActive: 0, calls: [] };
    await using h = await harness(scriptedModel(track));
    await h.boss.updateQueue(h.queue.queue, { retentionSeconds: 1 });

    const queued = await h.runtime.enqueue(
      { chatId: 'retained-turn', userId: 'u1' },
      turn('reexecute me'),
    );
    await t.waitFor(
      async () => {
        await h.boss.supervise(h.queue.queue);
        assert.deepStrictEqual(
          await h.boss.findJobs(h.queue.queue, {
            data: { streamId: queued.id },
          }),
          [],
        );
      },
      { interval: 100, timeout: 5_000 },
    );

    await using _worker = await h.runtime.work();
    const reader = queued.stream.getReader();
    try {
      let text = '';
      await settleWithin(
        (async () => {
          while (true) {
            const { done, value } = await reader.read();
            if (done) return;
            if (value.type === 'text-delta') text += value.delta;
          }
        })(),
        'retained turn re-executes',
        2_000,
      );
      assert.equal(text, 'reply:reexecute me');
    } finally {
      await reader.cancel();
    }
  });

  it('parked follow-ups survive a maintenance pass while gated, then revive in order and leave no jobs behind', async () => {
    const { track, tools, model } = approvalSetup();
    await using h = await harness(model, tools);
    await using _worker = await h.runtime.work({ concurrency: 2 });

    const conversation = { chatId: 'gc-behind', userId: 'u1' };
    await collectText(
      (await h.runtime.enqueue(conversation, turn('send it'))).stream,
    );
    const { part } = await pausedToolCall(h.runtime, conversation);

    const second = await h.runtime.enqueue(conversation, turn('two'));
    const third = await h.runtime.enqueue(conversation, turn('three'));
    const fourth = await h.runtime.enqueue(conversation, turn('four'));
    await sleep(2500);
    assert.deepStrictEqual(
      track.calls,
      ['send it'],
      'gated — parked turns did not run',
    );

    const parked = await h.boss.findJobs(h.queue.queue, { key: 'gc-behind' });
    assert.equal(
      parked.filter((j) => j.state === 'cancelled').length,
      3,
      'all three follow-ups are parked (cancelled)',
    );

    // The maintenance pass that would delete a retention-eligible job.
    await h.boss.supervise(h.queue.queue);
    await sleep(400);
    const survived = await h.boss.findJobs(h.queue.queue, { key: 'gc-behind' });
    assert.equal(
      survived.filter((j) => j.state === 'cancelled').length,
      3,
      'parked follow-ups survive maintenance — no retention deadline',
    );

    await h.runtime.approve(conversation, {
      toolCallId: part.toolCallId,
    });
    const [, b, c, d] = await Promise.all([
      waitForText(h.runtime, conversation, 'done:send it'),
      collectText(second.stream),
      collectText(third.stream),
      collectText(fourth.stream),
    ]);
    assert.equal(b, 'reply:two');
    assert.equal(c, 'reply:three');
    assert.equal(d, 'reply:four');
    assert.deepStrictEqual(
      track.calls,
      ['send it', 'send it', 'two', 'three', 'four'],
      'continuation first, then the three revived follow-ups in original order',
    );

    await sleep(500);
    const leftover = await h.boss.findJobs(h.queue.queue, { key: 'gc-behind' });
    assert.deepStrictEqual(
      leftover.map((j) => j.state),
      [],
      'every job is deleted once its turn commits — nothing accumulates',
    );
  });

  it('a turn cancelled while queued leaves no job behind when the worker skips it', async () => {
    const track: ModelTrack = { active: 0, maxActive: 0, calls: [] };
    await using h = await harness(scriptedModel(track));

    const conversation = { chatId: 'gc-cancelq', userId: 'u1' };
    const { id, stream } = await h.runtime.enqueue(conversation, turn('never'));
    await h.runtime.observe(conversation).cancel(id);

    await using _worker = await h.runtime.work();
    await collectText(stream);
    await sleep(500);

    assert.deepStrictEqual(track.calls, [], 'the cancelled turn never ran');
    const jobs = await h.boss.findJobs(h.queue.queue, { key: 'gc-cancelq' });
    assert.deepStrictEqual(
      jobs.map((j) => j.state),
      [],
      'the skipped job is deleted, not left dangling in the queue',
    );
  });

  it('resumeParked revives a user-cancelled follow-up, but the terminal-stream check skips it and cleans it up', async () => {
    const { track, tools, model } = approvalSetup();
    await using h = await harness(model, tools);
    await using _worker = await h.runtime.work({ concurrency: 2 });

    const conversation = { chatId: 'gc-parkcancel', userId: 'u1' };
    await collectText(
      (await h.runtime.enqueue(conversation, turn('send it'))).stream,
    );
    const { part } = await pausedToolCall(h.runtime, conversation);

    // A follow-up arrives while gated and parks (job cancelled, stream queued).
    const second = await h.runtime.enqueue(conversation, turn('two'));
    await waitForStatus(h.streamStore, second.id, ['queued']);
    await sleep(1500);
    const parked = await h.boss.findJobs(h.queue.queue, {
      key: 'gc-parkcancel',
    });
    assert.equal(
      parked.filter((j) => j.state === 'cancelled').length,
      1,
      'the follow-up is parked',
    );

    // The user cancels that follow-up (stream → cancelled) while it is parked.
    await h.runtime.observe(conversation).cancel(second.id);
    assert.equal(await h.streamStore.getStreamStatus(second.id), 'cancelled');

    // Approving revives every cancelled job for the chat — including the
    // user-cancelled follow-up — but executeTurn's terminal-stream check skips
    // it, so it never reaches the model and its job is cleaned up.
    await h.runtime.approve(conversation, {
      toolCallId: part.toolCallId,
    });
    await waitForText(h.runtime, conversation, 'done:send it');
    await sleep(600);

    assert.deepStrictEqual(
      track.calls,
      ['send it', 'send it'],
      'the user-cancelled follow-up never ran — only the pause and its continuation',
    );
    const leftover = await h.boss.findJobs(h.queue.queue, {
      key: 'gc-parkcancel',
    });
    assert.deepStrictEqual(
      leftover.map((j) => j.state),
      [],
      'the skipped follow-up job is deleted, not left dangling',
    );
  });

  it('cancelling a paused turn is currently a no-op: the pause survives and is still approvable', async () => {
    const { track, tools, model } = approvalSetup();
    await using h = await harness(model, tools);
    await using _worker = await h.runtime.work();

    const conversation = { chatId: 'gc-cancelpaused', userId: 'u1' };
    const paused = await h.runtime.enqueue(conversation, turn('send it'));
    await collectText(paused.stream);
    const { part } = await pausedToolCall(h.runtime, conversation);

    // The paused turn's stream is terminal (completed), so cancel() no-ops.
    // (DESIGN/TODO flag this edge as undecided — pinning the CURRENT behavior so
    // a future "cancel-of-paused = deny" change is a visible, deliberate break.)
    await h.runtime.observe(conversation).cancel();
    assert.equal(await h.streamStore.getStreamStatus(paused.id), 'completed');
    const stillPaused = await pausedToolCall(h.runtime, conversation);
    assert.equal(
      stillPaused.part.state,
      'approval-requested',
      'pause survived the cancel',
    );

    await h.runtime.approve(conversation, {
      toolCallId: part.toolCallId,
    });
    await waitForText(h.runtime, conversation, 'done:send it');
    assert.equal(track.toolRuns, 1, 'still approvable after the no-op cancel');
  });

  it('concurrent double-approve is idempotent: one continuation, one tool execution, no leftover jobs', async () => {
    const { track, tools, model } = approvalSetup();
    await using h = await harness(model, tools);
    await using _worker = await h.runtime.work();

    const conversation = { chatId: 'gc-concappr', userId: 'u1' };
    await collectText(
      (await h.runtime.enqueue(conversation, turn('send it'))).stream,
    );
    const { part } = await pausedToolCall(h.runtime, conversation);

    // Both calls calculate the same deterministic approval job identity.
    const [a, b] = await Promise.all([
      h.runtime.approve(conversation, { toolCallId: part.toolCallId }),
      h.runtime.approve(conversation, { toolCallId: part.toolCallId }),
    ]);
    assert.equal(a.id, b.id, 'both approves resolve to the same turn');
    assert.equal(a.jobId, b.jobId, 'both approves address the same queue job');
    await waitForText(h.runtime, conversation, 'done:send it');
    await sleep(600);

    assert.equal(
      track.toolRuns,
      1,
      'tool executed exactly once despite concurrent approves',
    );
    const messages = await h.runtime.observe(conversation).engine.getMessages();
    assert.equal(
      messages.length,
      2,
      'one user + one assistant — no duplicate continuation',
    );
    const leftover = await h.boss.findJobs(h.queue.queue, {
      key: 'gc-concappr',
    });
    assert.deepStrictEqual(
      leftover.map((j) => j.state),
      [],
      'no duplicate or leftover approval jobs',
    );
  });

  it('queues concurrent approve and deny as the same command so one durable decision wins', async () => {
    const { track, tools, model } = approvalSetup();
    await using h = await harness(model, tools);
    const conversation = { chatId: 'approval-decision-race', userId: 'u1' };
    let ask: Awaited<ReturnType<typeof h.runtime.enqueue>>;
    let part: Awaited<ReturnType<typeof pausedToolCall>>['part'];
    {
      await using _worker = await h.runtime.work();
      ask = await h.runtime.enqueue(conversation, turn('send it'));
      await collectText(ask.stream);
      ({ part } = await pausedToolCall(h.runtime, conversation));
    }

    const outcomes = await Promise.allSettled([
      h.runtime.approve(conversation, { toolCallId: part.toolCallId }),
      h.runtime.deny(conversation, {
        toolCallId: part.toolCallId,
        reason: 'deny raced with approve',
      }),
    ]);
    assert.equal(
      outcomes.filter((outcome) => outcome.status === 'fulfilled').length,
      2,
      outcomes
        .map((outcome) =>
          outcome.status === 'fulfilled'
            ? outcome.value.status
            : `rejected:${String(outcome.reason)}`,
        )
        .join(', '),
    );
    const commands = outcomes.flatMap((outcome) =>
      outcome.status === 'fulfilled' ? [outcome.value] : [],
    );
    assert.equal(commands[0]?.jobId, commands[1]?.jobId);
    assert.deepStrictEqual(
      commands.map((command) => command.status).toSorted(),
      ['already-queued', 'queued'],
    );

    {
      await using _worker = await h.runtime.work();
      await waitForConversation(
        h.runtime,
        conversation,
        (messages) =>
          messages
            .at(-1)
            ?.parts.some(
              (candidate) =>
                isToolUIPart(candidate) &&
                candidate.toolCallId === part.toolCallId &&
                candidate.state !== 'approval-requested',
            ) === true,
        'the queued decision',
      );
    }
    const final = (
      await h.runtime.observe(conversation).engine.getMessages()
    ).at(-1)!;
    const decided = final.parts.find(isToolUIPart)!;
    assert.equal(track.toolRuns, decided.approval?.approved === true ? 1 : 0);
    assert.equal(track.calls.length, 2, 'the winning decision continued once');
  });

  it('approve and deny reject when there is no matching paused approval', async () => {
    const { tools, model } = approvalSetup();
    await using h = await harness(model, tools);
    await using _worker = await h.runtime.work();

    const conversation = { chatId: 'gc-apprerr', userId: 'u1' };
    await assert.rejects(
      h.runtime.approve(conversation, { toolCallId: 'whatever' }),
      /ApprovalController\.approve: no paused turn/,
      'approve with no turn at all rejects',
    );

    await collectText(
      (await h.runtime.enqueue(conversation, turn('send it'))).stream,
    );
    await pausedToolCall(h.runtime, conversation);
    await assert.rejects(
      h.runtime.deny(conversation, { toolCallId: 'wrong-id' }),
      /ApprovalController\.deny: no tool call/,
      'deny with an unknown toolCallId rejects',
    );
  });

  it('a crashed turn is marked failed and unblocks the next turn in the chat', async () => {
    const track: ModelTrack = { active: 0, maxActive: 0, calls: [] };
    await using h = await harness(scriptedModel(track));
    await using _worker = await h.runtime.work();

    const conversation = { chatId: 'c8', userId: 'u1' };
    const crashed = await h.runtime.enqueue(conversation, turn('boom'));
    const next = await h.runtime.enqueue(conversation, turn('after'));

    await waitForStatus(h.streamStore, crashed.id, ['failed']);
    const text = await collectText(next.stream);
    assert.equal(text, 'reply:after', 'chat unblocked after the failure');
    assert.equal(await h.streamStore.getStreamStatus(crashed.id), 'failed');
  });
});
