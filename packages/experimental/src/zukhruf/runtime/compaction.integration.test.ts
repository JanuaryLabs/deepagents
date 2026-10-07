import type {
  LanguageModelV4StreamPart,
  LanguageModelV4StreamResult,
  LanguageModelV4Usage,
} from '@ai-sdk/provider';
import { PGlite } from '@electric-sql/pglite';
import {
  type ModelMessage,
  type UIMessageChunk,
  isToolUIPart,
  parseJsonEventStream,
  simulateReadableStream,
  uiMessageChunkSchema,
} from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { Hono } from 'hono';
import { InMemoryFs } from 'just-bash';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { PgBoss, fromPglite } from 'pg-boss';
import { z } from 'zod';

import {
  cacheLikelyCold,
  estimateTokens,
  messagesExceed,
  tokensExceed,
} from '@deepagents/compaction';
import {
  PollingChangeSource,
  SqliteContextStore,
  SqliteStreamStore,
  StreamManager,
  createVirtualSandbox,
  role,
} from '@deepagents/context';
import {
  type AgentCompaction,
  type AgentDeclaration,
  type AgentHost,
  AgentRuntime,
  PgBossTurnQueue,
  SqliteMailboxStore,
  defineAgent,
  defineSandbox,
  defineStack,
  defineTool,
} from '@deepagents/experimental/zukhruf';
import { type HttpEnv, http } from '@deepagents/experimental/zukhruf/http';

const tokenScopeSchema = z.literal('request').optional();

/** `data-compaction` payloads as the runtime writes them; nothing is stripped. */
const compactionEventSchema = z.discriminatedUnion('status', [
  z.looseObject({
    id: z.string(),
    status: z.literal('restored'),
    sourceMessages: z.number(),
    replacementMessages: z.number(),
  }),
  z.looseObject({
    id: z.string(),
    status: z.literal('started'),
    tokenScope: tokenScopeSchema,
    triggerIndex: z.number(),
    tokensBefore: z.number(),
    targetTokens: z.number(),
    messageCount: z.number(),
  }),
  z.looseObject({
    id: z.string(),
    status: z.literal('completed'),
    tokenScope: tokenScopeSchema,
    tokens: z.looseObject({ before: z.number(), after: z.number() }),
    replacedRange: z.looseObject({ start: z.number(), end: z.number() }),
    usage: z.looseObject({}),
  }),
  z.looseObject({
    id: z.string(),
    status: z.literal('failed'),
    phase: z.enum(['restore', 'evaluate', 'compact', 'persist']),
    reason: z.string(),
  }),
]);

function compactionEvents(chunks: readonly UIMessageChunk[]) {
  return chunks.flatMap((chunk) => {
    if (chunk.type !== 'data-compaction') return [];
    assert.equal(
      chunk.transient,
      undefined,
      'lifecycle events survive in the UI transcript',
    );
    return [compactionEventSchema.parse(chunk.data)];
  });
}

/**
 * A `/session` transcript, as the HTTP plugin returns it. Only data parts
 * (`data-*`) carry `data`; text and tool parts have none.
 */
const transcriptSchema = z.looseObject({
  messages: z.array(
    z.looseObject({
      parts: z.array(
        z.looseObject({ type: z.string(), data: z.unknown().optional() }),
      ),
    }),
  ),
});

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
} as const;

function stream(
  chunks: LanguageModelV4StreamPart[],
  toolCall = false,
  reported: LanguageModelV4Usage = usage,
): LanguageModelV4StreamResult {
  return {
    stream: simulateReadableStream({
      chunks: [
        ...chunks,
        {
          type: 'finish',
          finishReason: {
            unified: toolCall ? 'tool-calls' : 'stop',
            raw: undefined,
          },
          usage: reported,
        },
      ],
      initialDelayInMs: null,
      chunkDelayInMs: null,
    }),
  };
}

const answer = async () =>
  stream([
    { type: 'text-start', id: 'answer' },
    {
      type: 'text-delta',
      id: 'answer',
      delta: 'Finished inspecting the files.',
    },
    { type: 'text-end', id: 'answer' },
  ]);

function summarizer() {
  return new MockLanguageModelV4({
    doGenerate: {
      content: [
        {
          type: 'text',
          text: 'Earlier file reads completed. Preserve CASE-42 and inspect remaining files.',
        },
      ],
      finishReason: { unified: 'stop', raw: undefined },
      usage,
      warnings: [],
    },
  });
}

const countTokens = (messages: readonly ModelMessage[]) =>
  JSON.stringify(messages).length;
const compaction = (model: MockLanguageModelV4): AgentCompaction => ({
  model,
  triggers: [tokensExceed(7_000)],
  targetTokens: 4_000,
  keepLastMessages: 2,
  countTokens,
});

async function infrastructure(resources: AsyncDisposableStack) {
  const database = resources.use(new PGlite());
  const boss = resources.adopt(
    new PgBoss({ db: fromPglite(database), backend: 'pglite' }),
    (boss) => boss.stop({ graceful: false }),
  );
  boss.on('error', (error) => {
    throw error;
  });
  await boss.start();
  const queue = new PgBossTurnQueue(boss, {
    pollingIntervalSeconds: 0.5,
    schema: 'pgboss',
  });
  await queue.initialize();
  const store = new SqliteContextStore(
    resources.use(new DatabaseSync(':memory:')),
  );
  const streamStore = new SqliteStreamStore(
    resources.use(new DatabaseSync(':memory:')),
  );
  const streams = new StreamManager({
    store: streamStore,
    changeSource: new PollingChangeSource({ reads: streamStore }),
  });
  const mailboxStore = resources.use(new SqliteMailboxStore(':memory:'));
  return {
    store,
    stack: defineStack(async () => ({ store, streams, queue, mailboxStore })),
  };
}

function declaration(
  model: MockLanguageModelV4,
  options?: AgentCompaction,
  tools: AgentDeclaration['tools'] = {},
) {
  return defineAgent({
    name: 'compaction-test',
    model,
    instructions: [],
    compaction: options,
    tools,
    sandbox: defineSandbox(() =>
      createVirtualSandbox({ fs: new InMemoryFs() }),
    ),
  });
}

const conversation = {
  chatId: '48aca921-341e-4c09-839c-954c1134616b',
  userId: 'user',
};
async function send(
  host: AgentHost,
  text: string,
  trigger: 'submit-message' | 'regenerate-message' = 'submit-message',
  id: string = crypto.randomUUID(),
) {
  const turn = await host.enqueue(conversation, {
    message: { id, role: 'user', parts: [{ type: 'text', text }] },
    trigger,
  });
  const chunks = [];
  for await (const chunk of turn.stream) chunks.push(chunk);
  return {
    id: turn.id,
    status: await host.observe(conversation).status(turn.id),
    chunks,
  };
}

