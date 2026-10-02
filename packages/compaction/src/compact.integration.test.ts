import { type ModelMessage, generateText } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';

import {
  type CompactOptions,
  cacheLikelyCold,
  compact,
  estimateTokens,
  messagesExceed,
  tokensExceed,
} from '@deepagents/compaction';

const summary = 'Order 42 is pending. Delivery must be confirmed by Friday.';
const response = {
  content: [{ type: 'text', text: summary }],
  finishReason: { unified: 'stop', raw: 'stop' },
  usage: {
    inputTokens: { total: 120, noCache: 120, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 15, text: 15, reasoning: 0 },
  },
  warnings: [],
} satisfies Awaited<ReturnType<MockLanguageModelV4['doGenerate']>>;

const history: ModelMessage[] = [
  { role: 'user', content: 'Order 42 must arrive by Friday. '.repeat(100) },
  {
    role: 'assistant',
    content: 'The carrier has not confirmed delivery. '.repeat(100),
  },
  { role: 'user', content: 'Retain the tracking number TRACK-42.' },
  { role: 'assistant', content: 'I recorded the tracking number.' },
  { role: 'user', content: 'What remains to be done?' },
];

test('uses a portable estimate when compacting multilingual code history', async () => {
  const messages: ModelMessage[] = [
    {
      role: 'user',
      content: 'احتفظ بالقرارات والمتطلبات. const id = "ORDER-42"; '.repeat(20),
    },
    { role: 'assistant', content: 'Recorded.' },
    { role: 'user', content: 'Continue.' },
  ];
  const model = new MockLanguageModelV4({ doGenerate: response });
  const result = await compact({
    messages,
    model,
    targetTokens: 150,
    keepLastMessages: 1,
  });
  assert.equal(result.status, 'compacted');
  assert.equal(
    result.tokens.before,
    Math.ceil(JSON.stringify(messages).length / 4),
  );
  assert.equal(
    result.tokens.after,
    Math.ceil(JSON.stringify(result.messages).length / 4),
  );
  assert.ok(result.tokens.after <= 150);
  assert.equal(model.doGenerateCalls.length, 1);
});

