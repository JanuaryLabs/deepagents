import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { serve } from '@hono/node-server';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { Hono } from 'hono';
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
import { type Devtool, devtool } from '@deepagents/devtool';
import {
  AgentRuntime,
  type ConsumeContext,
  type ConsumeOptions,
  SqliteMailboxStore,
  type TurnActivity,
  type TurnPushResult,
  TurnQueue,
  type TurnRef,
  ZUKHRUF_CREATE_SESSION_ROUTE_PATH,
  ZUKHRUF_HISTORY_ROUTE_PATH,
  ZUKHRUF_INFO_ROUTE_PATH,
  ZUKHRUF_ROUTE_PREFIX,
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
  assert.throws(
    () => devtool({ runtime: { url: 'file:///tmp/runtime' } }),
    /runtime URL must use HTTP or HTTPS/,
  );
  assert.throws(
    () => devtool({ runtime: { url: 'https://user:secret@example.com' } }),
    /runtime URL must not contain credentials/,
  );
});

test('devtool participates in the AgentRuntime lifecycle', async () => {
  await using resources = new AsyncDisposableStack();
  const streamStore = resources.adopt(
    new SqliteStreamStore(':memory:'),
    (value) => value.close(),
  );
  const mailboxStore = resources.use(new SqliteMailboxStore(':memory:'));
  const definition = devtool({ port: 0 });
  const store = new InMemoryContextStore();
  const lifecycle = { plugin: undefined as Devtool | undefined };
  const runtimeOptions = {
    store,
    streams: new StreamManager({
      store: streamStore,
      changeSource: new PollingChangeSource({ reads: streamStore }),
    }),
    queue: new IdleTurnQueue({
      onConsume: () => assert(lifecycle.plugin?.url),
      onDispose: () => assert(lifecycle.plugin?.url),
    }),
    mailboxStore,
  };
  const root = defineAgent({ ...declaration, plugins: [definition] });
  const runtime = new AgentRuntime(root, runtimeOptions);
  const plugin = runtime.plugin(definition);
  lifecycle.plugin = plugin;
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
    shell.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g),
    ([, asset]) => asset,
  );
  assert(assets.length > 0);
  for (const asset of assets) {
    const assetResponse = await fetch(new URL(asset, plugin.url));
    assert.equal(assetResponse.status, 200);
    assert((await assetResponse.arrayBuffer()).byteLength > 0);
  }
  const clientRoute = await fetch(new URL('/future-client-route', plugin.url));
  assert.equal(clientRoute.status, 200);
  assert.match(await clientRoute.text(), /<title>Zukhruf Devtool<\/title>/);
  for (const path of [
    '/assets/missing.js',
    '/api/missing',
    `${ZUKHRUF_ROUTE_PREFIX}/missing`,
    '/health/missing',
  ]) {
    assert.equal((await fetch(new URL(path, plugin.url))).status, 404);
  }

  const secondRuntime = new AgentRuntime(root, runtimeOptions);
  assert.notEqual(secondRuntime.plugin(definition), plugin);

  const conflictingDefinition = devtool({
    port: Number(plugin.url.port),
  });
  const conflictingRuntime = new AgentRuntime(
    defineAgent({ ...declaration, plugins: [conflictingDefinition] }),
    runtimeOptions,
  );
  const conflictingPlugin = conflictingRuntime.plugin(conflictingDefinition);
  await assert.rejects(conflictingRuntime.work(), { code: 'EADDRINUSE' });
  assert.equal(conflictingPlugin.url, undefined);

  await worker[Symbol.asyncDispose]();
  assert.equal(plugin.url, undefined);
  await assert.rejects(
    fetch(response.url, { signal: AbortSignal.timeout(1_000) }),
  );
});