test(
  'measured input survives restart and checkpoint restore without double counting',
  { timeout: 30_000 },
  async () => {
    await using resources = new AsyncDisposableStack();
    const { store, stack } = await infrastructure(resources);
    const summary = summarizer();
    const snapshots: Array<{ tokens: number; messages: ModelMessage[] }> = [];
    const model = new MockLanguageModelV4({
      doStream: async () =>
        stream(
          [
            { type: 'text-start', id: 'answer' },
            { type: 'text-delta', id: 'answer', delta: 'Remember CASE-42.' },
            { type: 'text-end', id: 'answer' },
          ],
          false,
          {
            inputTokens: {
              total: 10_800,
              noCache: 4_800,
              cacheRead: 6_000,
              cacheWrite: 0,
            },
            outputTokens: { total: 9_000, text: 9_000, reasoning: 0 },
          },
        ),
    });
    const options: AgentCompaction = {
      model: summary,
      targetTokens: 8_000,
      keepLastMessages: 1,
      triggers: [
        (context) => {
          snapshots.push({
            tokens: context.tokens,
            messages: structuredClone([...context.messages]),
          });
          return tokensExceed(12_000)(context);
        },
      ],
    };
    const root = declaration(model, options);
    const host = resources.use(await new AgentRuntime(root).initialize(stack));
    await host.work();
    assert.equal(
      (await send(host, 'Remember CASE-42.')).status?.status,
      'completed',
    );
    const saved = z.object({
      zukhruf: z.object({
        inputUsage: z.object({
          inputTokens: z.number(),
          prefixLength: z.number(),
        }),
      }),
    });
    const first = saved.parse(
      (await store.getChat(conversation.chatId))?.metadata,
    ).zukhruf.inputUsage;
    assert.equal(
      first.inputTokens,
      10_800,
      'cached input is included; output is not',
    );
    assert.equal(summary.doGenerateCalls.length, 0);
    await host[Symbol.asyncDispose]();
    await using resumed = await new AgentRuntime(root).initialize(stack);
    await resumed.work();
    const compacted = await send(resumed, 'x'.repeat(6_000));
    assert.equal(compacted.status?.status, 'completed');
    const second = snapshots.at(-1)!;
    assert.equal(
      second.tokens,
      10_800 + estimateTokens(second.messages.slice(first.prefixLength)),
    );
    assert.ok(second.tokens > 12_000);
    assert.equal(
      summary.doGenerateCalls.length,
      1,
      'high measured input triggers reduction even when characters fit the target',
    );
    const completion = compactionEvents(compacted.chunks).find(
      (event) => event.status === 'completed',
    );
    assert.ok(completion?.status === 'completed');
    assert.ok(completion.tokens.after <= 8_000);
    const after = saved.parse(
      (await store.getChat(conversation.chatId))?.metadata,
    ).zukhruf.inputUsage;
    assert.equal(
      after.inputTokens,
      10_800,
      'main-model usage replaces the summary-model usage',
    );
    const next = await send(resumed, 'Continue.');
    assert.equal(next.status?.status, 'completed');
    assert.equal(compactionEvents(next.chunks)[0]?.status, 'restored');
    const third = snapshots.at(-1)!;
    assert.equal(
      third.tokens,
      10_800 + estimateTokens(third.messages.slice(after.prefixLength)),
    );
    assert.equal(summary.doGenerateCalls.length, 1);
    options.countTokens = estimateTokens;
    assert.equal(
      (await send(resumed, 'Use my counter.')).status?.status,
      'completed',
    );
    assert.ok(
      snapshots.at(-1)!.tokens < 8_000,
      'explicit counter takes precedence over measured input',
    );
  },
);

test(
  'each tool step uses its own input usage and the final step seeds the next turn',
  { timeout: 30_000 },
  async () => {
    await using resources = new AsyncDisposableStack();
    const { store, stack } = await infrastructure(resources);
    const snapshots: Array<{ tokens: number; messages: ModelMessage[] }> = [];
    const model: MockLanguageModelV4 = new MockLanguageModelV4({
      doStream: async () => {
        const first = model.doStreamCalls.length === 1;
        return stream(
          first
            ? [
                {
                  type: 'tool-call',
                  toolCallId: 'inspect',
                  toolName: 'inspect',
                  input: '{}',
                },
              ]
            : [],
          first,
          {
            inputTokens: {
              total: first ? 10_800 : 2_000,
              noCache: first ? 10_800 : 2_000,
              cacheRead: 0,
              cacheWrite: 0,
            },
            outputTokens: usage.outputTokens,
          },
        );
      },
    });
    const root = declaration(
      model,
      {
        model: summarizer(),
        targetTokens: 8_000,
        triggers: [
          (context) => {
            snapshots.push({
              tokens: context.tokens,
              messages: structuredClone([...context.messages]),
            });
            return false;
          },
        ],
      },
      {
        inspect: defineTool({
          description: 'Inspect',
          inputSchema: z.object({}),
          execute: () => 'Evidence. '.repeat(100),
        }),
      },
    );
    await using host = await new AgentRuntime(root).initialize(stack);
    await host.work();
    assert.equal(
      (await send(host, 'Inspect the file.')).status?.status,
      'completed',
    );
    assert.equal(snapshots.length, 2);
    assert.equal(
      snapshots[1]!.tokens,
      10_800 +
        estimateTokens(
          snapshots[1]!.messages.slice(snapshots[0]!.messages.length),
        ),
    );
    const baseline = z
      .object({
        zukhruf: z.object({
          inputUsage: z.object({
            inputTokens: z.number(),
            prefixLength: z.number(),
          }),
        }),
      })
      .parse((await store.getChat(conversation.chatId))?.metadata)
      .zukhruf.inputUsage;
    assert.equal(
      baseline.inputTokens,
      2_000,
      'uses the final step, never summed usage',
    );
    assert.equal((await send(host, 'Continue.')).status?.status, 'completed');
    const next = snapshots.at(-1)!;
    assert.equal(
      next.tokens,
      2_000 + estimateTokens(next.messages.slice(baseline.prefixLength)),
    );
  },
);

test(
  'input usage resets for changed requests, rewinds and malformed persisted data',
  { timeout: 60_000 },
  async () => {
    await using resources = new AsyncDisposableStack();
    const { store, stack } = await infrastructure(resources);
    const counts: number[] = [];
    let description = 'Inspect a file';
    let inputSchema = z.object({ query: z.string() });
    let instructions = '';
    let modelId = 'initial';
    const options: AgentCompaction = {
      model: summarizer(),
      targetTokens: 8_000,
      triggers: [
        (context) => {
          counts.push(context.tokens);
          return false;
        },
      ],
    };
    const start = async () => {
      const root = declaration(
        new MockLanguageModelV4({
          modelId,
          doStream: async () =>
            stream([], false, {
              inputTokens: {
                total: 10_800,
                noCache: 10_800,
                cacheRead: 0,
                cacheWrite: 0,
              },
              outputTokens: usage.outputTokens,
            }),
        }),
        options,
        {
          inspect: defineTool({
            description: () => description,
            inputSchema,
            execute: () => 'done',
          }),
        },
      );
      root.instructions = [role(instructions)];
      const host = resources.use(
        await new AgentRuntime(root).initialize(stack),
      );
      await host.work();
      return host;
    };
    let host = await start();
    const firstId = crypto.randomUUID();
    await send(host, 'Initial message.', 'submit-message', firstId);
    await send(host, 'Unchanged request.');
    assert.ok(counts.at(-1)! >= 10_800);
    for (const change of [
      'description',
      'schema',
      'instructions',
      'model',
      'rewind',
      'malformed',
    ] as const) {
      await host[Symbol.asyncDispose]();
      if (change === 'description') description = 'Read a different file';
      if (change === 'schema')
        inputSchema = z.object({
          query: z.string().describe('A changed schema'),
        });
      if (change === 'instructions') instructions = 'New instructions';
      if (change === 'model') modelId = 'new-model';
      if (change === 'malformed')
        await store.updateChat(conversation.chatId, ({ metadata }) => ({
          metadata: {
            ...metadata,
            zukhruf: {
              ...z.record(z.string(), z.unknown()).parse(metadata?.zukhruf),
              inputUsage: { inputTokens: -1 },
            },
          },
        }));
      host = await start();
      const result =
        change === 'rewind'
          ? await send(
              host,
              'Edited original message.',
              'regenerate-message',
              firstId,
            )
          : await send(host, `After ${change}.`);
      assert.equal(result.status?.status, 'completed');
      assert.ok(
        counts.at(-1)! < 10_800,
        `${change} must invalidate measured usage`,
      );
      await send(host, 'Same request again.');
      assert.ok(
        counts.at(-1)! >= 10_800,
        `${change} establishes a new valid baseline`,
      );
    }
  },
);

