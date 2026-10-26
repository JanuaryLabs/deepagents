import { createOpenAI } from '@ai-sdk/openai';
import type {
  LanguageModelV4StreamPart,
  LanguageModelV4ToolCall,
} from '@ai-sdk/provider';
import { ToolChoiceViolationError, tool } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { InMemoryFs } from 'just-bash';
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { setImmediate, setTimeout } from 'node:timers/promises';
import { z } from 'zod';

import {
  ContextEngine,
  InMemoryContextStore,
  agent,
  createBashTool,
  createVirtualSandbox,
  structuredOutput,
  user,
} from '@deepagents/context';

for (const mode of ['generate', 'stream'] as const) {
  it(`${mode} rejects forbidden tool calls before execution or actionable output`, async () => {
    let toolRuns = 0;
    const call: LanguageModelV4ToolCall = {
      type: 'tool-call',
      toolCallId: 'forbidden',
      toolName: 'record',
      input: '{}',
    };
    const usage = {
      inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 1, text: 1, reasoning: 0 },
    };
    const finishReason = { unified: 'tool-calls' as const, raw: undefined };
    const model = new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [call],
        finishReason,
        usage,
        warnings: [],
      }),
      doStream: async () => ({
        stream: ReadableStream.from<LanguageModelV4StreamPart>([
          { type: 'tool-input-start', id: 'forbidden', toolName: 'record' },
          { type: 'tool-input-delta', id: 'forbidden', delta: '{}' },
          { type: 'tool-input-end', id: 'forbidden' },
          call,
          { type: 'finish', finishReason, usage },
        ]),
      }),
    });
    const assistant = agent({
      name: 'no-tools',
      model,
      toolChoice: 'none',
      context: new ContextEngine({
        store: new InMemoryContextStore(),
        chatId: `no-tools-${mode}`,
        userId: 'user',
      }).set(user('Answer without tools.')),
      sandbox: await createBashTool({
        sandbox: await createVirtualSandbox({ fs: new InMemoryFs() }),
      }),
      tools: {
        record: tool({
          inputSchema: z.object({}),
          execute: () => ++toolRuns,
        }),
      },
    });

    if (mode === 'generate') {
      await assert.rejects(
        assistant.generate(),
        ToolChoiceViolationError.isInstance,
      );
    } else {
      const result = await assistant.stream();
      const parts = await Array.fromAsync(result.fullStream);
      assert.ok(
        parts.some(
          (part) =>
            part.type === 'error' &&
            ToolChoiceViolationError.isInstance(part.error),
        ),
      );
      assert.equal(
        parts.some((part) => part.type.startsWith('tool-')),
        false,
      );
    }
    assert.equal(toolRuns, 0);
    assert.equal(model.doGenerateCalls.length + model.doStreamCalls.length, 1);
  });
}

it('structured generation selects the final OpenAI JSON message', async () => {
  let requests = 0;
  const model = createOpenAI({
    apiKey: 'fixture',
    fetch: async (_url, init) => {
      requests++;
      const request = JSON.parse(String(init?.body));
      assert.equal(request.text.format.type, 'json_schema');
      return Response.json({
        id: 'resp-multiple-json',
        created_at: 0,
        model: 'gpt-6.1-sol',
        status: 'completed',
        output: ['draft', 'final'].map((answer) => ({
          type: 'message',
          id: `message-${answer}`,
          role: 'assistant',
          status: 'completed',
          phase: 'final_answer',
          content: [
            {
              type: 'output_text',
              text: JSON.stringify({ answer }),
              annotations: [],
            },
          ],
        })),
        usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
      });
    },
  }).responses('gpt-6.1-sol');
  const output = structuredOutput({
    model,
    schema: z.object({ answer: z.string() }),
    context: new ContextEngine({
      store: new InMemoryContextStore(),
      chatId: 'multiple-json',
      userId: 'user',
    }).set(user('Give the answer.')),
  });

  assert.deepEqual(await output.generate(), { answer: 'final' });
  assert.equal(requests, 1);
});

