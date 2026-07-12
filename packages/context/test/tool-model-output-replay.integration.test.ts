import type {
  LanguageModelV4Prompt,
  LanguageModelV4StreamPart,
} from '@ai-sdk/provider';
import { type UIMessage, isToolUIPart, simulateReadableStream, tool } from 'ai';
import {
  MockLanguageModelV4,
  convertReadableStreamToArray as drain,
} from 'ai/test';
import { InMemoryFs } from 'just-bash';
import assert from 'node:assert';
import { describe, it } from 'node:test';
import z from 'zod';

import {
  ContextEngine,
  InMemoryContextStore,
  agent,
  assistant,
  chat,
  createBashTool,
  createVirtualSandbox,
  structuredOutput,
  user,
} from '@deepagents/context';

const testUsage = {
  inputTokens: {
    total: 3,
    noCache: 3,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 4, text: 4, reasoning: undefined },
} as const;

const stopResponse = {
  finishReason: { unified: 'stop' as const, raw: undefined },
  usage: testUsage,
  content: [{ type: 'text' as const, text: 'There are two users.' }],
  warnings: [],
};

async function createVirtualAgentSandbox() {
  return createBashTool({
    sandbox: await createVirtualSandbox({ fs: new InMemoryFs() }),
  });
}

const sqlTool = tool({
  description: 'Run a SQL query',
  inputSchema: z.object({ question: z.string() }),
  execute: async () => ({
    rows: [{ id: 1 }],
    meta: { formattedSql: 'SELECT id FROM users' },
  }),
});

const inspectTool = tool({
  description: 'Inspect a resource',
  inputSchema: z.object({ id: z.string() }),
  execute: async ({ id }) => {
    await new Promise((resolve) => setTimeout(resolve, id === 'slow' ? 20 : 0));
    return { id, meta: { requestId: `request-${id}` } };
  },
});

const priorAssistantTurn: UIMessage = {
  id: 'assistant-1',
  role: 'assistant',
  parts: [
    { type: 'step-start' },
    {
      type: 'tool-runSql',
      toolCallId: 'call_runsql',
      state: 'output-available',
      input: { question: 'how many users?' },
      output: {
        rows: [{ id: 1 }],
        meta: { formattedSql: 'SELECT id FROM users' },
      },
    },
    { type: 'text', text: 'There is one user.' },
  ] as UIMessage['parts'],
};

function toolResultOutputs(prompt: LanguageModelV4Prompt) {
  const outputs: unknown[] = [];
  for (const message of prompt) {
    if (message.role !== 'tool') continue;
    for (const part of message.content) {
      if (part.type === 'tool-result') outputs.push(part.output);
    }
  }
  return outputs;
}