test(
  'missing, invalid and native-compaction usage cannot seed a prompt baseline',
  { timeout: 60_000 },
  async () => {
    await using resources = new AsyncDisposableStack();
    const { store, stack } = await infrastructure(resources);
    let reported: LanguageModelV4Usage = {
      inputTokens: {
        total: 10_800,
        noCache: 10_800,
        cacheRead: 0,
        cacheWrite: 0,
      },
      outputTokens: usage.outputTokens,
    };
    let chunks: LanguageModelV4StreamPart[] = [];
    const counts: number[] = [];
    const root = declaration(
      new MockLanguageModelV4({
        doStream: async () => stream(chunks, false, reported),
      }),
      {
        model: summarizer(),
        targetTokens: 8_000,
        triggers: [
          (context) => {
            counts.push(context.tokens);
            return false;
          },
        ],
      },
    );
    await using host = await new AgentRuntime(root).initialize(stack);
    await host.work();
    await send(host, 'Seed valid usage.');
    for (const invalid of [
      undefined,
      -1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]) {
      reported = {
        inputTokens: {
          total: invalid,
          noCache: undefined,
          cacheRead: undefined,
          cacheWrite: undefined,
        },
        outputTokens: usage.outputTokens,
      };
      assert.equal(
        (await send(host, 'Invalid usage.')).status?.status,
        'completed',
      );
      assert.equal(
        z
          .object({ zukhruf: z.object({ inputUsage: z.null() }) })
          .safeParse((await store.getChat(conversation.chatId))?.metadata)
          .success,
        true,
      );
      await send(host, 'Use the fallback.');
      assert.ok(counts.at(-1)! < 10_800);
    }
    reported = {
      inputTokens: {
        total: 61_067,
        noCache: 61_067,
        cacheRead: 0,
        cacheWrite: 0,
      },
      outputTokens: usage.outputTokens,
      raw: {
        iterations: [
          { type: 'compaction', input_tokens: 60_385, output_tokens: 100 },
          { type: 'message', input_tokens: 682, output_tokens: 5 },
        ],
      },
    };
    await send(host, 'Aggregated native usage.');
    await send(host, 'Do not use aggregate billing as occupancy.');
    assert.ok(counts.at(-1)! < 10_800);
    reported = {
      ...usage,
      inputTokens: {
        total: 10_800,
        noCache: 10_800,
        cacheRead: 0,
        cacheWrite: 0,
      },
    };
    for (const native of ['anthropic', 'openai'] as const) {
      chunks =
        native === 'anthropic'
          ? [
              {
                type: 'text-start',
                id: 'summary',
                providerMetadata: { anthropic: { type: 'compaction' } },
              },
              { type: 'text-delta', id: 'summary', delta: 'Server summary' },
              { type: 'text-end', id: 'summary' },
            ]
          : [
              {
                type: 'custom',
                kind: 'openai.compaction',
                providerMetadata: { openai: { encryptedContent: 'opaque' } },
              },
            ];
      assert.equal(
        (await send(host, `Observed ${native} native content.`)).status?.status,
        'completed',
      );
      assert.equal(
        z
          .object({ zukhruf: z.object({ inputUsage: z.null() }) })
          .safeParse((await store.getChat(conversation.chatId))?.metadata)
          .success,
        true,
        native,
      );
    }
  },
);

test(
  'full request estimates include instructions and tools and enforce the input target',
  { timeout: 30_000 },
  async () => {
    await using resources = new AsyncDisposableStack();
    const { store, stack } = await infrastructure(resources);
    for (const kind of ['instructions', 'tools'] as const) {
      const summary = summarizer();
      const model = new MockLanguageModelV4({ doStream: answer });
      let armed = false;
      const options: AgentCompaction = {
        model: summary,
        targetTokens: 20_000,
        countTokens: estimateTokens,
        keepLastMessages: 1,
        triggers: [(context) => armed && tokensExceed(3_000)(context)],
      };
      const root = declaration(
        model,
        options,
        kind === 'tools'
          ? {
              inspect: defineTool({
                description: 'Large tool documentation. '.repeat(1500),
                inputSchema: z.object({ query: z.string() }),
                execute: () => 'done',
              }),
            }
          : {},
      );
      if (kind === 'instructions')
        root.instructions = [role('Large system instructions. '.repeat(1500))];
      await using host = await new AgentRuntime(root).initialize(stack);
      await host.work();
      assert.equal(
        (await send(host, 'Prior facts. '.repeat(100))).status?.status,
        'completed',
      );
      armed = true;
      const result = await send(host, 'Continue.');
      assert.equal(result.status?.status, 'completed');
      assert.equal(
        summary.doGenerateCalls.length,
        1,
        `${kind} must participate in the trigger`,
      );
      const completed = compactionEvents(result.chunks).find(
        (event) => event.status === 'completed',
      );
      assert.ok(completed?.status === 'completed');
      assert.ok(completed.tokens.before > 3_000);
      assert.ok(completed.tokens.after <= options.targetTokens);
      assert.ok(
        completed.tokens.after > 3_000,
        'the returned count still includes the envelope',
      );
      const savedCheckpoint = z.object({
        zukhruf: z.object({ compaction: z.unknown() }),
      });
      const previous = savedCheckpoint.parse(
        (await store.getChat(conversation.chatId))?.metadata,
      ).zukhruf.compaction;
      options.targetTokens = 1;
      const rejected = await send(host, 'Continue again.');
      assert.equal(rejected.status?.status, 'failed');
      assert.partialDeepStrictEqual(compactionEvents(rejected.chunks).at(-1), {
        status: 'failed',
        phase: 'compact',
        reason: 'request-overhead',
      });
      assert.equal(
        summary.doGenerateCalls.length,
        1,
        'an exhausted target does not call the summarizer',
      );
      assert.deepEqual(
        savedCheckpoint.parse(
          (await store.getChat(conversation.chatId))?.metadata,
        ).zukhruf.compaction,
        previous,
      );
    }
  },
);

test(
  'cache retention follows observed writes, not an uncached longer breakpoint',
  { timeout: 30_000 },
  async (t) => {
    await using resources = new AsyncDisposableStack();
    const { stack } = await infrastructure(resources);
    let now = Date.now();
    t.mock.method(Date, 'now', () => now);
    const snapshots: Array<{ retention: number | undefined; cold: boolean }> =
      [];
    const cold = cacheLikelyCold();
    let creation = {
      ephemeral_5m_input_tokens: 2000,
      ephemeral_1h_input_tokens: 0,
    };
    const model = new MockLanguageModelV4({
      provider: 'anthropic.messages',
      modelId: 'claude-sonnet-5',
      doStream: async () => ({
        request: {
          body: {
            system: [
              {
                type: 'text',
                text: 'Short system',
                cache_control: { type: 'ephemeral', ttl: '1h' },
              },
            ],
            messages: [
              {
                role: 'user',
                content: [
                  {
                    type: 'text',
                    text: 'History. '.repeat(2000),
                    cache_control: { type: 'ephemeral', ttl: '5m' },
                  },
                ],
              },
            ],
          },
        },
        stream: simulateReadableStream({
          chunks: [
            { type: 'text-start', id: 'answer' },
            { type: 'text-delta', id: 'answer', delta: 'OK' },
            { type: 'text-end', id: 'answer' },
            {
              type: 'finish',
              finishReason: { unified: 'stop', raw: undefined },
              usage: {
                ...usage,
                inputTokens: {
                  total: 2000,
                  noCache: 0,
                  cacheRead: 0,
                  cacheWrite: 2000,
                },
                // Preserved by the native Anthropic stream adapter in the reproduction.
                raw: { cache_creation: creation },
              },
            },
          ],
          initialDelayInMs: null,
          chunkDelayInMs: null,
        }),
      }),
    });
    await using host = await new AgentRuntime(
      declaration(model, {
        ...compaction(summarizer()),
        targetTokens: 100_000,
        triggers: [
          async (context) => {
            snapshots.push({
              retention: context.cacheRetentionMs,
              cold: await cold(context),
            });
            return false;
          },
        ],
      }),
    ).initialize(stack);
    await host.work();
    assert.equal(
      (await send(host, 'History. '.repeat(300))).status?.status,
      'completed',
    );
    now += 300_001;
    assert.equal((await send(host, 'Continue.')).status?.status, 'completed');
    assert.deepEqual(snapshots.at(-1), { retention: 300_000, cold: true });
    creation = {
      ephemeral_5m_input_tokens: 0,
      ephemeral_1h_input_tokens: 2000,
    };
    assert.equal(
      (await send(host, 'Establish a one-hour cache.')).status?.status,
      'completed',
    );
    now += 300_001;
    assert.equal(
      (await send(host, 'Keep the one-hour prefix.')).status?.status,
      'completed',
    );
    assert.deepEqual(snapshots.at(-1), { retention: 3_600_000, cold: false });
  },
);

