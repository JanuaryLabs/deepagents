import { PGlite } from '@electric-sql/pglite';
import {
  type ToolSet,
  type UIMessage,
  isToolUIPart,
  simulateReadableStream,
} from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { InMemoryFs } from 'just-bash';
import assert from 'node:assert';
import { describe, it } from 'node:test';
import { PgBoss, fromPglite } from 'pg-boss';
import { z } from 'zod';

import {
  type AgentSandbox,
  InMemoryContextStore,
  SqliteStreamStore,
  createBashTool,
  createVirtualSandbox,
} from '@deepagents/context';

import type { AgentDeclaration } from './agent.ts';
import { PgBossTurnQueue } from './queue/pg-boss.turn-queue.ts';
import { createRuntime } from './runtime.ts';
import { defineTool } from './tool.ts';

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
  return new MockLanguageModelV3({
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
        rawCall: { rawPrompt: undefined, rawSettings: {} },
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
  return new MockLanguageModelV3({
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
        rawCall: { rawPrompt: undefined, rawSettings: {} },
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
  const model = new MockLanguageModelV3({
    doStream: async ({ prompt }) => {
      const text = lastUserText(prompt);
      track.calls.push(text);
      const raw = JSON.stringify(prompt);
      const priorCallsForAsk = track.calls.filter((c) => c === text).length;

      let chunks;
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
        rawCall: { rawPrompt: undefined, rawSettings: {} },
      };
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

async function harness(model: AgentDeclaration['model'], tools?: ToolSet) {
  const pglite = new PGlite();
  const boss = new PgBoss({ db: fromPglite(pglite), backend: 'pglite' });
  boss.on('error', () => {});
  await boss.start();
  const queue = new PgBossTurnQueue(boss, { pollingIntervalSeconds: 0.5 });
  await queue.initialize();
  const streamStore = new SqliteStreamStore(':memory:');
  const runtime = createRuntime(declaration(model, tools), {
    store: new InMemoryContextStore(),
    streamStore,
    queue,
  });
  return {
    runtime,
    streamStore,
    boss,
    queue,
    async [Symbol.asyncDispose]() {
      await boss.stop({ graceful: false });
      await pglite.close();
      streamStore.close();
    },
  };
}

async function collectText(stream: ReadableStream) {
  let text = '';
  const types: string[] = [];
  for await (const part of stream as ReadableStream<{
    type: string;
    delta?: string;
  }>) {
    types.push(part.type);
    if (part.type === 'text-delta') text += part.delta ?? '';
  }
  return { text, types };
}

async function waitForStatus(
  streamStore: SqliteStreamStore,
  id: string,
  accept: string[],
  timeoutMs = 10_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await streamStore.getStreamStatus(id);
    if (status && accept.includes(status)) return status;
    await sleep(25);
  }
  throw new Error(`timed out waiting for ${accept.join('/')} on ${id}`);
}

describe('zukhruf runtime — background executor', () => {
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
    const { text } = await collectText(resumed);
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
    assert.equal(a.text, 'reply:one');
    assert.equal(b.text, 'reply:two');
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
      a.text,
      'opened reply:gate-wait',
      'first turn finished only after the second started — chats overlap',
    );
    assert.equal(b.text, 'reply:gate-open');
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
    assert.equal(a.text, 'reply:once');
    assert.equal(b.text, 'reply:once');
    assert.deepStrictEqual(track.calls, ['once'], 'model ran exactly once');

    const resubmit = await h.runtime.enqueue(conversation, {
      id: ask.id,
      input: 'a different input under the same id',
    });
    const { text } = await collectText(resubmit.stream);
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
    const { text } = await collectText(stream);

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
    const ask = turn('send it');
    await collectText((await h.runtime.enqueue(conversation, ask)).stream);
    const { part } = await pausedToolCall(h.runtime, conversation);

    const resumed = await h.runtime.approve(conversation, {
      toolCallId: part.toolCallId,
    });
    assert.equal(resumed.id, ask.id, 'continuation reuses the turn id');
    const { text } = await collectText(resumed.stream);
    assert.equal(text, 'done:send it');

    assert.equal(track.toolRuns, 1, 'tool executed exactly once');
    const messages = await h.runtime.observe(conversation).engine.getMessages();
    assert.equal(messages.length, 2, 'one user + ONE assistant message');
    const final = messages.at(-1)!;
    const toolPart = final.parts.find(isToolUIPart)!;
    assert.equal(toolPart.state, 'output-available');
    assert.equal(toolPart.output, 'sent:a@b.c');
    assert.equal(await h.streamStore.getStreamStatus(ask.id), 'completed');
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

    const resumed = await h.runtime.deny(conversation, {
      toolCallId: part.toolCallId,
      reason: 'not today',
    });
    const { text } = await collectText(resumed.stream);
    assert.equal(text, 'denied:send it');
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

    const resumed = await h.runtime.approve(conversation, {
      toolCallId: part.toolCallId,
    });
    const [continuation, b, c] = await Promise.all([
      collectText(resumed.stream),
      collectText(second.stream),
      collectText(third.stream),
    ]);
    assert.equal(continuation.text, 'done:send it');
    assert.equal(b.text, 'reply:two');
    assert.equal(c.text, 'reply:three');
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

    const [a, b] = await Promise.all([
      collectText(first.stream),
      collectText(again.stream),
    ]);
    assert.equal(a.text, 'done:send it');
    assert.equal(b.text, 'done:send it');
    assert.equal(track.toolRuns, 1, 'tool executed exactly once');
  });

  it('a paused turn leaves no queue job, and approving cleans up the continuation too', async () => {
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

    const resumed = await h.runtime.approve(conversation, {
      toolCallId: part.toolCallId,
    });
    await collectText(resumed.stream);
    await sleep(400);

    const afterApprove = await h.boss.findJobs(h.queue.queue, {
      key: 'gc-pause',
    });
    assert.deepStrictEqual(
      afterApprove.map((j) => j.state),
      [],
      'the continuation job is deleted once it commits — nothing accumulates',
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

    const resumed = await h.runtime.deny(conversation, {
      toolCallId: part.toolCallId,
      reason: 'nope',
    });
    const { text } = await collectText(resumed.stream);
    assert.equal(text, 'denied:send it');
    assert.equal(track.toolRuns, 0, 'tool never ran');
    await sleep(400);

    const jobs = await h.boss.findJobs(h.queue.queue, { key: 'gc-deny' });
    assert.deepStrictEqual(
      jobs.map((j) => j.state),
      [],
      'denied continuation commits and its job is deleted',
    );
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

    const resumed = await h.runtime.approve(conversation, {
      toolCallId: part.toolCallId,
    });
    const [cont, b, c, d] = await Promise.all([
      collectText(resumed.stream),
      collectText(second.stream),
      collectText(third.stream),
      collectText(fourth.stream),
    ]);
    assert.equal(cont.text, 'done:send it');
    assert.equal(b.text, 'reply:two');
    assert.equal(c.text, 'reply:three');
    assert.equal(d.text, 'reply:four');
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
    const resumed = await h.runtime.approve(conversation, {
      toolCallId: part.toolCallId,
    });
    assert.equal((await collectText(resumed.stream)).text, 'done:send it');
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

    const resumed = await h.runtime.approve(conversation, {
      toolCallId: part.toolCallId,
    });
    assert.equal((await collectText(resumed.stream)).text, 'done:send it');
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

    // Fire two approves in parallel: one wins manager.reopen, the other loses
    // the race and reattaches (runtime.ts catch branch). Outcome is invariant.
    const [a, b] = await Promise.all([
      h.runtime.approve(conversation, { toolCallId: part.toolCallId }),
      h.runtime.approve(conversation, { toolCallId: part.toolCallId }),
    ]);
    assert.equal(a.id, b.id, 'both approves resolve to the same turn');
    await Promise.all([collectText(a.stream), collectText(b.stream)]);
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
      'no duplicate or leftover continuation jobs',
    );
  });

  it('approve and deny reject when there is no matching paused approval', async () => {
    const { tools, model } = approvalSetup();
    await using h = await harness(model, tools);
    await using _worker = await h.runtime.work();

    const conversation = { chatId: 'gc-apprerr', userId: 'u1' };
    await assert.rejects(
      h.runtime.approve(conversation, { toolCallId: 'whatever' }),
      /no paused turn/,
      'approve with no turn at all rejects',
    );

    await collectText(
      (await h.runtime.enqueue(conversation, turn('send it'))).stream,
    );
    await pausedToolCall(h.runtime, conversation);
    await assert.rejects(
      h.runtime.deny(conversation, { toolCallId: 'wrong-id' }),
      /no tool call/,
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
    const { text } = await collectText(next.stream);
    assert.equal(text, 'reply:after', 'chat unblocked after the failure');
    assert.equal(await h.streamStore.getStreamStatus(crashed.id), 'failed');
  });
});