test('cache age selects compaction using provider retention or an explicit override', async () => {
  const trigger = cacheLikelyCold();
  const context = {
    messages: history,
    tokens: estimateTokens(history),
    cacheRetentionMs: 300_000,
  };
  for (const cacheAgeMs of [undefined, -1, 0, 299_999]) {
    assert.equal(await trigger({ ...context, cacheAgeMs }), false);
  }
  assert.equal(await trigger({ ...context, cacheAgeMs: 300_000 }), true);
  assert.equal(
    await trigger({
      ...context,
      cacheAgeMs: 300_000,
      cacheRetentionMs: undefined,
    }),
    false,
  );
  assert.equal(
    await cacheLikelyCold({ retentionMs: 600_000 })({
      ...context,
      cacheAgeMs: 300_000,
    }),
    false,
  );
  assert.equal(
    await cacheLikelyCold({ retentionMs: 600_000 })({
      ...context,
      cacheAgeMs: 600_000,
      cacheRetentionMs: undefined,
    }),
    true,
  );
  const model = new MockLanguageModelV4({ doGenerate: response });
  const result = await compact({
    messages: history,
    model,
    targetTokens: 300,
    keepLastMessages: 2,
  });
  assert.equal(result.status, 'compacted');
  assert.equal(model.doGenerateCalls.length, 1);
  for (const retentionMs of [
    0,
    -1,
    0.5,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    assert.throws(
      () => cacheLikelyCold({ retentionMs }),
      /positive safe integer/,
    );
  }
});

test('public triggers select a snapshot for compaction and stop matching its replacement', async () => {
  const context = { messages: history, tokens: estimateTokens(history) };
  for (const [factory, threshold] of [
    [tokensExceed, context.tokens],
    [messagesExceed, history.length],
  ] as const) {
    assert.equal(
      await factory(threshold)(context),
      false,
      'equality does not trigger',
    );
    const trigger = factory(threshold - 1);
    assert.equal(await trigger(context), true);
    const model = new MockLanguageModelV4({ doGenerate: response });
    const result = await compact({
      messages: context.messages,
      model,
      targetTokens: 300,
      keepLastMessages: 2,
    });
    assert.equal(result.status, 'compacted');
    assert.equal(model.doGenerateCalls.length, 1);
    assert.equal(
      await trigger({ messages: result.messages, tokens: result.tokens.after }),
      false,
    );
    for (const invalid of [
      0,
      -1,
      1.5,
      NaN,
      Infinity,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      assert.throws(() => factory(invalid), /positive safe integer/);
    }
  }
});

test('compacts through the public API and feeds the result into a native AI SDK request', async () => {
  const snapshot = structuredClone(history);
  const messages = Object.freeze(
    snapshot.map((message) => Object.freeze(message)),
  );
  const model = new MockLanguageModelV4({ doGenerate: response });
  const result = await compact({
    messages,
    model,
    targetTokens: 300,
    keepLastMessages: 2,
    instructions: 'Preserve exact tracking numbers.',
  });

  assert.equal(result.status, 'compacted');
  if (result.status !== 'compacted') return;
  assert.deepEqual(result.replacedRange, { start: 0, end: 3 });
  assert.equal(result.summary, summary);
  assert.ok(result.tokens.before > 300);
  assert.ok(result.tokens.after <= 300);
  assert.deepEqual(result.messages.slice(1), history.slice(3));
  assert.equal(result.messages[1], messages[3]);
  assert.deepEqual(messages, history);
  assert.equal(result.usage?.inputTokens, 120);
  assert.equal(result.usage?.outputTokens, 15);
  assert.equal(model.doGenerateCalls.length, 1);
  assert.match(
    JSON.stringify(model.doGenerateCalls[0].prompt),
    /Preserve exact tracking numbers/,
  );
  const prompt = model.doGenerateCalls[0].prompt.at(-1);
  assert.equal(prompt?.role, 'user');
  if (prompt?.role === 'user') {
    assert.deepEqual(prompt.content, [
      { type: 'text', text: JSON.stringify(history.slice(0, 3)) },
    ]);
  }

  const continuation = new MockLanguageModelV4({ doGenerate: response });
  const reply = await generateText({
    model: continuation,
    messages: result.messages,
  });
  assert.equal(reply.text, summary);
  assert.match(
    JSON.stringify(continuation.doGenerateCalls[0].prompt),
    /Previous conversation summary/,
  );
  assert.equal(
    result.messages.some((message) => message.role === 'system'),
    false,
  );
});

test('compacts 41 short messages below the target when their count triggers it', async () => {
  const messages: ModelMessage[] = Array.from({ length: 41 }, (_, index) => ({
    role: index % 2 ? 'assistant' : 'user',
    content: 'Short message.',
  }));
  assert.equal(
    await messagesExceed(40)({ messages, tokens: estimateTokens(messages) }),
    true,
  );
  const model = new MockLanguageModelV4({ doGenerate: response });
  const result = await compact({
    messages,
    model,
    targetTokens: 4_000,
  });
  assert.equal(result.status, 'compacted');
  assert.ok(result.tokens.before < 4_000);
  assert.ok(result.tokens.after < result.tokens.before);
  assert.deepEqual(result.messages.slice(1), messages.slice(-4));
  assert.equal(model.doGenerateCalls.length, 1);
  const empty = await compact({ messages: [], model, targetTokens: 1 });
  assert.deepEqual(empty.tokens, { before: 0, after: 0 });
  assert.equal(empty.status, 'cannot-fit');
  if (empty.status === 'cannot-fit')
    assert.equal(empty.reason, 'no-safe-boundary');
});

test('counts tokenizer control strings as literal conversation text', async () => {
  const messages: ModelMessage[] = [
    { role: 'user', content: 'Explain <|endoftext|> and <|fim_prefix|>.' },
  ];
  const result = await compact({
    messages,
    model: new MockLanguageModelV4(),
    targetTokens: 300,
  });
  assert.equal(result.status, 'cannot-fit');
  assert.deepEqual(result.messages, messages);
  assert.ok(result.tokens.before > 0);
});

test('does not adopt or execute a tool call emitted by the summarizer', async () => {
  const model = new MockLanguageModelV4({
    doGenerate: {
      ...response,
      content: [
        ...response.content,
        {
          type: 'tool-call',
          toolCallId: 'unexpected',
          toolName: 'send',
          input: '{}',
        },
      ],
    },
  });
  const result = await compact({
    messages: history,
    model,
    targetTokens: 300,
    keepLastMessages: 2,
  });
  assert.equal(result.status, 'cannot-fit');
  if (result.status === 'cannot-fit')
    assert.equal(result.reason, 'incomplete-summary');
  assert.deepEqual(result.messages, history);
  assert.equal(model.doGenerateCalls.length, 1);
});

test('retains four recent messages by default and preserves leading system messages', async () => {
  const system: ModelMessage = {
    role: 'system',
    content: 'Keep the customer data private.',
  };
  const messages = [system, ...history];
  const result = await compact({
    messages,
    model: new MockLanguageModelV4({ doGenerate: response }),
    targetTokens: 1_200,
  });
  assert.equal(result.status, 'compacted');
  if (result.status !== 'compacted') return;
  assert.deepEqual(result.replacedRange, { start: 1, end: 2 });
  assert.equal(result.messages[0], system);
  assert.deepEqual(result.messages.slice(2), history.slice(1));
});

test('allows a caller to reuse and compact an earlier result without hidden state', async () => {
  const model = new MockLanguageModelV4({ doGenerate: [response, response] });
  const first = await compact({
    messages: history,
    model,
    targetTokens: 300,
    keepLastMessages: 2,
  });
  assert.equal(first.status, 'compacted');
  const replay = await compact({
    messages: first.messages,
    model,
    targetTokens: 300,
  });
  assert.equal(replay.status, 'cannot-fit');
  if (replay.status === 'cannot-fit')
    assert.equal(replay.reason, 'no-safe-boundary');
  assert.deepEqual(replay.messages, first.messages);
  assert.equal(model.doGenerateCalls.length, 1);

  const next: ModelMessage[] = [
    ...first.messages,
    { role: 'assistant', content: 'New carrier evidence. '.repeat(200) },
    { role: 'user', content: 'Please check again.' },
  ];
  const second = await compact({
    messages: next,
    model,
    targetTokens: 300,
    keepLastMessages: 1,
  });
  assert.equal(second.status, 'compacted');
  assert.equal(model.doGenerateCalls.length, 2);
  assert.match(
    JSON.stringify(model.doGenerateCalls[1].prompt),
    /Order 42 is pending/,
  );
  assert.match(
    JSON.stringify(model.doGenerateCalls[1].prompt),
    /New carrier evidence/,
  );
  assert.equal(second.messages.at(-1), next.at(-1));
});

test('expands retention across overlapping tool calls and an approval round trip', async () => {
  const messages: ModelMessage[] = [
    ...history.slice(0, 2),
    {
      role: 'assistant',
      content: [
        {
          type: 'tool-call',
          toolCallId: 'a',
          toolName: 'lookup',
          input: { id: 42 },
        },
      ],
    },
    {
      role: 'assistant',
      content: [
        {
          type: 'tool-call',
          toolCallId: 'b',
          toolName: 'lookup',
          input: { id: 43 },
        },
        {
          type: 'tool-approval-request',
          approvalId: 'approve-b',
          toolCallId: 'b',
          signature: 'keep-signature',
          isAutomatic: true,
        },
      ],
    },
    {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'a',
          toolName: 'lookup',
          output: { type: 'text', value: 'Pending.' },
        },
      ],
    },
    {
      role: 'tool',
      content: [
        {
          type: 'tool-approval-response',
          approvalId: 'approve-b',
          approved: false,
        },
        {
          type: 'tool-result',
          toolCallId: 'b',
          toolName: 'lookup',
          output: { type: 'execution-denied' },
        },
      ],
    },
    { role: 'user', content: 'Continue.' },
  ];
  const original = structuredClone(messages);
  const result = await compact({
    messages,
    model: new MockLanguageModelV4({ doGenerate: response }),
    targetTokens: 500,
    keepLastMessages: 3,
  });
  assert.equal(result.status, 'compacted');
  if (result.status !== 'compacted') return;
  assert.deepEqual(result.replacedRange, { start: 0, end: 2 });
  assert.deepEqual(result.messages.slice(1), messages.slice(2));
  assert.equal(result.messages[2], messages[3]);
  assert.equal(result.messages[4], messages[5]);
  assert.deepEqual(messages, original);
});