test(
  'cache identity includes tool schemas across runtime restarts',
  { timeout: 30_000 },
  async (t) => {
    await using resources = new AsyncDisposableStack();
    const { stack } = await infrastructure(resources);
    let now = Date.now();
    t.mock.method(Date, 'now', () => now);
    const ages: Array<number | undefined> = [];
    const model = new MockLanguageModelV4({
      provider: 'anthropic.messages',
      modelId: 'claude-sonnet-5',
      doStream: async () => ({
        request: { body: { cache_control: { type: 'ephemeral' } } },
        stream: simulateReadableStream({
          chunks: [
            { type: 'text-start', id: 'answer' },
            { type: 'text-delta', id: 'answer', delta: 'OK' },
            { type: 'text-end', id: 'answer' },
            {
              type: 'finish',
              finishReason: { unified: 'stop', raw: undefined },
              usage: {
                ...usage,
                inputTokens: {
                  total: 2000,
                  noCache: 0,
                  cacheRead: 2000,
                  cacheWrite: 0,
                },
              },
            },
          ],
          initialDelayInMs: null,
          chunkDelayInMs: null,
        }),
      }),
    });
    const options: AgentCompaction = {
      ...compaction(summarizer()),
      targetTokens: 100_000,
      triggers: [
        (context) => {
          ages.push(context.cacheAgeMs);
          return false;
        },
      ],
    };
    for (const [property, description, expectedAge] of [
      ['id', 'Lookup', undefined],
      ['id', 'Lookup', 300_001],
      ['query', 'Lookup', undefined],
      ['query', 'Search', undefined],
      ['query', () => 'Search', 300_001],
    ] as const) {
      await using host = await new AgentRuntime(
        declaration(model, options, {
          lookup: defineTool({
            description,
            inputSchema: z.object({ [property]: z.string() }),
            execute: () => '',
          }),
        }),
      ).initialize(stack);
      await host.work();
      assert.equal((await send(host, 'Continue.')).status?.status, 'completed');
      assert.equal(
        ages.at(-1),
        expectedAge,
        `tool input property: ${property}`,
      );
      now += 300_001;
    }
  },
);

test(
  'cache writes remain warm across turns and expire in a fresh host without telemetry',
  { timeout: 30_000 },
  async (t) => {
    await using resources = new AsyncDisposableStack();
    const { store, stack } = await infrastructure(resources);
    let now = Date.now();
    t.mock.method(Date, 'now', () => now);
    const retentionMs = 300_000;
    const summary = summarizer();
    const ages: Array<number | undefined> = [];
    let longToolCall = false;
    const model = new MockLanguageModelV4({
      provider: 'anthropic.messages',
      modelId: 'claude-sonnet-5',
      doStream: async () => {
        const toolCall = longToolCall;
        longToolCall = false;
        if (toolCall) now += retentionMs;
        return {
          request: { body: { cache_control: { type: 'ephemeral' } } },
          stream: simulateReadableStream({
            chunks: [
              ...(toolCall
                ? [
                    {
                      type: 'tool-call' as const,
                      toolCallId: 'cache-inspect',
                      toolName: 'inspect',
                      input: '{}',
                    },
                  ]
                : [
                    { type: 'text-start' as const, id: 'answer' },
                    {
                      type: 'text-delta' as const,
                      id: 'answer',
                      delta: 'Finished.',
                    },
                    { type: 'text-end' as const, id: 'answer' },
                  ]),
              {
                type: 'finish',
                finishReason: {
                  unified: toolCall ? 'tool-calls' : 'stop',
                  raw: undefined,
                },
                usage: {
                  ...usage,
                  inputTokens: {
                    total: 100,
                    noCache: 0,
                    cacheRead: 0,
                    cacheWrite: 100,
                  },
                },
              },
            ],
          }),
        };
      },
    });
    const cold = cacheLikelyCold();
    const root = declaration(
      model,
      {
        ...compaction(summary),
        keepLastMessages: 1,
        triggers: [
          (context) => {
            ages.push(context.cacheAgeMs);
            return cold(context);
          },
        ],
      },
      {
        inspect: defineTool({
          description: 'Inspect a record',
          inputSchema: z.object({}),
          execute: () => 'CASE-42 verified.',
        }),
      },
    );
    root.telemetry = { isEnabled: false };
    const host = resources.use(await new AgentRuntime(root).initialize(stack));
    await host.work();
    assert.equal(
      (await send(host, 'Prior findings. '.repeat(700))).status?.status,
      'completed',
    );
    assert.deepEqual(ages, [undefined], 'first request has no cache baseline');
    const saved = (await store.getChat(conversation.chatId))?.metadata?.zukhruf;
    assert.partialDeepStrictEqual(saved, { promptCache: { startedAt: now } });
    now += retentionMs - 1;
    assert.equal(
      (await send(host, 'Keep working.')).status?.status,
      'completed',
    );
    assert.equal(ages.at(-1), retentionMs - 1);
    assert.equal(
      summary.doGenerateCalls.length,
      0,
      'cache write with zero reads remains warm',
    );
    await host[Symbol.asyncDispose]();

    const resumed = resources.use(
      await new AgentRuntime(root).initialize(stack),
    );
    await resumed.work();
    now += retentionMs;
    assert.equal(
      (await send(resumed, 'Continue.')).status?.status,
      'completed',
    );
    assert.equal(ages.at(-1), retentionMs);
    assert.equal(summary.doGenerateCalls.length, 1);
    assert.match(
      JSON.stringify(model.doStreamCalls.at(-1)?.prompt),
      /Previous conversation summary/,
    );
    now++;
    assert.equal(
      (await send(resumed, 'Continue again.')).status?.status,
      'completed',
    );
    assert.equal(ages.at(-1), 1);
    assert.equal(
      summary.doGenerateCalls.length,
      1,
      'replacement gets a fresh cache baseline',
    );

    await send(resumed, 'Additional findings. '.repeat(700));
    longToolCall = true;
    assert.equal(
      (await send(resumed, 'Inspect CASE-42.')).status?.status,
      'completed',
    );
    assert.equal(
      ages.at(-1),
      retentionMs,
      'a long request consumes retention before the next tool step',
    );
    assert.equal(summary.doGenerateCalls.length, 2);
    assert.match(
      JSON.stringify(model.doStreamCalls.at(-1)?.prompt),
      /CASE-42 verified/,
    );
    const transcript = JSON.stringify(
      await resumed.observe(conversation).engine.getMessages(),
    );
    assert.match(transcript, /Prior findings/);
    assert.match(transcript, /Additional findings/);
    assert.doesNotMatch(transcript, /Previous conversation summary/);
  },
);

