import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';
import {
  ATTR_GEN_AI_AGENT_NAME,
  ATTR_GEN_AI_OPERATION_NAME,
  ATTR_GEN_AI_RESPONSE_FINISH_REASONS,
  ATTR_SESSION_ID,
  ATTR_USER_ID,
} from '@opentelemetry/semantic-conventions/incubating';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { Hono } from 'hono';
import assert from 'node:assert/strict';
import { mkdtempDisposable, readFile, writeFile } from 'node:fs/promises';
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
import {
  FileTraceAdapter,
  fileTelemetry,
  tracesHttp,
} from '@deepagents/devtool/traces';
import {
  type AgentDeclaration,
  type AgentHost,
  AgentRuntime,
  type ConsumeContext,
  type ConsumeOptions,
  SqliteMailboxStore,
  type TurnActivity,
  TurnQueue,
  type TurnRef,
  defineAgent,
  defineStack,
  defineTool,
} from '@deepagents/experimental/zukhruf';
import {
  type HttpEnv,
  type HttpProjection,
  http,
} from '@deepagents/experimental/zukhruf/http';

const USER_HEADER = 'x-test-user';
const ZUKHRUF_MOUNT_PATH = '/zukhruf/v1';
const INFO_URL = `${ZUKHRUF_MOUNT_PATH}/info`;
const TRACES_HREF = `${ZUKHRUF_MOUNT_PATH}/traces`;

class ControlledTurnQueue extends TurnQueue {
  readonly #turns: TurnRef[] = [];
  #active?: { turn: TurnRef; abort: AbortController };
  #handler?: (turn: TurnRef, context: ConsumeContext) => Promise<void>;
  #options?: ConsumeOptions;

  push(turn: TurnRef): Promise<void> {
    this.#turns.push(turn);
    return Promise.resolve();
  }

  getTurnActivity(): Promise<TurnActivity> {
    return Promise.resolve(
      this.#active ? 'running' : this.#turns.length === 0 ? 'idle' : 'queued',
    );
  }

  getCurrentTurn(): Promise<TurnRef | undefined> {
    return Promise.resolve(this.#active?.turn ?? this.#turns[0]);
  }

  cancel(streamId: string): Promise<void> {
    if (this.#active?.turn.streamId === streamId) this.#active.abort.abort();
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
    const abort = new AbortController();
    this.#active = { turn, abort };
    try {
      await this.#handler(turn, {
        signal: abort.signal,
        park: () => Promise.resolve(),
      });
      await this.#options?.onSettled?.(turn);
    } catch (error) {
      await this.#options?.onOrphaned(
        turn,
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      this.#active = undefined;
    }
  }
}

function createStores(resources: AsyncDisposableStack) {
  const streamStore = resources.adopt(
    new SqliteStreamStore(':memory:'),
    (value) => value.close(),
  );
  return {
    store: new InMemoryContextStore(),
    streams: new StreamManager({
      store: streamStore,
      changeSource: new PollingChangeSource({ reads: streamStore }),
    }),
    mailboxStore: resources.use(new SqliteMailboxStore(':memory:')),
  };
}

function createHost(runtime: AgentHost, ...projections: HttpProjection[]) {
  const app = new Hono<HttpEnv>();
  app.use(`${ZUKHRUF_MOUNT_PATH}/*`, (context, next) => {
    const userId = context.req.header(USER_HEADER);
    if (userId) context.set('userId', userId);
    return next();
  });
  app.route(ZUKHRUF_MOUNT_PATH, http(runtime, ...projections));
  return app;
}

function asUser(userId: string) {
  return { headers: { [USER_HEADER]: userId } };
}

async function readCapabilities(app: Hono<HttpEnv>, userId: string) {
  const response = await app.request(INFO_URL, asUser(userId));
  assert.equal(response.status, 200);
  const body = await response.text();
  return {
    body,
    capabilities: (
      JSON.parse(body) as { capabilities: Record<string, { href: string }> }
    ).capabilities,
  };
}

