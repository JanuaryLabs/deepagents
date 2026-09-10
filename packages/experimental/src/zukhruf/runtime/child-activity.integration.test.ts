import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { PGlite } from '@electric-sql/pglite';
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { Hono } from 'hono';
import { InMemoryFs } from 'just-bash';
import assert from 'node:assert/strict';
import { mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { PgBoss, fromPglite } from 'pg-boss';
import { z } from 'zod';

import {
  PollingChangeSource,
  SqliteContextStore,
  SqliteStreamStore,
  StreamManager,
  createVirtualSandbox,
} from '@deepagents/context';
import {
  AgentRuntime,
  type ChildProgress,
  type ConversationStatusChange,
  PgBossConversationStatusChangeSource,
  PgBossTurnQueue,
  SqliteMailboxStore,
  defineAgent,
  defineSandbox,
  defineTool,
} from '@deepagents/experimental/zukhruf';
import {
  type HttpEnv,
  type OwnerEvent,
  http,
} from '@deepagents/experimental/zukhruf/http';

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};
const finish = {
  type: 'finish',
  finishReason: { unified: 'stop', raw: 'stop' },
  usage,
} satisfies LanguageModelV4StreamPart;
const text = (value: string): LanguageModelV4StreamPart[] => [
  { type: 'text-start', id: 'text' },
  { type: 'text-delta', id: 'text', delta: value },
  { type: 'text-end', id: 'text' },
  finish,
];
const response = (chunks: LanguageModelV4StreamPart[]) => ({
  stream: simulateReadableStream({
    chunks,
    initialDelayInMs: null,
    chunkDelayInMs: null,
  }),
});
const call = (
  toolName: string,
  input: unknown,
): LanguageModelV4StreamPart[] => [
  {
    type: 'tool-call',
    toolCallId: crypto.randomUUID(),
    toolName,
    input: JSON.stringify(input),
  },
  {
    type: 'finish',
    finishReason: { unified: 'tool-calls', raw: 'tool-calls' },
    usage,
  },
];