test('devtool proxies authenticated Zukhruf chat HTTP without exposing credentials', async () => {
  const sessionId = '9d1f5c40-f250-5aa9-8979-2e0ef4fc2c15';
  const requests: Array<{
    path: string;
    method: string;
    authorization: string | undefined;
    cookie: string | undefined;
    idempotencyKey: string | undefined;
    body: unknown;
  }> = [];
  const upstream = new Hono();
  upstream.all('/zukhruf/v1/session*', async (context) => {
    requests.push({
      path: context.req.path,
      method: context.req.method,
      authorization: context.req.header('authorization'),
      cookie: context.req.header('cookie'),
      idempotencyKey: context.req.header('idempotency-key'),
      body:
        context.req.method === 'POST' &&
        context.req.header('content-type') === 'application/json'
          ? await context.req.json()
          : undefined,
    });
    if (
      context.req.method === 'POST' &&
      context.req.path === ZUKHRUF_CREATE_SESSION_ROUTE_PATH
    ) {
      return context.json({ ok: true, sessionId, turnId: 'turn-1' }, 202, {
        'set-cookie': 'upstream-secret=hidden',
      });
    }
    if (
      context.req.method === 'GET' &&
      context.req.path === `/zukhruf/v1/session/${sessionId}`
    ) {
      return context.json({ sessionId, messages: [] });
    }
    if (
      context.req.method === 'GET' &&
      context.req.path === `/zukhruf/v1/session/${sessionId}/stream`
    ) {
      return new Response(
        'data: {"type":"text-start","id":"text-1"}\n\n' +
          'data: {"type":"text-delta","id":"text-1","delta":"Hello"}\n\n' +
          'data: {"type":"text-end","id":"text-1"}\n\n' +
          'data: [DONE]\n\n',
        {
          headers: {
            'content-type': 'text/event-stream',
            'x-vercel-ai-ui-message-stream': 'v1',
          },
        },
      );
    }
    if (
      context.req.method === 'POST' &&
      context.req.path === `/zukhruf/v1/session/${sessionId}/cancel`
    ) {
      return context.body(null, 204);
    }
    return context.notFound();
  });
  const upstreamStarted = Promise.withResolvers<URL>();
  const upstreamServer = serve(
    { fetch: upstream.fetch, hostname: '127.0.0.1', port: 0 },
    ({ address, port }) =>
      upstreamStarted.resolve(new URL(`http://${address}:${port}/`)),
  );
  await using resources = new AsyncDisposableStack();
  resources.use(upstreamServer);
  const upstreamUrl = await upstreamStarted.promise;

  const streamStore = resources.adopt(
    new SqliteStreamStore(':memory:'),
    (value) => value.close(),
  );
  const mailboxStore = resources.use(new SqliteMailboxStore(':memory:'));
  const definition = devtool({
    port: 0,
    runtime: {
      url: upstreamUrl,
      headers: async () => ({ authorization: 'Bearer server-token' }),
    },
  });
  const runtime = new AgentRuntime(
    defineAgent({ ...declaration, plugins: [definition] }),
    {
      store: new InMemoryContextStore(),
      streams: new StreamManager({
        store: streamStore,
        changeSource: new PollingChangeSource({ reads: streamStore }),
      }),
      queue: new IdleTurnQueue(),
      mailboxStore,
    },
  );
  const plugin = runtime.plugin(definition);
  resources.use(await runtime.work());
  assert(plugin.url);

  const discovery = (await (
    await fetch(new URL(ZUKHRUF_INFO_ROUTE_PATH, plugin.url))
  ).json()) as { capabilities: { chat?: { href: string } } };
  assert.deepEqual(discovery.capabilities.chat, {
    href: ZUKHRUF_CREATE_SESSION_ROUTE_PATH,
  });

  const createResponse = await fetch(
    new URL(ZUKHRUF_CREATE_SESSION_ROUTE_PATH, plugin.url),
    {
      method: 'POST',
      headers: {
        authorization: 'Bearer browser-token',
        cookie: 'browser-secret=hidden',
        'content-type': 'application/json',
        'idempotency-key': 'message-1',
      },
      body: JSON.stringify({ input: 'Hello' }),
    },
  );
  assert.equal(createResponse.status, 202);
  assert.equal(createResponse.headers.get('set-cookie'), null);
  assert.deepEqual(await createResponse.json(), {
    ok: true,
    sessionId,
    turnId: 'turn-1',
  });

  const sessionResponse = await fetch(
    new URL(`/zukhruf/v1/session/${sessionId}`, plugin.url),
  );
  assert.equal(sessionResponse.status, 200);
  assert.deepEqual(await sessionResponse.json(), { sessionId, messages: [] });

  const streamResponse = await fetch(
    new URL(`/zukhruf/v1/session/${sessionId}/stream`, plugin.url),
  );
  assert.equal(streamResponse.status, 200);
  assert.match(await streamResponse.text(), /"delta":"Hello"/);

  const cancelResponse = await fetch(
    new URL(`/zukhruf/v1/session/${sessionId}/cancel`, plugin.url),
    { method: 'POST' },
  );
  assert.equal(cancelResponse.status, 204);
  assert.deepEqual(
    requests.map(({ path, method }) => ({ path, method })),
    [
      { path: ZUKHRUF_CREATE_SESSION_ROUTE_PATH, method: 'POST' },
      { path: `/zukhruf/v1/session/${sessionId}`, method: 'GET' },
      { path: `/zukhruf/v1/session/${sessionId}/stream`, method: 'GET' },
      { path: `/zukhruf/v1/session/${sessionId}/cancel`, method: 'POST' },
    ],
  );
  assert(
    requests.every(
      ({ authorization, cookie }) =>
        authorization === 'Bearer server-token' && cookie === undefined,
    ),
  );
  assert.equal(requests[0].idempotencyKey, 'message-1');
  assert.deepEqual(requests[0].body, { input: 'Hello' });
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
  const definition = devtool({ port: 0 });
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
    plugins: [definition],
  });
  const queue = new ControlledTurnQueue();
  const runtime = new AgentRuntime(root, {
    store,
    streams,
    queue,
    mailboxStore,
  });
  const plugin = runtime.plugin(definition);
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

  const restarted = new AgentRuntime(root, {
    store,
    streams,
    queue: new ControlledTurnQueue(),
    mailboxStore,
  });
  const restartedPlugin = restarted.plugin(definition);
  assert.notEqual(restartedPlugin, plugin);
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