function createTraceModel() {
  const usage = {
    inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 5, text: 5, reasoning: 0 },
  } as const;
  let modelCall = 0;
  return new MockLanguageModelV4({
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
}

function createSlowTraceModel() {
  return new MockLanguageModelV4({
    provider: 'test-provider',
    modelId: 'slow-trace-model',
    doStream: async () => ({
      stream: simulateReadableStream({
        initialDelayInMs: 1_000,
        chunkDelayInMs: 1_000,
        chunks: [
          { type: 'text-start', id: 'text-1' },
          { type: 'text-delta', id: 'text-1', delta: 'Too late.' },
          { type: 'text-end', id: 'text-1' },
          {
            type: 'finish',
            finishReason: { unified: 'stop', raw: 'stop' },
            usage: {
              inputTokens: {
                total: 1,
                noCache: 1,
                cacheRead: 0,
                cacheWrite: 0,
              },
              outputTokens: { total: 1, text: 1, reasoning: 0 },
            },
          },
        ],
      }),
    }),
  });
}

function createDeclaration(
  plugins: AgentDeclaration['plugins'] = [],
  telemetry?: AgentDeclaration['telemetry'],
  overrides: Partial<AgentDeclaration> = {},
) {
  return defineAgent({
    name: 'trace-agent',
    model: { provider: 'test', modelId: 'test' } as AgentModel,
    sandbox: async () => ({}) as AgentSandbox,
    instructions: [],
    telemetry,
    plugins,
    ...overrides,
  });
}

test('fileTelemetry() composes plugin integrations with agent policy and serves owner-scoped trace reads from one real AgentRuntime turn', async () => {
  await using directory = await mkdtempDisposable(
    join(tmpdir(), 'deepagents-traces-'),
  );
  const telemetry = join(directory.path, 'telemetry.jsonl');
  await using resources = new AsyncDisposableStack();
  const stores = createStores(resources);
  let observedStarts = 0;
  const traceTelemetry = fileTelemetry({ path: telemetry });
  const root = createDeclaration(
    [
      traceTelemetry,
      {
        name: 'observer-telemetry',
        create: () => ({
          telemetry: () => ({
            onStart: () => {
              observedStarts += 1;
            },
          }),
        }),
      },
    ],
    {
      isEnabled: true,
      recordInputs: false,
      recordOutputs: true,
    },
    {
      model: createTraceModel(),
      tools: {
        lookup: defineTool({
          description: 'Look up system status.',
          inputSchema: z.object({ query: z.string() }),
          execute: async ({ query }) => ({ query, status: 'ok' }),
        }),
      },
    },
  );
  const queue = new ControlledTurnQueue();
  const runtimeSetup = new AgentRuntime(root);
  const stack = defineStack(async () => ({ ...stores, queue }));
  const runtime = await runtimeSetup.initialize(stack);
  assert.equal(root.telemetry?.includeRuntimeContext, undefined);
  const worker = await runtime.work();
  const conversation = { chatId: 'chat-1', userId: 'user-1' };
  await runtime.createSession(conversation);
  const turn = await runtime.enqueue(conversation, {
    message: {
      id: 'message-1',
      role: 'user',
      parts: [{ type: 'text', text: 'Check the system.' }],
    },
    trigger: 'submit-message',
  });
  await queue.runNext();
  assert.equal(
    (await runtime.observe(conversation).status(turn.id))?.status,
    'completed',
  );
  assert.equal(observedStarts, 1);
  const persistedSpans = (await readFile(telemetry, 'utf8'))
    .trim()
    .split('\n')
    .map(
      (line) =>
        JSON.parse(line) as {
          trace_id: string;
          span_id: string;
          start_time: string;
          kind: string;
          status: { code: string };
          attributes: Record<string, unknown>;
        },
    );
  assert(persistedSpans.length > 0);
  assert(
    persistedSpans.every(
      ({ trace_id, span_id, start_time, kind, status, attributes }) =>
        /^[0-9a-f]{32}$/.test(trace_id) &&
        /^[0-9a-f]{16}$/.test(span_id) &&
        Number.isFinite(Date.parse(start_time)) &&
        kind.startsWith('SPAN_KIND_') &&
        status.code.startsWith('STATUS_CODE_') &&
        attributes[ATTR_SESSION_ID] === conversation.chatId &&
        attributes[ATTR_USER_ID] === conversation.userId &&
        attributes[ATTR_GEN_AI_AGENT_NAME] === 'trace-agent' &&
        attributes['deepagents.stream.id'] === turn.id &&
        attributes['deepagents.agent.path'] === '/root' &&
        attributes['deepagents.record.inputs'] === false &&
        attributes['deepagents.record.outputs'] === true &&
        typeof attributes['openinference.span.kind'] === 'string',
    ),
  );
  assert.deepEqual(
    new Set(
      persistedSpans.map(
        ({ attributes }) => attributes['openinference.span.kind'],
      ),
    ),
    new Set(['AGENT', 'CHAIN', 'LLM', 'TOOL']),
  );
  assert.doesNotMatch(
    JSON.stringify(persistedSpans),
    /runtimeContext|ai\.settings\.context/,
  );

  const app = createHost(runtime, tracesHttp(traceTelemetry));
  const { body, capabilities } = await readCapabilities(app, 'user-1');
  assert.deepEqual(capabilities.traces, { href: TRACES_HREF });
  assert.doesNotMatch(body, /file:|telemetry\.jsonl/);

  const listUrl = `${TRACES_HREF}/chat-1`;
  const listResponse = await app.request(listUrl, asUser('user-1'));
  assert.equal(listResponse.status, 200);
  assert.equal(listResponse.headers.get('cache-control'), 'no-store');
  const traceList = (await listResponse.json()) as Array<
    Record<string, unknown>
  >;
  assert.equal(traceList.length, 1);
  assert.deepEqual(
    {
      streamId: traceList[0].streamId,
      agentName: traceList[0].agentName,
      agentPath: traceList[0].agentPath,
      status: traceList[0].status,
      stepCount: traceList[0].stepCount,
      finishReason: traceList[0].finishReason,
      usage: traceList[0].usage,
      recording: traceList[0].recording,
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

  const traceUrl = `${listUrl}/${String(traceList[0].id)}`;
  const traceResponse = await app.request(traceUrl, asUser('user-1'));
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
    message: {
      id: 'message-2',
      role: 'user',
      parts: [{ type: 'text', text: 'Fail this turn.' }],
    },
    trigger: 'submit-message',
  });
  await queue.runNext();
  assert.equal(
    (await runtime.observe(conversation).status(failedTurn.id))?.status,
    'failed',
  );
  assert.equal(observedStarts, 2);
  const failedTraces = (await (
    await app.request(listUrl, asUser('user-1'))
  ).json()) as Array<Record<string, unknown>>;
  const failedTrace = failedTraces.find(
    ({ streamId }) => streamId === failedTurn.id,
  );
  assert(failedTrace);
  assert.equal(failedTrace.status, 'failed');
  const failedDetail = (await (
    await app.request(`${listUrl}/${String(failedTrace.id)}`, asUser('user-1'))
  ).json()) as {
    spans: Array<{ type: string; status: string; error?: unknown }>;
  };
  assert.deepEqual(
    failedDetail.spans
      .filter(({ status }) => status === 'failed')
      .map(({ type }) => type),
    ['agent', 'generation'],
  );
  assert.match(JSON.stringify(failedDetail), /model exploded/);

  assert.equal((await app.request(listUrl)).status, 401);
  assert.equal((await app.request(`${listUrl}?userId=user-1`)).status, 401);
  assert.equal((await app.request(listUrl, asUser('user-2'))).status, 404);
  assert.equal((await app.request(traceUrl, asUser('user-2'))).status, 404);
  assert.equal(
    (await app.request(`${TRACES_HREF}/missing-chat`, asUser('user-1'))).status,
    404,
  );
  const missingTrace = await app.request(
    `${listUrl}/missing-trace`,
    asUser('user-1'),
  );
  assert.equal(missingTrace.status, 404);
  assert.equal(
    ((await missingTrace.json()) as { cause: { code: string } }).cause.code,
    'traces/trace-not-found',
  );

  await worker[Symbol.asyncDispose]();

  const restartedSetup = new AgentRuntime(root);
  const restartedStack = defineStack(async () => ({
    ...stores,
    queue: new ControlledTurnQueue(),
  }));
  const restarted = await restartedSetup.initialize(restartedStack);
  const restartedWorker = await restarted.work();
  const restartedResponse = await createHost(
    restarted,
    tracesHttp(traceTelemetry),
  ).request(listUrl, asUser('user-1'));
  assert.equal(restartedResponse.status, 200);
  assert.equal(((await restartedResponse.json()) as unknown[]).length, 2);
  await restartedWorker[Symbol.asyncDispose]();
});

test('fileTelemetry() preserves cancellation and recording policy in exported traces', async (t) => {
  await using directory = await mkdtempDisposable(
    join(tmpdir(), 'deepagents-traces-'),
  );
  await using resources = new AsyncDisposableStack();
  const stores = createStores(resources);
  const traceTelemetry = fileTelemetry({
    path: join(directory.path, 'telemetry.jsonl'),
  });
  const queue = new ControlledTurnQueue();
  let started = false;
  const runtimeSetup = new AgentRuntime(
    createDeclaration(
      [
        traceTelemetry,
        {
          name: 'abort-observer',
          create: () => ({
            telemetry: () => ({
              onStart: () => {
                started = true;
              },
            }),
          }),
        },
      ],
      { isEnabled: true, recordInputs: true, recordOutputs: true },
      { model: createSlowTraceModel() },
    ),
  );
  const stack = defineStack(async () => ({ ...stores, queue }));
  const runtime = await runtimeSetup.initialize(stack);
  const worker = await runtime.work();
  const conversation = { chatId: 'chat-abort', userId: 'user-1' };
  await runtime.createSession(conversation);
  const turn = await runtime.enqueue(conversation, {
    message: {
      id: 'message-abort',
      role: 'user',
      parts: [{ type: 'text', text: 'Wait.' }],
    },
    trigger: 'submit-message',
  });
  // Drive and cancel the real queued turn after AI SDK telemetry has started.
  const run = queue.runNext();
  await t.waitFor(() => assert(started));
  await runtime.observe(conversation).cancel(turn.id);
  await run;

  const reader = runtime.plugin(traceTelemetry).traces;
  let trace: Awaited<ReturnType<typeof reader.list>>[number] | undefined;
  await t.waitFor(async () => {
    trace = (await reader.list(conversation)).find(
      ({ streamId }) => streamId === turn.id,
    );
    assert(trace);
  });
  assert(trace);
  assert.equal(trace.status, 'cancelled');
  assert.deepEqual(trace.recording, {
    inputs: 'recorded',
    outputs: 'recorded',
  });
  const detail = await reader.get(conversation, trace.id);
  assert(detail?.spans.some(({ status }) => status === 'cancelled'));
  await worker[Symbol.asyncDispose]();
});

test('FileTraceAdapter treats an AI operation under an external OTel parent as the trace root', async () => {
  await using directory = await mkdtempDisposable(
    join(tmpdir(), 'deepagents-traces-'),
  );
  const path = join(directory.path, 'telemetry.jsonl');
  const traceId = '1'.repeat(32);
  const spanId = '2'.repeat(16);
  await writeFile(
    path,
    `${JSON.stringify({
      trace_id: traceId,
      span_id: spanId,
      parent_span_id: '3'.repeat(16),
      name: 'ai.streamText',
      kind: 'SPAN_KIND_INTERNAL',
      start_time: '2026-01-01T00:00:00.000000000Z',
      end_time: '2026-01-01T00:00:01.000000000Z',
      status: { code: 'STATUS_CODE_UNSET', message: '' },
      attributes: {
        [ATTR_SESSION_ID]: 'chat-1',
        [ATTR_USER_ID]: 'user-1',
        [ATTR_GEN_AI_AGENT_NAME]: 'trace-agent',
        [ATTR_GEN_AI_OPERATION_NAME]: 'invoke_agent',
        [ATTR_GEN_AI_RESPONSE_FINISH_REASONS]: ['stop'],
        'deepagents.stream.id': 'stream-1',
        'deepagents.agent.path': '/root',
        'deepagents.span.type': 'operation',
        'deepagents.record.inputs': false,
        'deepagents.record.outputs': true,
      },
      events: [],
    })}\n`,
  );

  const [trace] = await new FileTraceAdapter(pathToFileURL(path)).list({
    chatId: 'chat-1',
    userId: 'user-1',
  });
  assert(trace);
  assert.equal(trace.status, 'completed');
  assert.equal(trace.endedAt, '2026-01-01T00:00:01.000000000Z');
  assert.equal(trace.finishReason, 'stop');
  assert.deepEqual(trace.recording, {
    inputs: 'not-recorded',
    outputs: 'recorded',
  });
  const detail = await new FileTraceAdapter(pathToFileURL(path)).get(
    { chatId: 'chat-1', userId: 'user-1' },
    traceId,
  );
  assert.equal(detail?.spans[0]?.parentId, null);
});

test('fileTelemetry() advertises an empty file, omits absent telemetry, and rejects duplicate HTTP projections', async () => {
  await using directory = await mkdtempDisposable(
    join(tmpdir(), 'deepagents-traces-'),
  );
  await using resources = new AsyncDisposableStack();
  const stores = createStores(resources);
  const conversation = { chatId: 'chat-1', userId: 'user-1' };

  const emptyTelemetry = fileTelemetry({
    path: join(directory.path, 'empty.jsonl'),
  });
  const emptyRuntimeSetup = new AgentRuntime(
    createDeclaration([emptyTelemetry]),
  );
  const emptyStack = defineStack(async () => ({
    ...stores,
    queue: new ControlledTurnQueue(),
  }));
  const emptyRuntime = await emptyRuntimeSetup.initialize(emptyStack);
  await emptyRuntime.createSession(conversation);
  const emptyHost = createHost(emptyRuntime, tracesHttp(emptyTelemetry));
  const empty = await readCapabilities(emptyHost, 'user-1');
  assert.deepEqual(empty.capabilities.traces, { href: TRACES_HREF });
  assert.doesNotMatch(empty.body, /file:|empty\.jsonl/);
  const emptyList = await emptyHost.request(
    `${TRACES_HREF}/chat-1`,
    asUser('user-1'),
  );
  assert.equal(emptyList.status, 200);
  assert.deepEqual(await emptyList.json(), []);

  const absentRuntimeSetup = new AgentRuntime(createDeclaration());
  const absentStack = defineStack(async () => ({
    ...stores,
    queue: new ControlledTurnQueue(),
  }));
  const absentRuntime = await absentRuntimeSetup.initialize(absentStack);
  const absentHost = createHost(absentRuntime);
  const absent = await readCapabilities(absentHost, 'user-1');
  assert.equal(absent.capabilities.traces, undefined);
  assert.equal(
    (await absentHost.request(`${TRACES_HREF}/chat-1`, asUser('user-1')))
      .status,
    404,
  );

  const first = fileTelemetry({ path: join(directory.path, 'first.jsonl') });
  const second = fileTelemetry({ path: join(directory.path, 'second.jsonl') });
  const duplicateRuntimeSetup = new AgentRuntime(
    createDeclaration([first, second]),
  );
  const duplicateStack = defineStack(async () => ({
    ...stores,
    queue: new ControlledTurnQueue(),
  }));
  const duplicateRuntime =
    await duplicateRuntimeSetup.initialize(duplicateStack);
  assert.throws(
    () => createHost(duplicateRuntime, tracesHttp(first), tracesHttp(second)),
    /duplicate capability "traces"/,
  );
});
