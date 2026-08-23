import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import assert from 'node:assert/strict';
import { mkdtempDisposable, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';

import type { AgentModel, AgentSandbox } from '@deepagents/context';
import {
  InMemoryContextStore,
  PollingChangeSource,
  SqliteStreamStore,
  StreamManager,
} from '@deepagents/context';
import { createFileTelemetry } from '@deepagents/context/telemetry/file';
import { devtool } from '@deepagents/devtool';
import {
  AgentRuntime,
  type ConsumeContext,
  type ConsumeOptions,
  SqliteMailboxStore,
  type TurnActivity,
  type TurnPushResult,
  TurnQueue,
  type TurnRef,
  ZUKHRUF_HISTORY_ROUTE_PATH,
  ZUKHRUF_INFO_ROUTE_PATH,
  defineAgent,
  defineTool,
} from '@deepagents/experimental/zukhruf';

const declaration = defineAgent({
  name: 'devtool-test',
  model: { provider: 'test', modelId: 'test' } as AgentModel,
  sandbox: async () => ({}) as AgentSandbox,
  instructions: [],
});

class IdleTurnQueue extends TurnQueue {
  readonly #onConsume?: () => void;
  readonly #onDispose?: () => void;

  constructor(hooks?: { onConsume?: () => void; onDispose?: () => void }) {
    super();
    this.#onConsume = hooks?.onConsume;
    this.#onDispose = hooks?.onDispose;
  }

  push(): Promise<TurnPushResult> {
    throw new Error('IdleTurnQueue cannot enqueue turns');
  }

  getTurnActivity(): Promise<TurnActivity> {
    return Promise.resolve('idle');
  }

  getCurrentTurn(): Promise<undefined> {
    return Promise.resolve(undefined);
  }

  cancel(): Promise<void> {
    return Promise.resolve();
  }

  consume(): Promise<AsyncDisposable> {
    this.#onConsume?.();
    return Promise.resolve({
      [Symbol.asyncDispose]: () => {
        this.#onDispose?.();
        return Promise.resolve();
      },
    });
  }

  resumeParked(): Promise<void> {
    return Promise.resolve();
  }
}

class ControlledTurnQueue extends TurnQueue {
  readonly #turns: TurnRef[] = [];
  #handler?: (turn: TurnRef, context: ConsumeContext) => Promise<void>;
  #options?: ConsumeOptions;

  push(turn: TurnRef): Promise<TurnPushResult> {
    this.#turns.push(turn);
    return Promise.resolve({ jobId: turn.streamId, inserted: true });
  }

  getTurnActivity(): Promise<TurnActivity> {
    return Promise.resolve(this.#turns.length === 0 ? 'idle' : 'queued');
  }

  getCurrentTurn(): Promise<TurnRef | undefined> {
    return Promise.resolve(this.#turns[0]);
  }

  cancel(streamId: string): Promise<void> {
    const index = this.#turns.findIndex((turn) => turn.streamId === streamId);
    if (index >= 0) this.#turns.splice(index, 1);
    return Promise.resolve();
  }

  consume(
    handler: (turn: TurnRef, context: ConsumeContext) => Promise<void>,
    options: ConsumeOptions,
  ): Promise<AsyncDisposable> {
    this.#handler = handler;
    this.#options = options;
    return Promise.resolve({
      [Symbol.asyncDispose]: () => {
        this.#handler = undefined;
        this.#options = undefined;
        return Promise.resolve();
      },
    });
  }

  resumeParked(): Promise<void> {
    return Promise.resolve();
  }

  async runNext(): Promise<void> {
    const turn = this.#turns.shift();
    assert(turn, 'expected a queued turn');
    assert(this.#handler, 'expected a running queue consumer');
    try {
      await this.#handler(turn, {
        signal: new AbortController().signal,
        park: () => Promise.resolve(),
      });
      await this.#options?.onSettled?.(turn);
    } catch (error) {
      await this.#options?.onOrphaned(
        turn,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
}

test('devtool rejects non-loopback listeners', () => {
  assert.throws(
    () => devtool({ hostname: '0.0.0.0' as '127.0.0.1' }),
    /devtool hostname must be a loopback address/,
  );
});

test('devtool participates in the AgentRuntime lifecycle', async () => {
  await using resources = new AsyncDisposableStack();
  const streamStore = resources.adopt(
    new SqliteStreamStore(':memory:'),
    (value) => value.close(),
  );
  const mailboxStore = resources.use(new SqliteMailboxStore(':memory:'));
  const plugin = devtool({ port: 0 });
  const store = new InMemoryContextStore();
  const runtimeOptions = {
    store,
    streams: new StreamManager({
      store: streamStore,
      changeSource: new PollingChangeSource({ reads: streamStore }),
    }),
    queue: new IdleTurnQueue({
      onConsume: () => assert(plugin.url),
      onDispose: () => assert(plugin.url),
    }),
    mailboxStore,
    plugins: [plugin],
  };
  const runtime = new AgentRuntime(declaration, runtimeOptions);
  await runtime.createSession({ chatId: 'chat-1', userId: 'user-1' });
  await store.updateChat('chat-1', () => ({ title: 'First conversation' }));
  await store.upsertChat({ id: 'unrelated-chat', userId: 'user-1' });

  const worker = await runtime.work();
  assert(plugin.url);

  const response = await fetch(new URL('/health', plugin.url));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });

  const discoveryResponse = await fetch(
    new URL(ZUKHRUF_INFO_ROUTE_PATH, plugin.url),
  );
  assert.equal(discoveryResponse.status, 200);
  assert.deepEqual(
    (await discoveryResponse.json()) as Record<string, unknown>,
    {
      ...runtime.info,
      capabilities: {
        history: { href: ZUKHRUF_HISTORY_ROUTE_PATH },
      },
    },
  );
  assert.equal(
    (
      await fetch(
        new URL('/api/history/chat-1/traces?userId=user-1', plugin.url),
      )
    ).status,
    404,
  );

  const historyResponse = await fetch(
    new URL(ZUKHRUF_HISTORY_ROUTE_PATH, plugin.url),
  );
  assert.equal(historyResponse.status, 200);
  const history = (await historyResponse.json()) as Record<string, unknown>[];
  assert.equal(history.length, 1);
  const [{ createdAt, updatedAt, ...entry }] = history;
  assert.equal(typeof createdAt, 'number');
  assert.equal(typeof updatedAt, 'number');
  assert.deepEqual(entry, {
    chatId: 'chat-1',
    userId: 'user-1',
    title: 'First conversation',
    messageCount: 0,
    status: 'idle',
  });

  const shellResponse = await fetch(plugin.url);
  assert.equal(shellResponse.status, 200);
  const shell = await shellResponse.text();
  assert.match(shell, /<title>Zukhruf Devtool<\/title>/);
  const assets = Array.from(
    shell.matchAll(/(?:src|href)="(\.\/assets\/[^"]+)"/g),
    ([, asset]) => asset,
  );
  assert(assets.length > 0);
  for (const asset of assets) {
    const assetResponse = await fetch(new URL(asset, plugin.url));
    assert.equal(assetResponse.status, 200);
    assert((await assetResponse.arrayBuffer()).byteLength > 0);
  }

  await assert.rejects(
    new AgentRuntime(declaration, runtimeOptions).initialize(),
    /devtool plugin cannot be shared by AgentRuntime instances/,
  );

  const conflictingPlugin = devtool({
    port: Number(plugin.url.port),
  });
  await assert.rejects(
    new AgentRuntime(declaration, {
      ...runtimeOptions,
      plugins: [conflictingPlugin],
    }).work(),
    { code: 'EADDRINUSE' },
  );
  assert.equal(conflictingPlugin.url, undefined);

  await worker[Symbol.asyncDispose]();
  assert.equal(plugin.url, undefined);
  await assert.rejects(
    fetch(response.url, { signal: AbortSignal.timeout(1_000) }),
  );
});

test('devtool persists conversation-scoped traces from a public AgentRuntime turn', async () => {
  await using directory = await mkdtempDisposable(
    join(tmpdir(), 'deepagents-devtool-'),
  );
  const telemetry = join(directory.path, 'telemetry.jsonl');
  await using resources = new AsyncDisposableStack();
  const streamStore = resources.adopt(
    new SqliteStreamStore(':memory:'),
    (value) => value.close(),
  );
  const mailboxStore = resources.use(new SqliteMailboxStore(':memory:'));
  const store = new InMemoryContextStore();
  const streams = new StreamManager({
    store: streamStore,
    changeSource: new PollingChangeSource({ reads: streamStore }),
  });
  const usage = {
    inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 5, text: 5, reasoning: 0 },
  } as const;
  let modelCall = 0;
  const model = new MockLanguageModelV4({
    provider: 'test-provider',
    modelId: 'trace-model',
    doStream: async () => {
      modelCall += 1;
      if (modelCall === 3) throw new Error('model exploded');
      const chunks: LanguageModelV4StreamPart[] =
        modelCall === 1
          ? [
              {
                type: 'tool-call',
                toolCallId: 'tool-1',
                toolName: 'lookup',
                input: '{"query":"status"}',
              },
              {
                type: 'finish',
                finishReason: { unified: 'tool-calls', raw: 'tool-calls' },
                usage,
              },
            ]
          : [
              { type: 'text-start', id: 'text-1' },
              {
                type: 'text-delta',
                id: 'text-1',
                delta: 'All systems go.',
              },
              { type: 'text-end', id: 'text-1' },
              {
                type: 'finish',
                finishReason: { unified: 'stop', raw: 'stop' },
                usage,
              },
            ];
      return { stream: simulateReadableStream({ chunks }) };
    },
  });
  const root = defineAgent({
    name: 'trace-agent',
    model,
    sandbox: async () => ({}) as AgentSandbox,
    instructions: [],
    telemetry: {
      isEnabled: true,
      recordInputs: false,
      recordOutputs: true,
      integrations: createFileTelemetry({
        path: telemetry,
        append: false,
      }),
    },
    tools: {
      lookup: defineTool({
        description: 'Look up system status.',
        inputSchema: z.object({ query: z.string() }),
        execute: async ({ query }) => ({ query, status: 'ok' }),
      }),
    },
  });
  const plugin = devtool({ port: 0 });
  const queue = new ControlledTurnQueue();
  const runtime = new AgentRuntime(root, {
    store,
    streams,
    queue,
    mailboxStore,
    plugins: [plugin],
  });
  assert.equal(root.telemetry?.includeRuntimeContext, undefined);
  const worker = await runtime.work();
  const conversation = { chatId: 'chat-1', userId: 'user-1' };
  await runtime.createSession(conversation);
  const turn = await runtime.enqueue(conversation, {
    id: 'message-1',
    input: 'Check the system.',
  });
  await queue.runNext();
  assert.equal(
    (await runtime.observe(conversation).status(turn.id))?.status,
    'completed',
  );
  assert(plugin.url);
  const records = (await readFile(telemetry, 'utf8'))
    .trim()
    .split('\n')
    .map(
      (line) =>
        JSON.parse(line) as {
          event: string;
          data: Record<string, unknown>;
        },
    );
  const start = records.find(({ event }) => event === 'onStart');
  assert(start);
  assert.deepEqual(start.data.zukhruf, {
    conversation,
    streamId: turn.id,
    agentName: 'trace-agent',
    agentPath: '/root',
  });
  assert.equal(start.data.runtimeContext, '[Redacted]');

  const discovery = (await (
    await fetch(new URL(ZUKHRUF_INFO_ROUTE_PATH, plugin.url))
  ).json()) as {
    traces: { path: string };
  };
  assert.deepEqual(discovery.traces, {
    path: pathToFileURL(telemetry).href,
  });
  const listUrl = new URL(
    '/api/history/chat-1/traces?userId=user-1',
    plugin.url,
  );
  const listResponse = await fetch(listUrl);
  assert.equal(listResponse.status, 200);
  const traces = (await listResponse.json()) as Array<Record<string, unknown>>;
  assert.equal(traces.length, 1);

  assert.deepEqual(
    {
      streamId: traces[0].streamId,
      agentName: traces[0].agentName,
      agentPath: traces[0].agentPath,
      status: traces[0].status,
      stepCount: traces[0].stepCount,
      finishReason: traces[0].finishReason,
      usage: traces[0].usage,
      recording: traces[0].recording,
    },
    {
      streamId: turn.id,
      agentName: 'trace-agent',
      agentPath: '/root',
      status: 'completed',
      stepCount: 2,
      finishReason: 'stop',
      usage: { inputTokens: 20, outputTokens: 10 },
      recording: { inputs: 'not-recorded', outputs: 'recorded' },
    },
  );

  const traceUrl = new URL(
    `/api/history/chat-1/traces/${String(traces[0].id)}?userId=user-1`,
    plugin.url,
  );
  const traceResponse = await fetch(traceUrl);
  assert.equal(traceResponse.status, 200);
  const trace = (await traceResponse.json()) as {
    spans: Array<{
      id: string;
      type: string;
      parentId: string | null;
      input?: unknown;
      output?: unknown;
    }>;
  };
  assert.deepEqual(
    trace.spans.map(({ type }) => type),
    ['agent', 'generation', 'function', 'generation'],
  );
  assert.equal(trace.spans[0].parentId, null);
  assert.equal(trace.spans[1].parentId, trace.spans[0].id);
  assert.equal(trace.spans[2].parentId, trace.spans[1].id);
  assert.equal(trace.spans[3].parentId, trace.spans[0].id);
  assert(trace.spans.every((span) => span.input === undefined));
  assert(trace.spans.some((span) => span.output !== undefined));

  const failedTurn = await runtime.enqueue(conversation, {
    id: 'message-2',
    input: 'Fail this turn.',
  });
  await queue.runNext();
  assert.equal(
    (await runtime.observe(conversation).status(failedTurn.id))?.status,
    'failed',
  );
  const failedTraces = (await (await fetch(listUrl)).json()) as Array<
    Record<string, unknown>
  >;
  const failedTrace = failedTraces.find(
    ({ streamId }) => streamId === failedTurn.id,
  );
  assert(failedTrace);
  assert.equal(failedTrace.status, 'failed');
  const failedTraceUrl = new URL(
    `/api/history/chat-1/traces/${String(failedTrace.id)}?userId=user-1`,
    plugin.url,
  );
  const failedDetail = (await (await fetch(failedTraceUrl)).json()) as {
    spans: Array<{ type: string; status: string; error?: unknown }>;
  };
  assert.deepEqual(
    failedDetail.spans
      .filter(({ status }) => status === 'failed')
      .map(({ type }) => type),
    ['agent', 'generation'],
  );
  assert.match(JSON.stringify(failedDetail), /model exploded/);

  const isolatedUrl = new URL(
    '/api/history/missing-chat/traces?userId=user-1',
    plugin.url,
  );
  assert.equal((await fetch(isolatedUrl)).status, 404);

  await worker[Symbol.asyncDispose]();

  const restartedPlugin = devtool({ port: 0 });
  const restarted = new AgentRuntime(root, {
    store,
    streams,
    queue: new ControlledTurnQueue(),
    mailboxStore,
    plugins: [restartedPlugin],
  });
  const restartedWorker = await restarted.work();
  assert(restartedPlugin.url);
  const restartedUrl = new URL(
    '/api/history/chat-1/traces?userId=user-1',
    restartedPlugin.url,
  );
  const restartedResponse = await fetch(restartedUrl);
  assert.equal(restartedResponse.status, 200);
  assert.equal(((await restartedResponse.json()) as unknown[]).length, 2);
  await restartedWorker[Symbol.asyncDispose]();
});