test('summarizes completed tool exchanges together when the whole exchange precedes the cut', async () => {
  const messages: ModelMessage[] = [
    history[0],
    {
      role: 'assistant',
      content: [
        {
          type: 'tool-call',
          toolCallId: 'done',
          toolName: 'lookup',
          input: { id: 42 },
        },
      ],
    },
    {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'done',
          toolName: 'lookup',
          output: { type: 'json', value: { tracking: 'TRACK-42' } },
        },
      ],
    },
    { role: 'user', content: 'Continue.' },
  ];
  const model = new MockLanguageModelV4({ doGenerate: response });
  const result = await compact({
    messages,
    model,
    targetTokens: 300,
    keepLastMessages: 1,
  });
  assert.equal(result.status, 'compacted');
  if (result.status !== 'compacted') return;
  assert.deepEqual(result.replacedRange, { start: 0, end: 3 });
  const prompt = JSON.stringify(model.doGenerateCalls[0].prompt);
  assert.match(prompt, /tool-call/);
  assert.match(prompt, /tool-result/);
  assert.match(prompt, /TRACK-42/);
  assert.equal(result.messages.at(-1), messages.at(-1));
});

test('preserves an unresolved approval and tool call even before the latest user request', async () => {
  const pending: ModelMessage[] = [
    {
      role: 'assistant',
      content: [
        {
          type: 'tool-call',
          toolCallId: 'pending',
          toolName: 'send',
          input: {},
        },
        {
          type: 'tool-approval-request',
          approvalId: 'approval',
          toolCallId: 'pending',
        },
      ],
    },
    { role: 'user', content: 'Wait for my approval.' },
  ];
  const messages = [...history.slice(0, 2), ...pending];
  const result = await compact({
    messages,
    model: new MockLanguageModelV4({ doGenerate: response }),
    targetTokens: 300,
    keepLastMessages: 1,
  });
  assert.equal(result.status, 'compacted');
  assert.deepEqual(result.messages.slice(1), pending);

  const model = new MockLanguageModelV4();
  const blocked = await compact({
    messages: [pending[0], ...history],
    model,
    targetTokens: 300,
    keepLastMessages: 1,
  });
  assert.equal(blocked.status, 'cannot-fit');
  if (blocked.status === 'cannot-fit')
    assert.equal(blocked.reason, 'no-safe-boundary');
  assert.equal(model.doGenerateCalls.length, 0);
});