for (const mode of [
  'generate',
  'stream',
  'structured-generate',
  'structured-stream',
  'asTool',
] as const) {
  it(`${mode} applies native model controls, sequential tools, and approval policy`, async () => {
    const usage = {
      inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 1, text: 1, reasoning: 0 },
    };
    let active = 0;
    let maxActive = 0;
    let blockedRuns = 0;
    const completed: number[] = [];
    const calls: LanguageModelV4ToolCall[] = [
      {
        type: 'tool-call',
        toolCallId: 'first',
        toolName: 'record',
        input: '{"id":1}',
      },
      {
        type: 'tool-call',
        toolCallId: 'second',
        toolName: 'record',
        input: '{"id":2}',
      },
      {
        type: 'tool-call',
        toolCallId: 'blocked',
        toolName: 'blocked',
        input: '{}',
      },
    ];
    const model: MockLanguageModelV4 = new MockLanguageModelV4({
      doGenerate: async () => ({
        content:
          model.doGenerateCalls.length === 1
            ? calls
            : [{ type: 'text', text: '{"answer":"done"}' }],
        finishReason: {
          unified: model.doGenerateCalls.length === 1 ? 'tool-calls' : 'stop',
          raw: undefined,
        },
        usage,
        warnings: [],
      }),
      doStream: async () => ({
        stream: ReadableStream.from<LanguageModelV4StreamPart>([
          ...(model.doStreamCalls.length === 1
            ? calls
            : [
                { type: 'text-start' as const, id: 'answer' },
                {
                  type: 'text-delta' as const,
                  id: 'answer',
                  delta: '{"answer":"done"}',
                },
                { type: 'text-end' as const, id: 'answer' },
              ]),
          {
            type: 'finish',
            finishReason: {
              unified: model.doStreamCalls.length === 1 ? 'tool-calls' : 'stop',
              raw: undefined,
            },
            usage,
          },
        ]),
      }),
    });
    const context = new ContextEngine({
      store: new InMemoryContextStore(),
      chatId: mode,
      userId: 'user',
    }).set(user('Run the tools.'));
    const sandbox = await createBashTool({
      sandbox: await createVirtualSandbox({ fs: new InMemoryFs() }),
    });
    const options = {
      name: 'controls',
      context,
      sandbox,
      model,
      reasoning: 'low' as const,
      maxOutputTokens: 128,
      timeout: { totalMs: 5_000, toolMs: 1_000 },
      toolCallConcurrency: 1,
      toolApproval: { blocked: 'denied' as const },
      tools: {
        record: tool({
          inputSchema: z.object({ id: z.number() }),
          execute: async ({ id }) => {
            maxActive = Math.max(maxActive, ++active);
            await setImmediate();
            active--;
            completed.push(id);
            return id;
          },
        }),
        blocked: tool({
          inputSchema: z.object({}),
          execute: () => ++blockedRuns,
        }),
      },
    };

    if (mode === 'generate') {
      assert.equal((await agent(options).generate()).text, '{"answer":"done"}');
    } else if (mode === 'stream') {
      const result = await agent(options).stream();
      await result.consumeStream();
      assert.equal(await result.text, '{"answer":"done"}');
    } else if (mode === 'asTool') {
      assert.equal(
        await agent(options)
          .asTool()
          .execute(
            { input: 'Run the tools.' },
            { toolCallId: 'subagent', messages: [], context: {} },
          ),
        '{"answer":"done"}',
      );
    } else {
      const output = structuredOutput({
        ...options,
        schema: z.object({ answer: z.string() }),
      });
      if (mode === 'structured-generate') {
        assert.deepEqual(await output.generate(), { answer: 'done' });
      } else {
        const result = await output.stream();
        await result.consumeStream();
        assert.deepEqual(await result.output, { answer: 'done' });
      }
    }

    assert.deepEqual(completed, [1, 2]);
    assert.equal(maxActive, 1);
    assert.equal(blockedRuns, 0);
    const requests = [...model.doGenerateCalls, ...model.doStreamCalls];
    assert.equal(requests.length, 2);
    for (const request of requests) {
      assert.equal(request.reasoning, 'low');
      assert.equal(request.maxOutputTokens, 128);
    }
  });
}

it('native total timeout also cancels a tool-call repair request', async () => {
  let repairSignal: AbortSignal | undefined;
  let toolRuns = 0;
  const usage = {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 },
  };
  const model: MockLanguageModelV4 = new MockLanguageModelV4({
    doGenerate: async ({ abortSignal }) => {
      if (model.doGenerateCalls.length === 1)
        return {
          content: [
            {
              type: 'tool-call',
              toolCallId: 'invalid',
              toolName: 'lookup',
              input: '{"id":42}',
            },
          ],
          finishReason: { unified: 'tool-calls', raw: undefined },
          usage,
          warnings: [],
        };
      repairSignal = abortSignal;
      await setTimeout(80, undefined, { signal: abortSignal });
      return {
        content: [{ type: 'text', text: '{"id":"42"}' }],
        finishReason: { unified: 'stop', raw: undefined },
        usage,
        warnings: [],
      };
    },
  });
  const assistant = agent({
    name: 'repair-timeout',
    model,
    timeout: { totalMs: 20 },
    context: new ContextEngine({
      store: new InMemoryContextStore(),
      chatId: 'repair-timeout',
      userId: 'user',
    }).set(user('Lookup.')),
    sandbox: await createBashTool({
      sandbox: await createVirtualSandbox({ fs: new InMemoryFs() }),
    }),
    tools: {
      lookup: tool({
        inputSchema: z.object({ id: z.string() }),
        execute: () => ++toolRuns,
      }),
    },
  });

  await assert.rejects(assistant.generate(), /timeout/i);

  assert.equal(repairSignal?.aborted, true);
  assert.equal(toolRuns, 0);
});

it('native tool timeout aborts execution and returns a tool error to the next model step', async () => {
  let toolAborted = false;
  const usage = {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 },
  };
  const model: MockLanguageModelV4 = new MockLanguageModelV4({
    doGenerate: async () => ({
      content:
        model.doGenerateCalls.length === 1
          ? [
              {
                type: 'tool-call',
                toolCallId: 'slow',
                toolName: 'slow',
                input: '{}',
              },
            ]
          : [{ type: 'text', text: 'Timed out.' }],
      finishReason: {
        unified: model.doGenerateCalls.length === 1 ? 'tool-calls' : 'stop',
        raw: undefined,
      },
      usage,
      warnings: [],
    }),
  });
  const assistant = agent({
    name: 'timeout',
    model,
    context: new ContextEngine({
      store: new InMemoryContextStore(),
      chatId: 'timeout',
      userId: 'user',
    }).set(user('Run slow.')),
    sandbox: await createBashTool({
      sandbox: await createVirtualSandbox({ fs: new InMemoryFs() }),
    }),
    timeout: { tools: { slowMs: 20 } },
    tools: {
      slow: tool({
        inputSchema: z.object({}),
        execute: async (_, { abortSignal }) => {
          try {
            await setTimeout(10_000, undefined, { signal: abortSignal });
          } finally {
            toolAborted = abortSignal?.aborted ?? false;
          }
          return 'unexpected';
        },
      }),
    },
  });

  const result = await assistant.generate();

  assert.equal(toolAborted, true);
  assert.equal(result.text, 'Timed out.');
  assert.ok(result.steps[0].content.some((part) => part.type === 'tool-error'));
});