test(
  'cache retention follows the serialized provider policy and actual routed provider',
  { timeout: 120_000 },
  async (t) => {
    await using resources = new AsyncDisposableStack();
    const { store, stack } = await infrastructure(resources);
    let now = Date.now();
    t.mock.method(Date, 'now', () => now);
    const summary = summarizer();
    const cases: Array<{
      name: string;
      provider: string;
      modelId: string;
      body: unknown;
      upstream?: string;
      resolvedModel?: string;
      retentionMs: number | undefined;
    }> = [
      {
        name: 'Anthropic default',
        provider: 'anthropic.messages',
        modelId: 'claude-sonnet-5',
        body: { cache_control: { type: 'ephemeral' } },
        retentionMs: 300_000,
      },
      {
        name: 'Anthropic 1h',
        provider: 'anthropic.messages',
        modelId: 'claude-sonnet-5',
        body: { cache_control: { type: 'ephemeral', ttl: '1h' } },
        retentionMs: 3_600_000,
      },
      {
        name: 'mixed breakpoints without TTL attribution are unknown',
        provider: 'anthropic.messages',
        modelId: 'claude-sonnet-5',
        body: {
          system: [{ cache_control: { type: 'ephemeral', ttl: '1h' } }],
          messages: [
            { content: [{ cache_control: { type: 'ephemeral', ttl: '5m' } }] },
          ],
        },
        retentionMs: undefined,
      },
      {
        name: 'tool breakpoint',
        provider: 'anthropic.messages',
        modelId: 'claude-sonnet-5',
        body: { tools: [{ cache_control: { type: 'ephemeral', ttl: '1h' } }] },
        retentionMs: 3_600_000,
      },
      {
        name: 'tool schema is not a breakpoint',
        provider: 'anthropic.messages',
        modelId: 'claude-sonnet-5',
        body: {
          tools: [
            {
              input_schema: { cache_control: { type: 'ephemeral', ttl: '1h' } },
            },
          ],
        },
        retentionMs: undefined,
      },
      {
        name: 'unsupported Anthropic TTL',
        provider: 'anthropic.messages',
        modelId: 'claude-sonnet-5',
        body: { cache_control: { type: 'ephemeral', ttl: '2h' } },
        retentionMs: undefined,
      },
      {
        name: 'local Claude provider',
        provider: 'claude.messages',
        modelId: 'claude-sonnet-5',
        body: JSON.stringify({ cache_control: { type: 'ephemeral' } }),
        retentionMs: 300_000,
      },
      {
        name: 'OpenAI modern default',
        provider: 'openai.responses',
        modelId: 'gpt-5.6-terra',
        body: {},
        retentionMs: 1_800_000,
      },
      {
        name: 'OpenAI newer family',
        provider: 'openai.chat',
        modelId: 'gpt-6-astra',
        body: {},
        retentionMs: 1_800_000,
      },
      {
        name: 'OpenAI explicit TTL',
        provider: 'openai.responses',
        modelId: 'gpt-5.6-terra',
        body: { prompt_cache_options: { ttl: '30m' } },
        retentionMs: 1_800_000,
      },
      {
        name: 'unsupported OpenAI TTL',
        provider: 'openai.responses',
        modelId: 'gpt-6-astra',
        body: { prompt_cache_options: { ttl: '2h' } },
        retentionMs: undefined,
      },
      {
        name: 'OpenAI older in-memory upper bound',
        provider: 'openai.chat',
        modelId: 'gpt-4.1',
        body: { prompt_cache_retention: 'in_memory' },
        retentionMs: 3_600_000,
      },
      {
        name: 'OpenAI older extended upper bound',
        provider: 'openai.responses',
        modelId: 'gpt-4.1',
        body: { prompt_cache_retention: '24h' },
        retentionMs: 86_400_000,
      },
      {
        name: 'OpenAI organization default is unknown',
        provider: 'openai.responses',
        modelId: 'gpt-4.1',
        body: {},
        retentionMs: undefined,
      },
      {
        name: 'OpenRouter OpenAI',
        provider: 'openrouter.chat',
        modelId: 'openai/gpt-5.6-terra',
        upstream: 'OpenAI',
        body: {},
        retentionMs: 1_800_000,
      },
      {
        name: 'OpenRouter Anthropic',
        provider: 'openrouter',
        modelId: 'anthropic/claude-sonnet-5',
        upstream: 'Anthropic',
        body: { cache_control: { type: 'ephemeral', ttl: '1h' } },
        retentionMs: 3_600_000,
      },
      {
        name: 'OpenRouter resolved model',
        provider: 'openrouter.chat',
        modelId: 'openrouter/auto',
        resolvedModel: 'openai/gpt-5.6-terra',
        upstream: 'OpenAI',
        body: {},
        retentionMs: 1_800_000,
      },
      {
        name: 'OpenRouter unknown upstream',
        provider: 'openrouter.chat',
        modelId: 'anthropic/claude-sonnet-5',
        upstream: 'Unknown host',
        body: { cache_control: { type: 'ephemeral' } },
        retentionMs: undefined,
      },
      {
        name: 'OpenRouter missing upstream',
        provider: 'openrouter.chat',
        modelId: 'openai/gpt-5.6-terra',
        body: {},
        retentionMs: undefined,
      },
      {
        name: 'Gemini implicit retention unknown',
        provider: 'google.generative-ai',
        modelId: 'gemini-3.5-flash-lite',
        body: {},
        retentionMs: undefined,
      },
      {
        name: 'unreported request body',
        provider: 'openai.responses',
        modelId: 'gpt-5.6-terra',
        body: undefined,
        retentionMs: undefined,
      },
      {
        name: 'unparseable request body',
        provider: 'anthropic.messages',
        modelId: 'claude-sonnet-5',
        body: 'invalid json',
        retentionMs: undefined,
      },
    ];
    for (const scenario of cases) {
      const decisions: boolean[] = [];
      const cold = cacheLikelyCold();
      const model = new MockLanguageModelV4({
        provider: scenario.provider,
        modelId: scenario.modelId,
        doStream: async () => ({
          request: { body: scenario.body },
          stream: simulateReadableStream({
            chunks: [
              {
                type: 'response-metadata',
                modelId: scenario.resolvedModel ?? scenario.modelId,
              },
              { type: 'text-start', id: 'policy' },
              { type: 'text-delta', id: 'policy', delta: 'OK' },
              { type: 'text-end', id: 'policy' },
              {
                type: 'finish',
                finishReason: { unified: 'stop', raw: undefined },
                usage: {
                  ...usage,
                  inputTokens: {
                    total: 100,
                    noCache: 0,
                    cacheRead: 100,
                    cacheWrite: 0,
                  },
                },
                providerMetadata:
                  scenario.upstream === undefined
                    ? undefined
                    : { openrouter: { provider: scenario.upstream } },
              },
            ],
            initialDelayInMs: null,
            chunkDelayInMs: null,
          }),
        }),
      });
      await using host = await new AgentRuntime(
        declaration(model, {
          ...compaction(summary),
          targetTokens: 100_000,
          triggers: [
            async (context) => {
              const result = await cold(context);
              decisions.push(result);
              return result;
            },
          ],
        }),
      ).initialize(stack);
      await host.work();
      assert.equal(
        (await send(host, `${scenario.name}: observe`)).status?.status,
        'completed',
      );
      assert.equal(
        z
          .object({
            promptCache: z.object({ retentionMs: z.number().optional() }),
          })
          .parse((await store.getChat(conversation.chatId))?.metadata?.zukhruf)
          .promptCache.retentionMs,
        scenario.retentionMs,
        scenario.name,
      );
      now += scenario.retentionMs ?? 86_400_000;
      assert.equal(
        (await send(host, `${scenario.name}: evaluate`)).status?.status,
        'completed',
      );
      assert.equal(
        decisions.at(-1),
        scenario.retentionMs !== undefined,
        scenario.name,
      );
    }
    assert.equal(
      summary.doGenerateCalls.length,
      cases.filter((scenario) => scenario.retentionMs !== undefined).length,
      'cold-cache matches summarize even below the target',
    );
  },
);