test('does not discard a protected recent tool exchange to meet a budget', async () => {
  const messages: ModelMessage[] = [
    ...history.slice(0, 2),
    { role: 'user', content: 'Inspect the logs.' },
    {
      role: 'assistant',
      content: [
        { type: 'tool-call', toolCallId: 'logs', toolName: 'read', input: {} },
      ],
    },
    {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'logs',
          toolName: 'read',
          output: { type: 'text', value: 'A large current log. '.repeat(500) },
        },
      ],
    },
  ];
  const model = new MockLanguageModelV4();
  const result = await compact({
    messages,
    model,
    targetTokens: 300,
    keepLastMessages: 1,
  });
  assert.equal(result.status, 'cannot-fit');
  if (result.status === 'cannot-fit')
    assert.equal(result.reason, 'protected-history');
  assert.deepEqual(result.messages, messages);
  assert.equal(model.doGenerateCalls.length, 0);
});

test('compacts completed steps within one user turn and replays the active request verbatim', async () => {
  const request: ModelMessage = {
    role: 'user',
    content: 'Inspect six files for CASE-42.',
  };
  const messages: ModelMessage[] = [request];
  for (let index = 0; index < 6; index++) {
    messages.push(
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: `read-${index}`,
            toolName: 'read',
            input: { index },
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: `read-${index}`,
            toolName: 'read',
            output: { type: 'text', value: `Finding ${index}. `.repeat(100) },
          },
        ],
      },
    );
  }
  const result = await compact({
    messages,
    model: new MockLanguageModelV4({ doGenerate: response }),
    targetTokens: 900,
    keepLastMessages: 2,
  });
  assert.equal(result.status, 'compacted');
  assert.equal(result.messages[1], request);
  assert.deepEqual(result.messages.slice(2), messages.slice(-2));
  assert.ok(result.tokens.after <= 900);
});

test('retains a system instruction inserted later in the conversation', async () => {
  const messages: ModelMessage[] = [
    ...history.slice(0, 2),
    { role: 'system', content: 'New constraint: never contact the carrier.' },
    ...history.slice(2),
  ];
  const result = await compact({
    messages,
    model: new MockLanguageModelV4({ doGenerate: response }),
    targetTokens: 300,
    keepLastMessages: 1,
  });
  assert.equal(result.status, 'compacted');
  if (result.status === 'compacted')
    assert.deepEqual(result.replacedRange, { start: 0, end: 2 });
  assert.deepEqual(result.messages.slice(1), messages.slice(2));
});