test(
  'child activity flows from worker operations through owner events and durable project snapshots',
  { timeout: 60_000 },
  async (t) => {
    const database = new PGlite();
    const boss = new PgBoss({ db: fromPglite(database), backend: 'pglite' });
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'child-activity-'),
    );
    const contextPath = join(directory.path, 'context.sqlite');
    using contextDb = new DatabaseSync(contextPath);
    using observerDb = new DatabaseSync(contextPath);
    const store = new SqliteContextStore(contextDb);
    const observerStore = new SqliteContextStore(observerDb);
    const streamStore = new SqliteStreamStore(':memory:');
    const mailboxStore = new SqliteMailboxStore(':memory:');
    const streams = new StreamManager({
      store: streamStore,
      changeSource: new PollingChangeSource({ reads: streamStore }),
    });
    const abort = new AbortController();
    const readers: ReadableStreamDefaultReader<string>[] = [];
    const consumers: Promise<void>[] = [];
    const errors: unknown[] = [];
    boss.on('error', (error) => errors.push(error));
    try {
      await boss.start();
      const queue = new PgBossTurnQueue(boss, {
        pollingIntervalSeconds: 0.5,
        schema: 'pgboss',
      });
      await queue.initialize();
      const scripted: LanguageModelV4StreamPart[][] = [];
      const sandbox = defineSandbox(async () =>
        createVirtualSandbox({ fs: new InMemoryFs() }),
      );
      const root = defineAgent({
        name: 'root',
        sandbox,
        instructions: [],
        model: new MockLanguageModelV4({
          doStream: async () => {
            return response(scripted.shift() ?? text('root done'));
          },
        }),
        subagents: [
          defineAgent({
            name: 'worker',
            sandbox,
            instructions: [],
            model: new MockLanguageModelV4({
              doStream: async () => response(text('child result')),
            }),
          }),
          defineAgent({
            name: 'blocked',
            sandbox,
            instructions: [],
            model: new MockLanguageModelV4({
              doStream: async ({ abortSignal }) => {
                await sleep(30_000, undefined, { signal: abortSignal });
                return response(text('should be interrupted'));
              },
            }),
          }),
          defineAgent({
            name: 'failed',
            sandbox,
            instructions: [],
            model: new MockLanguageModelV4({
              doStream: async () =>
                response([{ type: 'error', error: new Error('child failed') }]),
            }),
          }),
          defineAgent({
            name: 'approval',
            sandbox,
            instructions: [],
            tools: {
              confirm: defineTool({
                description: 'Needs approval',
                inputSchema: z.object({}),
                needsApproval: true,
                execute: async () => 'approved',
              }),
            },
            model: new MockLanguageModelV4({
              doStream: async () => response(call('confirm', {})),
            }),
          }),
        ],
      });
      const options = { store, streams, queue, mailboxStore };
      const runtime = new AgentRuntime(root, {
        ...options,
        conversationStatusChanges: new PgBossConversationStatusChangeSource(
          boss,
        ),
      });
      // This host never executes a turn: every push must cross the database notification seam.
      const observer = new AgentRuntime(root, {
        ...options,
        store: observerStore,
        conversationStatusChanges: new PgBossConversationStatusChangeSource(
          boss,
        ),
      });
      const local: ConversationStatusChange[] = [];
      const subscription = await runtime.subscribeConversationStatus(
        abort.signal,
      );
      consumers.push(
        (async () => {
          try {
            for await (const event of subscription)
              if (event.type === 'change') local.push(event);
          } catch (error) {
            if (!abort.signal.aborted) throw error;
          }
        })(),
      );
      const app = new Hono<HttpEnv>();
      app.use('*', async (context, next) => {
        context.set('userId', context.req.header('x-user') ?? '');
        await next();
      });
      app.route('/runtime', http(observer));
      const listen = async (userId: string) => {
        const events: OwnerEvent[] = [];
        const result = await app.request('/runtime/events', {
          headers: { 'x-user': userId },
          signal: abort.signal,
        });
        assert.equal(result.status, 200);
        assert.ok(result.body);
        const reader = result.body
          .pipeThrough(new TextDecoderStream())
          .getReader();
        readers.push(reader);
        consumers.push(
          (async () => {
            let buffer = '';
            for (;;) {
              const { value, done } = await reader.read();
              if (done) return;
              buffer += value;
              let end: number;
              while ((end = buffer.indexOf('\n\n')) !== -1) {
                const frame = buffer.slice(0, end);
                buffer = buffer.slice(end + 2);
                if (frame.startsWith('data: '))
                  events.push(JSON.parse(frame.slice(6)) as OwnerEvent);
              }
            }
          })(),
        );
        await t.waitFor(() => assert.deepEqual(events[0], { type: 'ready' }));
        return events;
      };
      const ownerEvents = await listen('owner');
      const otherEvents = await listen('other');
      await using worker = await runtime.work({ concurrency: 4 });
      void worker;
      const project = { userId: 'owner', chatId: crypto.randomUUID() };
      const secondProject = { userId: 'owner', chatId: crypto.randomUUID() };
      const otherProject = { userId: 'other', chatId: crypto.randomUUID() };
      const run = async (
        toolName: string,
        input: unknown,
        conversation = project,
      ) => {
        scripted.push(call(toolName, input), text('root done'));
        const turn = await runtime.enqueue(conversation, {
          message: {
            id: crypto.randomUUID(),
            role: 'user',
            parts: [{ type: 'text', text: 'run operation' }],
          },
          trigger: 'submit-message',
        });
        for await (const chunk of turn.stream) {
          assert.ok(chunk.type);
        }
        await t.waitFor(
          async () =>
            assert.equal(await queue.getTurnActivity(conversation), 'idle'),
          { timeout: 10_000 },
        );
        scripted.length = 0;
      };
      const spawn = (
        task_name: string,
        agent_type = 'worker',
        conversation = project,
      ) =>
        run(
          'spawn_agent',
          {
            task_name,
            agent_type,
            message: 'private task content',
            fork_turns: 'none',
          },
          conversation,
        );
      const snapshot = async (conversation = project) => {
        const result = await app.request('/runtime/history', {
          headers: { 'x-user': conversation.userId },
        });
        const history = (await result.json()) as {
          chatId: string;
          children?: ChildProgress[];
        }[];
        return (
          history.find((item) => item.chatId === conversation.chatId)
            ?.children ?? []
        );
      };
      const child = async (path: string) => {
        const found = (await snapshot()).find((entry) => entry.path === path);
        assert.ok(found, `child ${path} is in the project snapshot`);
        return found;
      };
      const state = async (path: string, expected: ChildProgress['state']) =>
        t.waitFor(
          async () => assert.equal((await child(path))?.state, expected),
          { timeout: 10_000 },
        );

      await spawn('research');
      await state('/root/research', 'completed');
      const research = await child('/root/research');
      assert.equal(research.activities.spawn?.actorPath, '/root');
      assert.equal(research.activities.completion?.outcome, 'completed');
      const resultMail = await mailboxStore.drain(project);
      assert.deepEqual(
        resultMail.map((mail) => [mail.type, mail.content]),
        [['FINAL_ANSWER', 'child result']],
      );

      await run('send_message', {
        target: 'research',
        message: 'private message content',
      });
      assert.equal((await child('/root/research'))?.state, 'completed');
      const firstMessage = (await child('/root/research')).activities.message;
      assert.ok(firstMessage);
      await run('send_message', {
        target: 'research',
        message: 'new private message',
      });
      const secondMessage = (await child('/root/research')).activities.message;
      assert.ok(secondMessage);
      assert.notEqual(firstMessage.id, secondMessage.id);
      assert.deepEqual(
        (
          await mailboxStore.drain({ userId: 'owner', chatId: research.chatId })
        ).map((mail) => mail.type),
        ['MESSAGE', 'MESSAGE'],
      );
      assert.ok(research.activities.completion);
      const firstCompletion = research.activities.completion.id;
      await run('followup_task', {
        target: 'research',
        message: 'private followup content',
      });
      await state('/root/research', 'completed');
      const nextCompletion = (await child('/root/research')).activities
        .completion;
      assert.ok(nextCompletion);
      assert.notEqual(nextCompletion.id, firstCompletion);
      assert.equal(
        (await child('/root/research')).activities.followup?.targetPath,
        '/root/research',
      );

      await spawn('blocked', 'blocked');
      await state('/root/blocked', 'running');
      await run('interrupt_agent', { target: 'blocked' });
      await state('/root/blocked', 'interrupted');
      const interrupted = await child('/root/blocked');
      assert.equal(interrupted.activities.interrupt?.actorPath, '/root');
      assert.equal(interrupted.activities.completion?.outcome, 'cancelled');
      await run('interrupt_agent', { target: 'blocked' });
      assert.deepEqual(
        (await child('/root/blocked')).activities,
        interrupted.activities,
      );
      await run('interrupt_agent', { target: 'missing' });
      assert.equal((await snapshot()).length, 2);
      const beforeRejectedOperations = await snapshot();
      await run('spawn_agent', {
        agent_type: 'missing',
        task_name: 'invalid',
        message: 'rejected',
        fork_turns: 'none',
      });
      await run('send_message', { target: 'missing', message: 'rejected' });
      await run('followup_task', { target: '/root', message: 'rejected' });
      assert.deepEqual(await snapshot(), beforeRejectedOperations);

      await spawn('approval', 'approval');
      await state('/root/approval', 'waitingOnApproval');
      assert.equal(
        (await child('/root/approval')).activities.completion,
        undefined,
      );
      await spawn('failed', 'failed');
      await state('/root/failed', 'failed');
      assert.equal(
        (await child('/root/failed')).activities.completion?.outcome,
        'failed',
      );
      await spawn('research', 'worker', secondProject);
      await spawn('research', 'worker', otherProject);

      await t.waitFor(
        () => {
          const childEvents = ownerEvents.filter(
            (event) => event.type === 'change' && event.child,
          );
          for (const kind of [
            'spawn',
            'message',
            'followup',
            'interrupt',
            'completion',
          ]) {
            assert.ok(
              childEvents.some(
                (event) =>
                  event.type === 'change' &&
                  (event.child as ChildProgress).activities[
                    kind as keyof ChildProgress['activities']
                  ],
              ),
            );
          }
          assert.ok(
            childEvents.some(
              (event) =>
                event.type === 'change' &&
                (event.child as ChildProgress).state === 'interrupted',
            ),
          );
          assert.ok(
            otherEvents.some((event) => event.type === 'change' && event.child),
          );
        },
        { timeout: 10_000 },
      );
      assert.ok(local.some((event) => event.child?.state === 'queued'));
      assert.ok(local.some((event) => event.child?.state === 'running'));
      assert.ok(
        local.some(
          (event) => event.child?.activities.message?.id === firstMessage.id,
        ),
      );
      assert.ok(
        local.some(
          (event) => event.child?.activities.message?.id === secondMessage.id,
        ),
      );
      for (const event of ownerEvents)
        if (event.type === 'change' && event.child)
          assert.notEqual(
            (event.child as ChildProgress).treeId,
            otherProject.chatId,
          );
      for (const event of otherEvents)
        if (event.type === 'change' && event.child)
          assert.equal(
            (event.child as ChildProgress).treeId,
            otherProject.chatId,
          );
      assert.equal(JSON.stringify(ownerEvents).includes('private'), false);
      assert.equal((await snapshot()).length, 4);
      assert.equal((await snapshot(secondProject)).length, 1);
      assert.ok(
        (await snapshot()).every(
          (entry) =>
            entry.treeId === project.chatId &&
            Object.keys(entry.activities).length <= 5,
        ),
      );
      using freshDb = new DatabaseSync(contextPath);
      const freshStore = new SqliteContextStore(freshDb);
      const freshRuntime = new AgentRuntime(root, {
        ...options,
        store: freshStore,
      });
      assert.deepEqual(
        (await freshRuntime.listHistory('owner')).find(
          (item) => item.chatId === project.chatId,
        )?.children,
        await snapshot(),
      );
      assert.deepEqual(errors, []);
    } finally {
      abort.abort();
      await Promise.all(readers.map((reader) => reader.cancel()));
      await Promise.all(consumers);
      await boss.stop({ graceful: false });
      await database.close();
      mailboxStore.close();
      streamStore.close();
    }
  },
);