test(
  'cache evidence becomes unknown after absent usage, clock rollback, model changes, and rewinds',
  { timeout: 30_000 },
  async (t) => {
    await using resources = new AsyncDisposableStack();
    const { store, stack } = await infrastructure(resources);
    let now = Date.now();
    t.mock.method(Date, 'now', () => now);
    const ages: Array<number | undefined> = [];
    let reported: LanguageModelV4Usage = {
      ...usage,
      inputTokens: { total: 100, noCache: 0, cacheRead: 100, cacheWrite: 0 },
    };
    const response = (): LanguageModelV4StreamResult => ({
      stream: simulateReadableStream({
        chunks: [
          { type: 'text-start', id: 'answer' },
          { type: 'text-delta', id: 'answer', delta: 'Finished.' },
          { type: 'text-end', id: 'answer' },
          {
            type: 'finish',
            finishReason: { unified: 'stop', raw: undefined },
            usage: reported,
          },
        ],
      }),
    });
    const model = new MockLanguageModelV4({ doStream: async () => response() });
    const summary = summarizer();
    const cold = cacheLikelyCold({ retentionMs: 300_000 });
    const options = {
      ...compaction(summary),
      keepLastMessages: 1,
      triggers: [
        (context: Parameters<typeof cold>[0]) => {
          ages.push(context.cacheAgeMs);
          return cold(context);
        },
      ],
    };
    const host = resources.use(
      await new AgentRuntime(declaration(model, options)).initialize(stack),
    );
    await host.work();
    const firstId = crypto.randomUUID();
    await send(host, 'Prior findings. '.repeat(700), 'submit-message', firstId);
    now--;
    await send(host, 'Continue.');
    assert.equal(
      ages.at(-1),
      undefined,
      'clock rollback cannot make an old observation trustworthy',
    );
    reported = {
      ...usage,
      inputTokens: {
        total: 100,
        noCache: 100,
        cacheRead: undefined,
        cacheWrite: undefined,
      },
    };
    await send(host, 'Usage unavailable.');
    assert.partialDeepStrictEqual(
      (await store.getChat(conversation.chatId))?.metadata?.zukhruf,
      { promptCache: null },
    );
    now += 300_001;
    await send(host, 'No previous cache evidence.');
    assert.equal(ages.at(-1), undefined);
    reported = {
      ...usage,
      inputTokens: { total: 100, noCache: 0, cacheRead: 100, cacheWrite: 0 },
    };
    await send(host, 'Establish a new baseline.');
    await host[Symbol.asyncDispose]();

    now += 300_001;
    const otherModel = new MockLanguageModelV4({
      modelId: 'different-model',
      doStream: async () => response(),
    });
    const resumed = resources.use(
      await new AgentRuntime(declaration(otherModel, options)).initialize(
        stack,
      ),
    );
    await resumed.work();
    await send(resumed, 'Use the other model.');
    assert.equal(
      ages.at(-1),
      undefined,
      'another model cannot reuse the previous model observation',
    );
    now += 300_001;
    await send(
      resumed,
      'Prior findings. '.repeat(700),
      'regenerate-message',
      firstId,
    );
    assert.equal(
      ages.at(-1),
      undefined,
      'a rewound branch has no matching baseline',
    );
    assert.equal(summary.doGenerateCalls.length, 0);
  },
);

for (const [name, triggers] of [
  ['tokens', [tokensExceed(7_000)]],
  ['messages', [tokensExceed(Number.MAX_SAFE_INTEGER), messagesExceed(5)]],
] as const) {
  test(
    `${name} trigger compacts within a tool loop, preserves the transcript, and reuses checkpoints in a fresh host`,
    { timeout: 30_000 },
    async () => {
      await using resources = new AsyncDisposableStack();
      const { store, stack } = await infrastructure(resources);
      const summary = summarizer();
      const executed: number[] = [];
      const model: MockLanguageModelV4 = new MockLanguageModelV4({
        doStream: async () => {
          const step = model.doStreamCalls.length;
          if (step > 6) return answer();
          return stream(
            [
              {
                type: 'tool-call',
                toolCallId: `read-${step}`,
                toolName: 'inspect',
                input: JSON.stringify({ step }),
              },
            ],
            true,
          );
        },
      });
      const root = declaration(
        model,
        { ...compaction(summary), targetTokens: 6_000, triggers },
        {
          inspect: defineTool({
            description: 'Read a file',
            inputSchema: z.object({ step: z.number() }),
            execute: ({ step }) => {
              executed.push(step);
              return `File ${step} evidence: ${'x'.repeat(2_500)}`;
            },
          }),
        },
      );
      const runtime = new AgentRuntime(root);
      const host = await runtime.initialize(stack);
      resources.use(host);
      await host.work();
      const result = await send(host, 'Inspect six files for CASE-42.');
      assert.equal(result.status?.status, 'completed');
      assert.deepEqual(executed, [1, 2, 3, 4, 5, 6]);
      const events = compactionEvents(result.chunks);
      const completed = events.filter((event) => event.status === 'completed');
      assert.equal(completed.length, summary.doGenerateCalls.length);
      for (const event of completed) {
        const start = events.find((candidate) => candidate.id === event.id);
        assert.ok(start?.status === 'started');
        assert.ok(event.tokens.after < event.tokens.before);
        assert.ok(event.tokens.after <= 6_000);
        assert.ok(event.replacedRange.end > event.replacedRange.start);
        assert.ok(event.usage);
        assert.ok(events.indexOf(start) < events.indexOf(event));
      }
      const replay = await host.observe(conversation).resume();
      assert.ok(replay);
      const replayed = [];
      for await (const chunk of replay) replayed.push(chunk);
      assert.deepEqual(
        compactionEvents(replayed),
        events,
        'persisted stream replays lifecycle data',
      );
      assert.ok(
        summary.doGenerateCalls.length >= 2,
        'repeated compaction occurred within one user turn',
      );
      const app = new Hono<HttpEnv>();
      app.use('*', (context, next) => {
        context.set('userId', conversation.userId);
        return next();
      });
      app.route('/api', http(host));
      const response = await app.request(
        `/api/session/${conversation.chatId}/stream`,
      );
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('x-vercel-ai-ui-message-stream'), 'v1');
      assert.ok(response.body);
      const chunks = await Array.fromAsync(
        parseJsonEventStream({
          stream: response.body,
          schema: uiMessageChunkSchema,
        }),
        (chunk) => {
          assert.ok(chunk.success, 'every SSE frame is a UI message chunk');
          return chunk.value;
        },
      );
      assert.deepEqual(
        compactionEvents(chunks),
        events,
        'DevTool HTTP transport preserves the events',
      );
      const finalPrompt = JSON.stringify(model.doStreamCalls.at(-1)?.prompt);
      assert.match(finalPrompt, /Previous conversation summary/);
      assert.match(finalPrompt, /Inspect six files for CASE-42/);
      assert.doesNotMatch(finalPrompt, /File 1 evidence/);
      const original = await host.observe(conversation).engine.getMessages();
      for (let step = 1; step <= 6; step++)
        assert.match(
          JSON.stringify(original),
          new RegExp(`File ${step} evidence`),
        );
      assert.doesNotMatch(
        JSON.stringify(original),
        /Previous conversation summary/,
      );
      assert.doesNotMatch(finalPrompt, /data-compaction/);
      const session = await app.request(`/api/session/${conversation.chatId}`);
      assert.equal(session.status, 200);
      const transcript = transcriptSchema.parse(await session.json());
      assert.deepEqual(
        transcript.messages.flatMap((message) =>
          message.parts.flatMap((part) =>
            part.type === 'data-compaction' ? [part.data] : [],
          ),
        ),
        events,
        'reopening the conversation retains each lifecycle event exactly once',
      );
      const saved = (await store.getChat(conversation.chatId))?.metadata
        ?.zukhruf;
      assert.ok(saved && typeof saved === 'object' && 'compaction' in saved);

      await host[Symbol.asyncDispose]();
      const resumedRuntime = new AgentRuntime(root);
      await using resumed = await resumedRuntime.initialize(stack);
      await resumed.work();
      const calls = summary.doGenerateCalls.length;
      const restored = await send(resumed, 'What did you find?');
      assert.equal(restored.status?.status, 'completed');
      assert.equal(compactionEvents(restored.chunks)[0]?.status, 'restored');
      assert.equal(
        summary.doGenerateCalls.length,
        calls + (name === 'messages' ? 1 : 0),
        'restart restores the checkpoint, then evaluates triggers on the new context',
      );
      assert.match(
        JSON.stringify(model.doStreamCalls.at(-1)?.prompt),
        /Previous conversation summary/,
      );
      assert.doesNotMatch(
        JSON.stringify(model.doStreamCalls.at(-1)?.prompt),
        /File 1 evidence/,
      );

      // A rewind before the checkpoint must not apply a summary from the future.
      assert.equal(
        (
          await send(
            resumed,
            'Inspect six files for CASE-42.',
            'regenerate-message',
            original[0].id,
          )
        ).status?.status,
        'completed',
      );
      assert.doesNotMatch(
        JSON.stringify(model.doStreamCalls.at(-1)?.prompt),
        /Previous conversation summary/,
      );
    },
  );
}