test('requires a media token counter and preserves binary content with that counter', async () => {
  const file: ModelMessage = {
    role: 'user',
    content: [
      {
        type: 'file',
        mediaType: 'application/pdf',
        data: new Uint8Array([1, 2, 3]),
      },
    ],
  };
  const messages = [...history.slice(0, 2), file, ...history.slice(2)];
  const model = new MockLanguageModelV4({ doGenerate: response });
  await assert.rejects(
    compact({ messages, model, targetTokens: 300 }),
    /provide countTokens/,
  );
  assert.equal(model.doGenerateCalls.length, 0);
  const result = await compact({
    messages,
    model,
    targetTokens: 300,
    keepLastMessages: 1,
    countTokens: async (input) =>
      input.reduce(
        (sum, message) =>
          sum +
          (typeof message.content === 'string'
            ? Math.ceil(message.content.length / 4)
            : 100),
        0,
      ),
  });
  assert.equal(result.status, 'compacted');
  if (result.status === 'compacted')
    assert.deepEqual(result.replacedRange, { start: 0, end: 2 });
  assert.equal(result.messages[1], file);
  assert.deepEqual(result.messages.slice(1), messages.slice(2));
});

for (const scenario of [
  {
    name: 'oversized',
    text: 'Very long summary. '.repeat(1_000),
    finishReason: 'stop',
    reason: 'summary-too-large',
  },
  {
    name: 'truncated',
    text: summary,
    finishReason: 'length',
    reason: 'incomplete-summary',
  },
  { name: 'empty', text: '   ', finishReason: 'stop', reason: 'empty-summary' },
] as const) {
  test(`returns original history and usage for an ${scenario.name} summary`, async () => {
    const model = new MockLanguageModelV4({
      doGenerate: {
        ...response,
        content: [{ type: 'text', text: scenario.text }],
        finishReason: {
          unified: scenario.finishReason,
          raw: scenario.finishReason,
        },
      },
    });
    const result = await compact({
      messages: history,
      model,
      targetTokens: 300,
      keepLastMessages: 2,
    });
    assert.equal(result.status, 'cannot-fit');
    if (result.status === 'cannot-fit')
      assert.equal(result.reason, scenario.reason);
    assert.deepEqual(result.messages, history);
    assert.equal(result.tokens.after, result.tokens.before);
    assert.equal(result.usage?.totalTokens, 135);
    assert.equal(model.doGenerateCalls.length, 1);
    assert.ok((model.doGenerateCalls[0].maxOutputTokens ?? 0) > 0);
    assert.ok((model.doGenerateCalls[0].maxOutputTokens ?? 0) <= 300);
  });
}

test('validates budgets, counters, and native messages before calling a model', async () => {
  const model = new MockLanguageModelV4();
  for (const targetTokens of [
    0,
    -1,
    1.5,
    Infinity,
    NaN,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    await assert.rejects(
      compact({ messages: history, model, targetTokens }),
      /targetTokens/,
    );
  }
  await assert.rejects(
    compact({
      messages: history,
      model,
      targetTokens: 300,
      keepLastMessages: 0,
    }),
    /keepLastMessages/,
  );
  for (const tokens of [-1, NaN, Infinity, 0.5]) {
    await assert.rejects(
      compact({
        messages: history,
        model,
        targetTokens: 300,
        countTokens: () => tokens,
      }),
      /countTokens/,
    );
  }
  await assert.rejects(
    compact({
      messages: JSON.parse('[{"role":"bad","content":"hello"}]'),
      model,
      targetTokens: 300,
    }),
  );
  assert.equal(model.doGenerateCalls.length, 0);
});

test('propagates provider errors without retries or input changes', async () => {
  const failure = new Error('Provider unavailable');
  const model = new MockLanguageModelV4({
    doGenerate: async () => {
      throw failure;
    },
  });
  const original = structuredClone(history);
  await assert.rejects(
    compact({
      messages: history,
      model,
      targetTokens: 300,
      keepLastMessages: 2,
    }),
    (error) => error === failure,
  );
  assert.equal(model.doGenerateCalls.length, 1);
  assert.deepEqual(history, original);
});

test('honors cancellation before and during summarization', async () => {
  const entered = Promise.withResolvers<void>();
  const model = new MockLanguageModelV4({
    doGenerate: async (options) => {
      assert.ok(options.abortSignal);
      entered.resolve();
      await once(options.abortSignal, 'abort');
      throw options.abortSignal.reason;
    },
  });
  const base: CompactOptions = {
    messages: history,
    model,
    targetTokens: 300,
    keepLastMessages: 2,
  };
  await assert.rejects(compact({ ...base, abortSignal: AbortSignal.abort() }), {
    name: 'AbortError',
  });
  assert.equal(model.doGenerateCalls.length, 0);
  const controller = new AbortController();
  const pending = compact({ ...base, abortSignal: controller.signal });
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await entered.promise;
  controller.abort();
  await rejected;
  assert.equal(model.doGenerateCalls.length, 1);
});