describe('replaying history with a tool result carrying host-only meta', () => {
  it('automatically hides meta from the model during replay', async () => {
    const engine = new ContextEngine({
      store: new InMemoryContextStore(),
      chatId: 'tool-model-output-replay',
      userId: 'test-user',
    });
    engine.set(
      user({
        id: 'u1',
        role: 'user',
        parts: [{ type: 'text', text: 'how many users?' }],
      }),
    );
    engine.set(assistant(priorAssistantTurn));
    engine.set(
      user({
        id: 'u2',
        role: 'user',
        parts: [{ type: 'text', text: 'and how many admins?' }],
      }),
    );

    const model = new MockLanguageModelV4({
      doGenerate: {
        finishReason: { unified: 'stop', raw: undefined },
        usage: testUsage,
        content: [{ type: 'text', text: 'There are no admins.' }],
        warnings: [],
      },
    });

    const sut = agent({
      name: 'sql-agent',
      sandbox: await createVirtualAgentSandbox(),
      context: engine,
      model,
      tools: { runSql: sqlTool },
    });

    await sut.generate({});

    const [output] = toolResultOutputs(model.doGenerateCalls[0].prompt);
    assert.deepStrictEqual(output, {
      type: 'json',
      value: { rows: [{ id: 1 }] },
    });
  });

  it('keeps meta in the host result while hiding it from the next model step', async () => {
    const engine = new ContextEngine({
      store: new InMemoryContextStore(),
      chatId: 'tool-model-output-live',
      userId: 'test-user',
    });
    engine.set(user('how many users?'));

    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        const call = model.doGenerateCalls.length;
        if (call === 1) {
          return {
            finishReason: { unified: 'tool-calls' as const, raw: undefined },
            usage: testUsage,
            content: [
              {
                type: 'tool-call' as const,
                toolCallId: 'call_runsql',
                toolName: 'runSql',
                input: JSON.stringify({ question: 'how many users?' }),
              },
            ],
            warnings: [],
          };
        }
        return stopResponse;
      },
    });

    const sut = agent({
      name: 'sql-agent',
      sandbox: await createVirtualAgentSandbox(),
      context: engine,
      model,
      tools: { runSql: sqlTool },
    });

    const result = await sut.generate({});

    assert.deepStrictEqual(result.steps[0].toolResults[0].output, {
      rows: [{ id: 1 }],
      meta: { formattedSql: 'SELECT id FROM users' },
    });
    assert.deepStrictEqual(toolResultOutputs(model.doGenerateCalls[1].prompt), [
      {
        type: 'json',
        value: { rows: [{ id: 1 }] },
      },
    ]);
  });

  it('keeps meta in the stream while hiding it from the next model step', async () => {
    const engine = new ContextEngine({
      store: new InMemoryContextStore(),
      chatId: 'tool-model-output-stream',
      userId: 'test-user',
    });
    engine.set(user('how many users?'));

    const model = new MockLanguageModelV4({
      doStream: async () => {
        const call = model.doStreamCalls.length;
        const chunks: LanguageModelV4StreamPart[] =
          call === 1
            ? [
                {
                  type: 'tool-call',
                  toolCallId: 'call_runsql',
                  toolName: 'runSql',
                  input: JSON.stringify({ question: 'how many users?' }),
                },
                {
                  type: 'finish',
                  finishReason: { unified: 'tool-calls', raw: undefined },
                  usage: testUsage,
                },
              ]
            : [
                { type: 'text-start', id: 'text-1' },
                { type: 'text-delta', id: 'text-1', delta: 'Two users.' },
                { type: 'text-end', id: 'text-1' },
                {
                  type: 'finish',
                  finishReason: { unified: 'stop', raw: undefined },
                  usage: testUsage,
                },
              ];
        return {
          stream: simulateReadableStream({ chunks }),
        };
      },
    });

    const sut = agent({
      name: 'sql-agent',
      sandbox: await createVirtualAgentSandbox(),
      context: engine,
      model,
      tools: { runSql: sqlTool },
    });

    const result = await sut.stream({});
    const toolResults: unknown[] = [];
    for await (const part of result.fullStream) {
      if (part.type === 'tool-result') toolResults.push(part.output);
    }

    assert.deepStrictEqual(toolResults, [
      {
        rows: [{ id: 1 }],
        meta: { formattedSql: 'SELECT id FROM users' },
      },
    ]);
    assert.deepStrictEqual(toolResultOutputs(model.doStreamCalls[1].prompt), [
      {
        type: 'json',
        value: { rows: [{ id: 1 }] },
      },
    ]);
  });

  it('persists raw meta through chat and strips it from the next model step', async () => {
    const store = new InMemoryContextStore();
    const context = new ContextEngine({
      store,
      chatId: 'tool-model-output-persisted',
      userId: 'test-user',
    });
    const model = new MockLanguageModelV4({
      doStream: async () => {
        const call = model.doStreamCalls.length;
        const chunks: LanguageModelV4StreamPart[] =
          call === 1
            ? [
                {
                  type: 'tool-call',
                  toolCallId: 'call_runsql',
                  toolName: 'runSql',
                  input: JSON.stringify({ question: 'how many users?' }),
                },
                {
                  type: 'finish',
                  finishReason: { unified: 'tool-calls', raw: undefined },
                  usage: testUsage,
                },
              ]
            : [
                { type: 'text-start', id: 'text-1' },
                { type: 'text-delta', id: 'text-1', delta: 'Two users.' },
                { type: 'text-end', id: 'text-1' },
                {
                  type: 'finish',
                  finishReason: { unified: 'stop', raw: undefined },
                  usage: testUsage,
                },
              ];
        return {
          stream: simulateReadableStream({ chunks }),
        };
      },
    });
    const sut = agent({
      name: 'persisted-meta-agent',
      sandbox: await createVirtualAgentSandbox(),
      context,
      model,
      tools: { runSql: sqlTool },
    });

    await context.continue({
      id: 'persisted-meta-user',
      role: 'user',
      parts: [{ type: 'text', text: 'how many users?' }],
    });
    await drain(await chat(sut));

    const branch = await store.getActiveBranch('tool-model-output-persisted');
    assert.ok(branch?.headMessageId);
    const chain = await store.getMessageChain(branch.headMessageId);
    const stored = chain.findLast((entry) => entry.name === 'assistant');
    assert.ok(stored);
    const outputs = (stored.data as UIMessage).parts
      .filter(isToolUIPart)
      .filter((part) => part.state === 'output-available')
      .map((part) => part.output);

    assert.deepStrictEqual(outputs, [
      {
        rows: [{ id: 1 }],
        meta: { formattedSql: 'SELECT id FROM users' },
      },
    ]);
    assert.deepStrictEqual(toolResultOutputs(model.doStreamCalls[1].prompt), [
      { type: 'json', value: { rows: [{ id: 1 }] } },
    ]);
  });

  it('keeps parallel tool calls metadata isolated from each other', async () => {
    const engine = new ContextEngine({
      store: new InMemoryContextStore(),
      chatId: 'tool-model-output-parallel',
      userId: 'test-user',
    });
    engine.set(user('inspect both resources'));

    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        const call = model.doGenerateCalls.length;
        if (call === 1) {
          return {
            finishReason: { unified: 'tool-calls' as const, raw: undefined },
            usage: testUsage,
            content: [
              {
                type: 'tool-call' as const,
                toolCallId: 'call-slow',
                toolName: 'inspect',
                input: JSON.stringify({ id: 'slow' }),
              },
              {
                type: 'tool-call' as const,
                toolCallId: 'call-fast',
                toolName: 'inspect',
                input: JSON.stringify({ id: 'fast' }),
              },
            ],
            warnings: [],
          };
        }
        return stopResponse;
      },
    });

    const sut = agent({
      name: 'inspection-agent',
      sandbox: await createVirtualAgentSandbox(),
      context: engine,
      model,
      tools: { inspect: inspectTool },
    });

    const result = await sut.generate({});
    const hostOutputs = result.steps[0].toolResults
      .map((toolResult) => toolResult.output)
      .sort((left, right) =>
        JSON.stringify(left).localeCompare(JSON.stringify(right)),
      );
    const modelOutputs = toolResultOutputs(
      model.doGenerateCalls[1].prompt,
    ).sort((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right)),
    );

    assert.deepStrictEqual(hostOutputs, [
      { id: 'fast', meta: { requestId: 'request-fast' } },
      { id: 'slow', meta: { requestId: 'request-slow' } },
    ]);
    assert.deepStrictEqual(modelOutputs, [
      { type: 'json', value: { id: 'fast' } },
      { type: 'json', value: { id: 'slow' } },
    ]);
  });

  it('hides meta during structured-output tool loops', async () => {
    const context = new ContextEngine({
      store: new InMemoryContextStore(),
      chatId: 'tool-model-output-structured',
      userId: 'test-user',
    });
    context.set(user('count the users'));

    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        const call = model.doGenerateCalls.length;
        if (call === 1) {
          return {
            finishReason: { unified: 'tool-calls' as const, raw: undefined },
            usage: testUsage,
            content: [
              {
                type: 'tool-call' as const,
                toolCallId: 'call_runsql',
                toolName: 'runSql',
                input: JSON.stringify({ question: 'how many users?' }),
              },
            ],
            warnings: [],
          };
        }
        return {
          finishReason: { unified: 'stop' as const, raw: undefined },
          usage: testUsage,
          content: [{ type: 'text' as const, text: '{"count":2}' }],
          warnings: [],
        };
      },
    });
    const extract = structuredOutput({
      context,
      model,
      schema: z.object({ count: z.number() }),
      tools: { runSql: sqlTool },
    });

    assert.deepStrictEqual(await extract.generate({}), { count: 2 });
    assert.deepStrictEqual(toolResultOutputs(model.doGenerateCalls[1].prompt), [
      { type: 'json', value: { rows: [{ id: 1 }] } },
    ]);
  });

  it('keeps host meta while streaming structured-output tool loops', async () => {
    const context = new ContextEngine({
      store: new InMemoryContextStore(),
      chatId: 'tool-model-output-structured-stream',
      userId: 'test-user',
    });
    context.set(user('count the users'));

    const model = new MockLanguageModelV4({
      doStream: async () => {
        const call = model.doStreamCalls.length;
        const chunks: LanguageModelV4StreamPart[] =
          call === 1
            ? [
                {
                  type: 'tool-call',
                  toolCallId: 'call_runsql',
                  toolName: 'runSql',
                  input: JSON.stringify({ question: 'how many users?' }),
                },
                {
                  type: 'finish',
                  finishReason: { unified: 'tool-calls', raw: undefined },
                  usage: testUsage,
                },
              ]
            : [
                { type: 'text-start', id: 'text-1' },
                {
                  type: 'text-delta',
                  id: 'text-1',
                  delta: '{"count":2}',
                },
                { type: 'text-end', id: 'text-1' },
                {
                  type: 'finish',
                  finishReason: { unified: 'stop', raw: undefined },
                  usage: testUsage,
                },
              ];
        return {
          stream: simulateReadableStream({ chunks }),
        };
      },
    });
    const extract = structuredOutput({
      context,
      model,
      schema: z.object({ count: z.number() }),
      tools: { runSql: sqlTool },
    });

    const result = await extract.stream({});
    const hostOutputs: unknown[] = [];
    for await (const part of result.fullStream) {
      if (part.type === 'tool-result') hostOutputs.push(part.output);
    }

    assert.deepStrictEqual(hostOutputs, [
      {
        rows: [{ id: 1 }],
        meta: { formattedSql: 'SELECT id FROM users' },
      },
    ]);
    assert.deepStrictEqual(await result.output, { count: 2 });
    assert.deepStrictEqual(toolResultOutputs(model.doStreamCalls[1].prompt), [
      { type: 'json', value: { rows: [{ id: 1 }] } },
    ]);
  });
});