test(
  'summary failures stop sampling without replacing history or an existing checkpoint',
  { timeout: 30_000 },
  async () => {
    await using resources = new AsyncDisposableStack();
    const { store, stack } = await infrastructure(resources);
    const summary = summarizer();
    const model = new MockLanguageModelV4({ doStream: answer });
    const runtime = new AgentRuntime(
      declaration(model, { ...compaction(summary), keepLastMessages: 1 }),
    );
    await using host = await runtime.initialize(stack);
    await host.work();
    const cannotFit = await send(host, 'Old source. '.repeat(700));
    assert.equal(cannotFit.status?.status, 'failed');
    assert.deepEqual(
      compactionEvents(cannotFit.chunks).map(({ status }) => status),
      ['started', 'failed'],
    );
    assert.partialDeepStrictEqual(compactionEvents(cannotFit.chunks).at(-1), {
      phase: 'compact',
      reason: 'no-safe-boundary',
    });
    assert.equal(model.doStreamCalls.length, 0);
    assert.equal(
      (await send(host, 'Continue CASE-42.')).status?.status,
      'completed',
    );
    const previous = (await store.getChat(conversation.chatId))?.metadata
      ?.zukhruf;
    assert.ok(
      previous && typeof previous === 'object' && 'compaction' in previous,
    );
    const calls = model.doStreamCalls.length;
    summary.doGenerate = async () => {
      throw new Error('summary provider unavailable');
    };
    // The latest request is still retained; only the older accumulated evidence is summarized.
    await send(host, 'Another source. '.repeat(700));
    const failed = await send(host, 'Use the new evidence.');
    assert.equal(failed.status?.status, 'failed');
    assert.deepEqual(
      compactionEvents(failed.chunks).map(({ status }) => status),
      ['restored', 'started', 'failed'],
    );
    assert.partialDeepStrictEqual(compactionEvents(failed.chunks).at(-1), {
      phase: 'compact',
      reason: 'error',
    });
    assert.doesNotMatch(
      JSON.stringify(compactionEvents(failed.chunks)),
      /summary provider unavailable/,
    );
    assert.deepEqual(
      (await host.observe(conversation).engine.getMessages())
        .at(-1)
        ?.parts.flatMap((part) =>
          part.type === 'data-compaction' ? [part.data] : [],
        ),
      compactionEvents(failed.chunks),
      'failed compaction remains visible after reopening',
    );
    assert.equal(model.doStreamCalls.length, calls);
    assert.partialDeepStrictEqual(
      (await store.getChat(conversation.chatId))?.metadata?.zukhruf,
      { compaction: previous.compaction },
    );
    const history = JSON.stringify(
      await host.observe(conversation).engine.getMessages(),
    );
    assert.match(history, /Old source/);
    assert.match(history, /Another source/);
    assert.doesNotMatch(history, /Previous conversation summary/);
  },
);

test(
  'compaction reports a checkpoint write failure without claiming completion',
  { timeout: 30_000 },
  async (t) => {
    await using resources = new AsyncDisposableStack();
    const { store, stack } = await infrastructure(resources);
    const summary = summarizer();
    const model = new MockLanguageModelV4({ doStream: answer });
    const runtime = new AgentRuntime(
      declaration(model, {
        ...compaction(summary),
        triggers: [messagesExceed(2)],
      }),
    );
    await using host = await runtime.initialize(stack);
    await host.work();
    await send(host, 'Prior findings. '.repeat(700));
    const updateChat = store.updateChat.bind(store);
    t.mock.method(
      store,
      'updateChat',
      (...[id, update]: Parameters<typeof updateChat>) =>
        updateChat(id, (current) => {
          const next = update(current);
          const metadata = next?.metadata?.zukhruf;
          if (
            metadata &&
            typeof metadata === 'object' &&
            'compaction' in metadata
          ) {
            throw new Error('checkpoint write failed');
          }
          return next;
        }),
    );
    const result = await send(host, 'Continue CASE-42.');
    assert.equal(result.status?.status, 'failed');
    const events = compactionEvents(result.chunks);
    assert.deepEqual(
      events.map(({ status }) => status),
      ['started', 'failed'],
    );
    assert.partialDeepStrictEqual(events.at(-1), {
      phase: 'persist',
      reason: 'error',
    });
    assert.equal(model.doStreamCalls.length, 1);
    assert.equal(summary.doGenerateCalls.length, 1);
    assert.doesNotMatch(
      JSON.stringify((await store.getChat(conversation.chatId))?.metadata),
      /"compaction":/,
    );
  },
);

test('compaction is opt-in and validates its budget and triggers', () => {
  assert.equal(declaration(new MockLanguageModelV4()).compaction, undefined);
  for (const targetTokens of [
    0,
    -1,
    1.5,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    assert.throws(
      () =>
        declaration(new MockLanguageModelV4(), {
          ...compaction(summarizer()),
          targetTokens,
        }),
      /targetTokens/,
    );
  }
  assert.throws(
    () =>
      declaration(new MockLanguageModelV4(), {
        ...compaction(summarizer()),
        triggers: [],
      }),
    /triggers must be a non-empty array of functions/,
  );
});

test(
  'triggers await async decisions, short-circuit, compact below target, and propagate errors',
  { timeout: 30_000 },
  async () => {
    await using resources = new AsyncDisposableStack();
    const { store, stack } = await infrastructure(resources);
    const summary = summarizer();
    const model = new MockLanguageModelV4({ doStream: answer });
    const evaluated: string[] = [];
    let mode: 'skip' | 'match' | 'fail' = 'skip';
    let counts = 0;
    const runtime = new AgentRuntime(
      declaration(model, {
        ...compaction(summary),
        countTokens: (messages) => {
          counts++;
          return countTokens(messages);
        },
        triggers: [
          async ({ messages, tokens }) => {
            evaluated.push('first');
            assert.ok(
              tokens > countTokens(messages),
              'the custom message counter is augmented with the request envelope',
            );
            if (mode === 'fail') throw new Error('trigger failed');
            return mode === 'match';
          },
          () => {
            evaluated.push('second');
            return false;
          },
        ],
      }),
    );
    await using host = await runtime.initialize(stack);
    await host.work();
    const quiet = await send(host, 'Prior findings. '.repeat(700));
    assert.equal(quiet.status?.status, 'completed');
    assert.deepEqual(compactionEvents(quiet.chunks), []);
    assert.deepEqual(evaluated, ['first', 'second']);
    assert.equal(counts, 1, 'all triggers share one token estimate');
    assert.equal(summary.doGenerateCalls.length, 0);

    evaluated.length = 0;
    mode = 'match';
    const compacted = await send(host, 'Continue.');
    assert.equal(compacted.status?.status, 'completed');
    assert.deepEqual(
      compactionEvents(compacted.chunks).map(({ status }) => status),
      ['started', 'completed'],
    );
    assert.partialDeepStrictEqual(compactionEvents(compacted.chunks)[0], {
      triggerIndex: 0,
      targetTokens: 4_000,
    });
    assert.deepEqual(evaluated, ['first']);
    assert.equal(summary.doGenerateCalls.length, 1);
    const repeated = await send(host, 'What next?');
    assert.equal(repeated.status?.status, 'completed');
    const repeatedEvents = compactionEvents(repeated.chunks);
    assert.deepEqual(
      repeatedEvents.map(({ status }) => status),
      ['restored', 'started', 'completed'],
    );
    const started = repeatedEvents.find((event) => event.status === 'started');
    assert.ok(started?.status === 'started');
    assert.ok(started.tokensBefore < started.targetTokens);
    assert.equal(summary.doGenerateCalls.length, 2);
    const previous = (await store.getChat(conversation.chatId))?.metadata
      ?.zukhruf;
    assert.ok(
      previous && typeof previous === 'object' && 'compaction' in previous,
    );

    evaluated.length = 0;
    mode = 'fail';
    const failure = await send(host, 'Continue again.');
    assert.equal(failure.status?.status, 'failed');
    assert.partialDeepStrictEqual(compactionEvents(failure.chunks).at(-1), {
      status: 'failed',
      phase: 'evaluate',
      reason: 'error',
    });
    assert.deepEqual(evaluated, ['first']);
    assert.equal(
      model.doStreamCalls.length,
      3,
      'trigger failure stops sampling',
    );
    const metadata = (await store.getChat(conversation.chatId))?.metadata
      ?.zukhruf;
    assert.partialDeepStrictEqual(metadata, {
      compaction: previous.compaction,
    });
  },
);

test(
  'approval continuation reuses the checkpoint and executes the approved tool once',
  { timeout: 30_000 },
  async () => {
    await using resources = new AsyncDisposableStack();
    const { stack } = await infrastructure(resources);
    const summary = summarizer();
    let executed = 0;
    const model: MockLanguageModelV4 = new MockLanguageModelV4({
      doStream: async () =>
        model.doStreamCalls.length === 1
          ? stream(
              [
                {
                  type: 'tool-call',
                  toolCallId: 'approved-read',
                  toolName: 'inspect',
                  input: '{}',
                },
              ],
              true,
            )
          : answer(),
    });
    const root = declaration(
      model,
      { ...compaction(summary), keepLastMessages: 1 },
      {
        inspect: defineTool({
          description: 'Read after approval',
          inputSchema: z.object({}),
          needsApproval: true,
          execute: () => {
            executed++;
            return 'Verified CASE-42.';
          },
        }),
      },
    );
    const runtime = new AgentRuntime(root);
    await using host = await runtime.initialize(stack);
    await host.work();
    await send(host, 'Prior findings. '.repeat(700));
    await send(host, 'Inspect CASE-42 after approval.');
    assert.equal(summary.doGenerateCalls.length, 1);
    assert.equal(executed, 0);
    const head = (await host.observe(conversation).engine.getMessages()).at(-1);
    assert.ok(head?.role === 'assistant');
    const request = head.parts.find(isToolUIPart);
    assert.ok(request?.state === 'approval-requested');
    const continued = await host.enqueue(conversation, {
      message: {
        ...head,
        role: 'assistant',
        parts: head.parts.map((part) =>
          part === request
            ? {
                ...request,
                state: 'approval-responded',
                approval: { ...request.approval, approved: true },
              }
            : part,
        ),
      },
      trigger: 'submit-message',
    });
    for await (const chunk of continued.stream) void chunk;
    assert.equal(
      (await host.observe(conversation).status(continued.id))?.status,
      'completed',
    );
    assert.equal(executed, 1);
    assert.equal(summary.doGenerateCalls.length, 1);
    assert.match(
      JSON.stringify(model.doStreamCalls.at(-1)?.prompt),
      /Verified CASE-42/,
    );
    assert.match(
      JSON.stringify(model.doStreamCalls.at(-1)?.prompt),
      /Previous conversation summary/,
    );
  },
);

test(
  'cancellation aborts summarization before any checkpoint or main model call',
  { timeout: 30_000 },
  async (t) => {
    await using resources = new AsyncDisposableStack();
    const { store, stack } = await infrastructure(resources);
    const entered = Promise.withResolvers<void>();
    const summary = new MockLanguageModelV4({
      doGenerate: async ({ abortSignal }) => {
        assert.ok(abortSignal);
        entered.resolve();
        abortSignal.throwIfAborted();
        await once(abortSignal, 'abort');
        throw abortSignal.reason;
      },
    });
    const model = new MockLanguageModelV4({ doStream: answer });
    const runtime = new AgentRuntime(
      declaration(model, { ...compaction(summary), keepLastMessages: 1 }),
    );
    await using host = await runtime.initialize(stack);
    await host.work();
    await send(host, 'Prior findings. '.repeat(700));
    const pending = await host.enqueue(conversation, {
      message: {
        id: crypto.randomUUID(),
        role: 'user',
        parts: [{ type: 'text', text: 'Continue CASE-42.' }],
      },
      trigger: 'submit-message',
    });
    const chunks: UIMessageChunk[] = [];
    const reading = (async () => {
      for await (const chunk of pending.stream) chunks.push(chunk);
    })();
    await entered.promise;
    await t.waitFor(() =>
      assert.equal(compactionEvents(chunks)[0]?.status, 'started'),
    );
    assert.equal(
      (await host.observe(conversation).status(pending.id))?.status,
      'running',
    );
    await host.observe(conversation).cancel();
    await reading;
    assert.equal(
      (await host.observe(conversation).status(pending.id))?.status,
      'cancelled',
    );
    assert.deepEqual(
      compactionEvents(chunks).map(({ status }) => status),
      ['started'],
    );
    await t.waitFor(async () =>
      assert.deepEqual(
        (await host.observe(conversation).engine.getMessages())
          .at(-1)
          ?.parts.flatMap((part) =>
            part.type === 'data-compaction' ? [part.data] : [],
          ),
        compactionEvents(chunks),
        'an interrupted attempt remains visible after reopening',
      ),
    );
    assert.equal(model.doStreamCalls.length, 0);
    assert.equal(summary.doGenerateCalls.length, 1);
    const saved = (await store.getChat(conversation.chatId))?.metadata?.zukhruf;
    assert.ok(saved && typeof saved === 'object');
    assert.equal('compaction' in saved, false);
    assert.match(
      JSON.stringify(await host.observe(conversation).engine.getMessages()),
      /Prior findings/,
    );
  },
);
