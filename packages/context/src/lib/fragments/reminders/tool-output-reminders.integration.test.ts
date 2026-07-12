import { createAnthropic } from '@ai-sdk/anthropic';
import type {
  LanguageModelV4,
  LanguageModelV4Prompt,
  LanguageModelV4StreamPart,
} from '@ai-sdk/provider';
import {
  type ToolSet,
  type UIMessage,
  generateId,
  isStepCount,
  isToolUIPart,
  simulateReadableStream,
  streamText,
  tool,
} from 'ai';
import {
  MockLanguageModelV4,
  convertReadableStreamToArray as drain,
} from 'ai/test';
import { InMemoryFs } from 'just-bash';
import assert from 'node:assert';
import { describe, it } from 'node:test';
import { z } from 'zod';

import {
  ContextEngine,
  InMemoryContextStore,
  afterTurn,
  agent,
  and,
  chat,
  createBashTool,
  createVirtualSandbox,
  isSyntheticReminderMessage,
  once,
  reminder,
  toolOutput,
} from '@deepagents/context';

const testUsage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
} as const;

type StepSpec = { tool: string; input?: string } | { text: string };

function scriptedModel(steps: StepSpec[]) {
  const model: MockLanguageModelV4 = new MockLanguageModelV4({
    doStream: async () => {
      const call = model.doStreamCalls.length;
      const spec = steps[Math.min(call - 1, steps.length - 1)];
      const id = `s${call}`;
      const chunks: LanguageModelV4StreamPart[] = [];
      if ('text' in spec) {
        chunks.push(
          { type: 'text-start', id },
          { type: 'text-delta', id, delta: spec.text },
          { type: 'text-end', id },
        );
      }
      if ('tool' in spec) {
        chunks.push({
          type: 'tool-call',
          toolCallId: `c${call}`,
          toolName: spec.tool,
          input: spec.input ?? '{}',
        });
      }
      chunks.push({
        type: 'finish',
        finishReason: {
          unified: 'tool' in spec ? 'tool-calls' : 'stop',
          raw: '',
        },
        usage: testUsage,
      });
      return {
        stream: simulateReadableStream({ chunks }),
      };
    },
  });
  return model;
}

function scriptedGenerateModel() {
  const model: MockLanguageModelV4 = new MockLanguageModelV4({
    doGenerate: async () => {
      const call = model.doGenerateCalls.length;
      return call === 1
        ? {
            finishReason: { unified: 'tool-calls' as const, raw: '' },
            usage: testUsage,
            warnings: [],
            content: [
              {
                type: 'tool-call' as const,
                toolCallId: 'c1',
                toolName: 'noop',
                input: '{}',
              },
            ],
          }
        : {
            finishReason: { unified: 'stop' as const, raw: '' },
            usage: testUsage,
            warnings: [],
            content: [{ type: 'text' as const, text: 'done' }],
          };
    },
  });
  return model;
}

function providerExecutedModel() {
  const model: MockLanguageModelV4 = new MockLanguageModelV4({
    doStream: async () => {
      const call = model.doStreamCalls.length;
      const chunks: LanguageModelV4StreamPart[] =
        call === 1
          ? [
              {
                type: 'tool-call',
                toolCallId: 'provider-call',
                toolName: 'server:search',
                input: '{"query":"raw"}',
                providerExecuted: true,
                dynamic: true,
              },
              {
                type: 'tool-result',
                toolCallId: 'provider-call',
                toolName: 'server:search',
                result: { hits: 1 },
                dynamic: true,
              },
              {
                type: 'tool-call',
                toolCallId: 'client-call',
                toolName: 'noop',
                input: '{}',
              },
            ]
          : [
              { type: 'text-start', id: 'provider-done' },
              {
                type: 'text-delta',
                id: 'provider-done',
                delta: 'done',
              },
              { type: 'text-end', id: 'provider-done' },
            ];
      chunks.push({
        type: 'finish',
        finishReason: {
          unified: call === 1 ? 'tool-calls' : 'stop',
          raw: '',
        },
        usage: testUsage,
      });
      return { stream: simulateReadableStream({ chunks }) };
    },
  });
  return model;
}

function failingAfterToolModel() {
  const model: MockLanguageModelV4 = new MockLanguageModelV4({
    doStream: async () => {
      const call = model.doStreamCalls.length;
      if (call === 2) {
        throw new Error('provider failed before the next step started');
      }
      if (call > 2) {
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: 'text-start', id: 'resumed' },
              { type: 'text-delta', id: 'resumed', delta: 'resumed' },
              { type: 'text-end', id: 'resumed' },
              {
                type: 'finish',
                finishReason: { unified: 'stop', raw: '' },
                usage: testUsage,
              },
            ],
          }),
        };
      }
      return {
        stream: simulateReadableStream({
          chunks: [
            {
              type: 'tool-call',
              toolCallId: 'c1',
              toolName: 'noop',
              input: '{}',
            },
            {
              type: 'finish',
              finishReason: { unified: 'tool-calls', raw: '' },
              usage: testUsage,
            },
          ],
        }),
      };
    },
  });
  return model;
}

function failingAfterTwoToolsModel() {
  const model: MockLanguageModelV4 = new MockLanguageModelV4({
    doStream: async () => {
      const call = model.doStreamCalls.length;
      if (call === 3) {
        throw new Error('provider failed before the third step started');
      }
      if (call > 3) {
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: 'text-start', id: 'resumed-twice' },
              {
                type: 'text-delta',
                id: 'resumed-twice',
                delta: 'resumed',
              },
              { type: 'text-end', id: 'resumed-twice' },
              {
                type: 'finish',
                finishReason: { unified: 'stop', raw: '' },
                usage: testUsage,
              },
            ],
          }),
        };
      }

      const toolName = call === 1 ? 'first' : 'second';
      return {
        stream: simulateReadableStream({
          chunks: [
            {
              type: 'tool-call',
              toolCallId: `c${call}`,
              toolName,
              input: '{}',
            },
            {
              type: 'finish',
              finishReason: { unified: 'tool-calls', raw: '' },
              usage: testUsage,
            },
          ],
        }),
      };
    },
  });
  return model;
}

function parallelToolsModel() {
  const model: MockLanguageModelV4 = new MockLanguageModelV4({
    doStream: async () => {
      const call = model.doStreamCalls.length;
      const chunks: LanguageModelV4StreamPart[] =
        call === 1
          ? [
              {
                type: 'tool-call',
                toolCallId: 'c-noop',
                toolName: 'noop',
                input: '{}',
              },
              {
                type: 'tool-call',
                toolCallId: 'c-meta',
                toolName: 'metaTool',
                input: '{}',
              },
            ]
          : [
              { type: 'text-start', id: 'done' },
              { type: 'text-delta', id: 'done', delta: 'done' },
              { type: 'text-end', id: 'done' },
            ];
      chunks.push({
        type: 'finish',
        finishReason: {
          unified: call === 1 ? 'tool-calls' : 'stop',
          raw: '',
        },
        usage: testUsage,
      });
      return {
        stream: simulateReadableStream({ chunks }),
      };
    },
  });
  return model;
}

function latestStreamPrompt(model: MockLanguageModelV4): LanguageModelV4Prompt {
  return model.doStreamCalls.at(-1)?.prompt ?? [];
}

function latestGeneratePrompt(
  model: MockLanguageModelV4,
): LanguageModelV4Prompt {
  return model.doGenerateCalls.at(-1)?.prompt ?? [];
}

const noopTool = tool({
  description: 'A no-op tool used to drive multi-step loops.',
  inputSchema: z.object({}),
  execute: async () => ({ ok: true }),
});

const metaTool = tool({
  description:
    'A tool whose output carries host-only meta its own toModelOutput strips.',
  inputSchema: z.object({}),
  execute: async () => ({ value: 42, meta: { hidden: 'SECRET' } }),
  toModelOutput: ({ output }) => {
    const { meta: _meta, ...visible } = output as { meta?: unknown };
    return { type: 'json', value: visible };
  },
});

const defaultMetaTool = tool({
  description: 'A tool that relies on the default host-only meta projection.',
  inputSchema: z.object({}),
  execute: async () => ({ value: 42, meta: { hidden: 'SECRET' } }),
});

const asyncMetaTool = tool({
  description: 'A tool with an asynchronous model projection.',
  inputSchema: z.object({}),
  execute: async () => ({ value: 42, meta: { hidden: 'SECRET' } }),
  toModelOutput: async ({ output }) => {
    await Promise.resolve();
    return {
      type: 'json',
      value: { value: output.value },
      providerOptions: { test: { projection: 'async' } },
    };
  },
});

const contentTool = tool({
  description: 'A tool with file content in its model projection.',
  inputSchema: z.object({}),
  execute: async () => ({ artifactId: 'artifact-1' }),
  toModelOutput: () => ({
    type: 'content',
    value: [
      {
        type: 'file',
        data: { type: 'text', text: 'artifact contents' },
        mediaType: 'text/plain',
        filename: 'artifact.txt',
        providerOptions: { test: { projection: 'content' } },
      },
    ],
  }),
});

const textTool = tool({
  description: 'A tool with a text model projection.',
  inputSchema: z.object({}),
  execute: async () => ({ message: 'raw text result' }),
  toModelOutput: () => ({ type: 'text', value: 'projected text result' }),
});

const errorTextTool = tool({
  description: 'A tool with an error-text model projection.',
  inputSchema: z.object({}),
  execute: async () => ({ code: 'E_TEST' }),
  toModelOutput: () => ({ type: 'error-text', value: 'projected failure' }),
});

const errorJsonTool = tool({
  description: 'A tool with an error-json model projection.',
  inputSchema: z.object({}),
  execute: async () => ({ code: 'E_TEST' }),
  toModelOutput: () => ({
    type: 'error-json',
    value: { code: 'E_PROJECTED' },
  }),
});

const deniedTool = tool({
  description: 'A tool with an execution-denied model projection.',
  inputSchema: z.object({}),
  execute: async () => ({ denied: true }),
  toModelOutput: () => ({
    type: 'execution-denied',
    reason: 'approval denied',
  }),
});

const throwingTool = tool({
  description: 'A tool that throws during execution.',
  inputSchema: z.object({}),
  execute: async (): Promise<string> => {
    throw new Error('tool exploded');
  },
});

const requiredInputTool = tool({
  description: 'A tool with required input.',
  inputSchema: z.object({ value: z.string() }),
  execute: async ({ value }) => ({ value }),
});

const streamingTool = tool({
  description: 'A tool that streams preliminary outputs.',
  inputSchema: z.object({}),
  execute: async function* () {
    yield { progress: 1 };
    yield { progress: 2 };
  },
});

async function makeAgent(
  context: ContextEngine,
  model: LanguageModelV4,
  name: string,
  tools: ToolSet = { noop: noopTool },
) {
  const sandbox = await createBashTool({
    sandbox: await createVirtualSandbox({ fs: new InMemoryFs() }),
  });
  return agent({ sandbox, name, context, model, tools });
}

function userMessage(text: string): UIMessage {
  return { id: generateId(), role: 'user', parts: [{ type: 'text', text }] };
}

async function storedAssistant(
  store: InMemoryContextStore,
  chatId: string,
): Promise<UIMessage> {
  const branch = await store.getActiveBranch(chatId);
  assert.ok(branch?.headMessageId, 'expected a branch head');
  const chain = await store.getMessageChain(branch.headMessageId);
  const entry = chain.findLast((e) => e.name === 'assistant');
  assert.ok(entry, 'expected a stored assistant message');
  return entry.data as UIMessage;
}

function toolOutputsOf(message: UIMessage): unknown[] {
  return message.parts
    .filter(isToolUIPart)
    .filter((part) => part.state === 'output-available')
    .map((part) => part.output);
}

function toolResultValuesIn(prompt: unknown[]): unknown[] {
  const values: unknown[] = [];
  for (const message of prompt as Array<{
    role: string;
    content: Array<{ type: string; output?: { type: string; value: unknown } }>;
  }>) {
    if (message.role !== 'tool') continue;
    for (const item of message.content) {
      if (item.type === 'tool-result' && item.output) {
        values.push(item.output.value);
      }
    }
  }
  return values;
}

function toolResultOutputsIn(prompt: unknown[]): unknown[] {
  const outputs: unknown[] = [];
  for (const message of prompt as Array<{
    role: string;
    content: Array<{ type: string; output?: unknown }>;
  }>) {
    if (message.role !== 'tool') continue;
    for (const item of message.content) {
      if (item.type === 'tool-result') outputs.push(item.output);
    }
  }
  return outputs;
}

function reminderTextsIn(prompt: unknown[]): string[] {
  return prompt.flatMap((message) => {
    const candidate = message as {
      role?: string;
      content?: Array<{ type?: string; text?: string }>;
    };
    if (candidate.role !== 'user' || !Array.isArray(candidate.content))
      return [];
    return candidate.content.flatMap((part) =>
      part.type === 'text' && part.text?.startsWith('<system-reminder>')
        ? [part.text]
        : [],
    );
  });
}

describe('tool-output reminders', () => {
  it('shows the reminder after the raw tool result on the next model step', async () => {
    const store = new InMemoryContextStore();
    const context = new ContextEngine({ store, chatId: 'wrap', userId: 'u1' });
    const model = scriptedModel([{ tool: 'noop' }, { text: 'done' }]);
    const chatAgent = await makeAgent(context, model, 'wrap');

    context.set(
      reminder('CHECK THE FS TOOLS', {
        when: toolOutput({
          name: 'noop',
          state: 'output-available',
          input: (input) =>
            typeof input === 'object' &&
            input !== null &&
            Object.keys(input).length === 0,
          output: (output) =>
            typeof output === 'object' &&
            output !== null &&
            'ok' in output &&
            output.ok === true,
        }),
        target: 'tool-output',
      }),
    );

    await context.continue(userMessage('run the task'));
    await drain(await chat(chatAgent));

    const storedMessages = await context.getMessages();
    assert.deepStrictEqual(storedMessages.flatMap(toolOutputsOf), [
      { ok: true },
    ]);

    const storedReminder = storedMessages.find(isSyntheticReminderMessage);
    assert.deepStrictEqual(
      storedReminder?.metadata?.synthetic.source,
      'reminder',
    );

    const lastPrompt = latestStreamPrompt(model);
    assert.deepStrictEqual(toolResultValuesIn(lastPrompt), [{ ok: true }]);
    const [toolMessage, reminderMessage] = lastPrompt.slice(-2) as Array<{
      role: string;
      content: Array<{ type: string; text?: string }>;
    }>;
    assert.strictEqual(toolMessage.role, 'tool');
    assert.strictEqual(reminderMessage.role, 'user');
    assert.strictEqual(
      reminderMessage.content[0]?.text,
      '<system-reminder>CHECK THE FS TOOLS</system-reminder>',
    );
  });

  it('evaluates provider-executed terminal tool outcomes before the next generation', async () => {
    const context = new ContextEngine({
      store: new InMemoryContextStore(),
      chatId: 'provider-executed',
      userId: 'u1',
    });
    const model = providerExecutedModel();
    const chatAgent = await makeAgent(context, model, 'provider-executed');
    context.set(
      reminder('CHECK PROVIDER SEARCH', {
        when: toolOutput({
          name: 'server:search',
          state: 'output-available',
          input: (input) =>
            typeof input === 'object' &&
            input !== null &&
            'query' in input &&
            input.query === 'raw',
          output: (output) =>
            typeof output === 'object' &&
            output !== null &&
            'hits' in output &&
            output.hits === 1,
        }),
        target: 'tool-output',
      }),
    );
    await context.continue(userMessage('search'));

    await drain(await chat(chatAgent));

    assert.deepStrictEqual(reminderTextsIn(latestStreamPrompt(model)), [
      '<system-reminder>CHECK PROVIDER SEARCH</system-reminder>',
    ]);
  });

  it('persists a sent reminder when the next model step fails before starting', async (t) => {
    t.mock.method(console, 'error', () => {});
    const store = new InMemoryContextStore();
    const context = new ContextEngine({
      store,
      chatId: 'failure-after-reminder',
      userId: 'u1',
    });
    const model = failingAfterToolModel();
    const chatAgent = await makeAgent(context, model, 'failure-after-reminder');
    context.set(
      reminder('RECOVER WITH CONTEXT', {
        when: toolOutput({ name: 'noop' }),
        target: 'tool-output',
      }),
    );
    await context.continue(userMessage('run then fail'));

    const chunks = await drain(await chat(chatAgent));

    const chain = await context.getMessages();
    assert.ok(
      chunks.some((part) => part.type === 'error'),
      `expected an error chunk, got ${JSON.stringify(chunks)}`,
    );
    assert.deepStrictEqual(reminderTextsIn(latestStreamPrompt(model)), [
      '<system-reminder>RECOVER WITH CONTEXT</system-reminder>',
    ]);
    const failedPrompt = latestStreamPrompt(model);
    assert.deepStrictEqual(chain.flatMap(toolOutputsOf), [{ ok: true }]);
    assert.deepStrictEqual(
      chain
        .filter(isSyntheticReminderMessage)
        .flatMap((message) =>
          message.parts.flatMap((part) =>
            part.type === 'text' ? [part.text] : [],
          ),
        ),
      ['<system-reminder>RECOVER WITH CONTEXT</system-reminder>'],
    );

    await context.continue(userMessage('resume'));
    await drain(await chat(chatAgent));

    assert.deepStrictEqual(
      latestStreamPrompt(model).slice(0, failedPrompt.length),
      failedPrompt,
    );
  });

  it('keeps multiple reminder boundaries cache-stable when a later step fails', async (t) => {
    t.mock.method(console, 'error', () => {});
    const context = new ContextEngine({
      store: new InMemoryContextStore(),
      chatId: 'later-failure-after-reminders',
      userId: 'u1',
    });
    const model = failingAfterTwoToolsModel();
    const chatAgent = await makeAgent(
      context,
      model,
      'later-failure-after-reminders',
      { first: noopTool, second: noopTool },
    );
    context.set(
      reminder('AFTER FIRST', {
        when: toolOutput({ name: 'first' }),
        target: 'tool-output',
      }),
      reminder('AFTER SECOND', {
        when: toolOutput({ name: 'second' }),
        target: 'tool-output',
      }),
    );
    await context.continue(userMessage('run both then fail'));

    const chunks = await drain(await chat(chatAgent));

    assert.ok(chunks.some((part) => part.type === 'error'));
    const failedPrompt = latestStreamPrompt(model);
    assert.deepStrictEqual(reminderTextsIn(failedPrompt), [
      '<system-reminder>AFTER FIRST</system-reminder>',
      '<system-reminder>AFTER SECOND</system-reminder>',
    ]);
    const stored = await context.getMessages();
    assert.deepStrictEqual(stored.flatMap(toolOutputsOf), [
      { ok: true },
      { ok: true },
    ]);
    assert.deepStrictEqual(
      stored
        .filter(isSyntheticReminderMessage)
        .flatMap((message) =>
          message.parts.flatMap((part) =>
            part.type === 'text' ? [part.text] : [],
          ),
        ),
      [
        '<system-reminder>AFTER FIRST</system-reminder>',
        '<system-reminder>AFTER SECOND</system-reminder>',
      ],
    );

    await context.continue(userMessage('resume after both'));
    await drain(await chat(chatAgent));

    assert.deepStrictEqual(
      latestStreamPrompt(model).slice(0, failedPrompt.length),
      failedPrompt,
    );
  });

  it('shows the reminder after the tool result when generating without streaming', async () => {
    const context = new ContextEngine({
      store: new InMemoryContextStore(),
      chatId: 'generate',
      userId: 'u1',
    });
    const model = scriptedGenerateModel();
    const chatAgent = await makeAgent(context, model, 'generate');
    context.set(
      reminder('CHECK', { when: afterTurn(0), target: 'tool-output' }),
      reminder('STEER', { when: afterTurn(0), target: 'steer' }),
    );
    await context.continue(userMessage('run the task'));

    await chatAgent.generate({});

    assert.deepStrictEqual(toolResultValuesIn(latestGeneratePrompt(model)), [
      { ok: true },
    ]);
    assert.deepStrictEqual(reminderTextsIn(latestGeneratePrompt(model)), [
      '<system-reminder>CHECK</system-reminder>',
    ]);
  });

  it('reaches Anthropic as sibling tool-result and reminder blocks', async () => {
    const requests: Array<{ messages: unknown[] }> = [];
    const anthropic = createAnthropic({
      apiKey: 'test-key',
      fetch: async (_input, init) => {
        requests.push(
          JSON.parse(String(init?.body)) as { messages: unknown[] },
        );
        const body =
          requests.length === 1
            ? {
                type: 'message',
                id: 'msg-tool',
                model: 'claude-sonnet-4-6',
                content: [
                  {
                    type: 'tool_use',
                    id: 'toolu_1',
                    name: 'noop',
                    input: {},
                  },
                ],
                stop_reason: 'tool_use',
                stop_sequence: null,
                usage: { input_tokens: 1, output_tokens: 1 },
              }
            : {
                type: 'message',
                id: 'msg-done',
                model: 'claude-sonnet-4-6',
                content: [{ type: 'text', text: 'done' }],
                stop_reason: 'end_turn',
                stop_sequence: null,
                usage: { input_tokens: 1, output_tokens: 1 },
              };
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    const context = new ContextEngine({
      store: new InMemoryContextStore(),
      chatId: 'anthropic-wire-shape',
      userId: 'u1',
    });
    const chatAgent = await makeAgent(
      context,
      anthropic('claude-sonnet-4-6'),
      'anthropic-wire-shape',
    );
    context.set(
      reminder('CHECK', { when: afterTurn(0), target: 'tool-output' }),
    );
    await context.continue(userMessage('run the task'));

    await chatAgent.generate({});

    assert.deepStrictEqual(requests.at(-1)?.messages.at(-1), {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_1',
          content: '{"ok":true}',
        },
        {
          type: 'text',
          text: '<system-reminder>CHECK</system-reminder>',
        },
      ],
    });
  });

  it('replays a fired tool-output reminder on the next top-level turn', async () => {
    const context = new ContextEngine({
      store: new InMemoryContextStore(),
      chatId: 'reminder-replay',
      userId: 'u1',
    });
    const model = scriptedModel([
      { tool: 'noop' },
      { text: 'first answer' },
      { text: 'second answer' },
    ]);
    const chatAgent = await makeAgent(context, model, 'reminder-replay');
    context.set(
      reminder('CACHE-STABLE', {
        when: afterTurn(0),
        target: 'tool-output',
      }),
    );

    await context.continue(userMessage('first turn'));
    await drain(await chat(chatAgent));
    await context.continue(userMessage('second turn'));
    await drain(await chat(chatAgent));

    assert.deepStrictEqual(reminderTextsIn(latestStreamPrompt(model)), [
      '<system-reminder>CACHE-STABLE</system-reminder>',
    ]);
  });

  it('preserves the post-tool prompt as an exact prefix of the next turn', async () => {
    const context = new ContextEngine({
      store: new InMemoryContextStore(),
      chatId: 'prompt-cache-prefix',
      userId: 'u1',
    });
    const model = scriptedModel([
      { tool: 'noop' },
      { text: 'first answer' },
      { text: 'second answer' },
    ]);
    const chatAgent = await makeAgent(context, model, 'prompt-cache-prefix');
    context.set(
      reminder('CACHE-STABLE', {
        when: afterTurn(0),
        target: 'tool-output',
      }),
    );

    await context.continue(userMessage('first turn'));
    await drain(await chat(chatAgent));
    const postToolPrompt = structuredClone(latestStreamPrompt(model));

    await context.continue(userMessage('second turn'));
    await drain(await chat(chatAgent));
    const resumedPrompt = latestStreamPrompt(model);

    assert.deepStrictEqual(
      resumedPrompt.slice(0, postToolPrompt.length),
      postToolPrompt,
    );
  });

  it('latches once-gated tool-output reminders across an engine restart', async () => {
    const store = new InMemoryContextStore();
    let context = new ContextEngine({
      store,
      chatId: 'tool-output-once',
      userId: 'u1',
    });
    const model = scriptedModel([
      { tool: 'noop' },
      { text: 'first answer' },
      { tool: 'noop' },
      { text: 'second answer' },
    ]);
    let chatAgent = await makeAgent(context, model, 'tool-output-once');
    context.set(
      reminder('ONLY ONCE', {
        when: and(toolOutput({ name: 'noop' }), once('tool-output-once')),
        target: 'tool-output',
      }),
    );

    await context.continue(userMessage('first turn'));
    await drain(await chat(chatAgent));
    const postToolPrompt = structuredClone(latestStreamPrompt(model));

    context = new ContextEngine({
      store,
      chatId: 'tool-output-once',
      userId: 'u1',
    });
    chatAgent = await makeAgent(context, model, 'tool-output-once-resumed');
    context.set(
      reminder('ONLY ONCE', {
        when: and(toolOutput({ name: 'noop' }), once('tool-output-once')),
        target: 'tool-output',
      }),
    );
    await context.continue(userMessage('second turn'));
    await drain(await chat(chatAgent));

    const resumedPrompt = latestStreamPrompt(model);
    assert.deepStrictEqual(
      resumedPrompt.slice(0, postToolPrompt.length),
      postToolPrompt,
    );
    assert.deepStrictEqual(reminderTextsIn(resumedPrompt), [
      '<system-reminder>ONLY ONCE</system-reminder>',
    ]);
  });

  it('joins multiple matching reminders into one message', async () => {
    const context = new ContextEngine({
      store: new InMemoryContextStore(),
      chatId: 'joined',
      userId: 'u1',
    });
    const model = scriptedModel([{ tool: 'noop' }, { text: 'done' }]);
    const chatAgent = await makeAgent(context, model, 'joined');
    context.set(
      reminder('CHECK ONE', { when: afterTurn(0), target: 'tool-output' }),
      reminder('CHECK TWO', { when: afterTurn(0), target: 'tool-output' }),
    );
    await context.continue(userMessage('run the task'));

    await drain(await chat(chatAgent));

    assert.deepStrictEqual(reminderTextsIn(latestStreamPrompt(model)), [
      '<system-reminder>CHECK ONE\nCHECK TWO</system-reminder>',
    ]);
  });

  it('injects after every matching execution in a multi-step turn', async () => {
    const store = new InMemoryContextStore();
    const context = new ContextEngine({ store, chatId: 'multi', userId: 'u1' });
    const model = scriptedModel([
      { tool: 'noop' },
      { tool: 'noop' },
      { text: 'done' },
    ]);
    const chatAgent = await makeAgent(context, model, 'multi');

    context.set(
      reminder('CHECK THE FS TOOLS', {
        when: afterTurn(0),
        target: 'tool-output',
      }),
    );

    await context.continue(userMessage('run the task twice'));
    await drain(await chat(chatAgent));

    assert.deepStrictEqual(
      (await context.getMessages()).flatMap(toolOutputsOf),
      [{ ok: true }, { ok: true }],
    );
    assert.deepStrictEqual(reminderTextsIn(latestStreamPrompt(model)), [
      '<system-reminder>CHECK THE FS TOOLS</system-reminder>',
      '<system-reminder>CHECK THE FS TOOLS</system-reminder>',
    ]);
  });

  it('joins matching reminders for multiple tool calls from the same step', async () => {
    const context = new ContextEngine({
      store: new InMemoryContextStore(),
      chatId: 'parallel',
      userId: 'u1',
    });
    const model = parallelToolsModel();
    const chatAgent = await makeAgent(context, model, 'parallel', {
      noop: noopTool,
      metaTool,
    });
    context.set(
      reminder('CHECK NOOP', {
        when: (ctx) => ctx.toolOutcome?.name === 'noop',
        target: 'tool-output',
      }),
      reminder('CHECK META', {
        when: (ctx) => ctx.toolOutcome?.name === 'metaTool',
        target: 'tool-output',
      }),
    );
    await context.continue(userMessage('run both tools'));

    await drain(await chat(chatAgent));

    assert.deepStrictEqual(toolResultValuesIn(latestStreamPrompt(model)), [
      { ok: true },
      { value: 42 },
    ]);
    assert.deepStrictEqual(reminderTextsIn(latestStreamPrompt(model)), [
      '<system-reminder>CHECK NOOP\nCHECK META</system-reminder>',
    ]);
  });

  it('merges tool-output and steer reminders into one stored user message', async () => {
    const store = new InMemoryContextStore();
    const context = new ContextEngine({
      store,
      chatId: 'tool-and-steer',
      userId: 'u1',
    });
    const model = scriptedModel([{ tool: 'noop' }, { text: 'done' }]);
    const chatAgent = await makeAgent(context, model, 'tool-and-steer');
    context.set(
      reminder('TOOL CHECK', {
        when: afterTurn(0),
        target: 'tool-output',
      }),
      reminder('STEER CHECK', { when: afterTurn(0), target: 'steer' }),
    );
    await context.continue(userMessage('run the task'));

    await drain(await chat(chatAgent));

    const lastPrompt = latestStreamPrompt(model);
    assert.deepStrictEqual(reminderTextsIn(lastPrompt), [
      '<system-reminder>TOOL CHECK</system-reminder>',
      '<system-reminder>STEER CHECK</system-reminder>',
    ]);
    assert.strictEqual(
      lastPrompt.filter(
        (message) =>
          (message as { role?: string }).role === 'user' &&
          reminderTextsIn([message]).length > 0,
      ).length,
      1,
    );

    const branch = await store.getActiveBranch('tool-and-steer');
    assert.ok(branch?.headMessageId);
    const chain = await store.getMessageChain(branch.headMessageId);
    const synthetic = chain.find(
      (entry) =>
        entry.name === 'user' &&
        (entry.data as UIMessage).parts.some(
          (part) => part.type === 'text' && part.text.includes('TOOL CHECK'),
        ),
    );
    assert.ok(synthetic, 'expected the combined synthetic reminder in storage');
    assert.deepStrictEqual(
      (synthetic.data as UIMessage).parts.flatMap((part) =>
        part.type === 'text' ? [part.text] : [],
      ),
      [
        '<system-reminder>TOOL CHECK</system-reminder>',
        '<system-reminder>STEER CHECK</system-reminder>',
      ],
    );
  });

  it('does not fold user-target reminders into a synthetic reminder message', async () => {
    const context = new ContextEngine({
      store: new InMemoryContextStore(),
      chatId: 'user-and-tool-reminders',
      userId: 'u1',
    });
    const model = scriptedModel([{ tool: 'noop' }, { text: 'done' }]);
    const chatAgent = await makeAgent(
      context,
      model,
      'user-and-tool-reminders',
    );
    context.set(
      reminder('USER CONTEXT', { target: 'user' }),
      reminder('TOOL CONTEXT', {
        when: toolOutput({ name: 'noop' }),
        target: 'tool-output',
      }),
    );

    await context.continue(userMessage('run the task'));
    await drain(await chat(chatAgent));

    const synthetic = (await context.getMessages()).find(
      isSyntheticReminderMessage,
    );
    assert.ok(synthetic);
    assert.deepStrictEqual(
      synthetic.parts.flatMap((part) =>
        part.type === 'text' ? [part.text] : [],
      ),
      ['<system-reminder>TOOL CONTEXT</system-reminder>'],
    );
  });

  it('leaves the output untouched when the predicate does not fire', async () => {
    const store = new InMemoryContextStore();
    const context = new ContextEngine({ store, chatId: 'quiet', userId: 'u1' });
    const model = scriptedModel([{ tool: 'noop' }, { text: 'done' }]);
    const chatAgent = await makeAgent(context, model, 'quiet');

    context.set(
      reminder('SHOULD NOT APPEAR', {
        when: afterTurn(5),
        target: 'tool-output',
      }),
    );

    await context.continue(userMessage('run the task'));
    await drain(await chat(chatAgent));

    const assistantMsg = await storedAssistant(store, 'quiet');
    assert.deepStrictEqual(toolOutputsOf(assistantMsg), [{ ok: true }]);

    const lastPrompt = latestStreamPrompt(model);
    assert.deepStrictEqual(toolResultValuesIn(lastPrompt), [{ ok: true }]);
  });

  it('evaluates tool-output reminders for thrown tool errors', async () => {
    const context = new ContextEngine({
      store: new InMemoryContextStore(),
      chatId: 'tool-error',
      userId: 'u1',
    });
    const model = scriptedModel([
      { tool: 'throwingTool' },
      { text: 'recovered' },
    ]);
    const chatAgent = await makeAgent(context, model, 'tool-error', {
      throwingTool,
    });
    context.set(
      reminder(
        (ctx) =>
          ctx.toolOutcome?.state === 'output-error'
            ? `RECOVER: ${ctx.toolOutcome.errorText}`
            : '',
        {
          when: toolOutput({
            name: 'throwingTool',
            state: 'output-error',
            error: (error) =>
              error instanceof Error && error.message === 'tool exploded',
            errorText: (text) => text === 'Error: tool exploded',
          }),
          target: 'tool-output',
        },
      ),
    );
    await context.continue(userMessage('run the failing tool'));

    await drain(await chat(chatAgent));

    assert.deepStrictEqual(reminderTextsIn(latestStreamPrompt(model)), [
      '<system-reminder>RECOVER: Error: tool exploded</system-reminder>',
    ]);
    assert.deepStrictEqual(toolResultOutputsIn(latestStreamPrompt(model)), [
      { type: 'error-text', value: 'Error: tool exploded' },
    ]);
  });

  it('evaluates tool-output reminders for denied tool execution', async () => {
    const context = new ContextEngine({
      store: new InMemoryContextStore(),
      chatId: 'tool-denied',
      userId: 'u1',
    });
    const model = scriptedModel([{ tool: 'noop' }, { text: 'recovered' }]);
    context.set(
      reminder('EXPLAIN THE DENIAL', {
        when: toolOutput({
          name: 'noop',
          state: 'output-denied',
          reason: (reason) => reason === 'blocked by policy',
        }),
        target: 'tool-output',
      }),
    );
    await context.continue(userMessage('run the protected tool'));

    const result = streamText({
      model,
      messages: [{ role: 'user', content: 'run the protected tool' }],
      tools: { noop: noopTool },
      toolApproval: {
        noop: { type: 'denied', reason: 'blocked by policy' },
      },
      stopWhen: isStepCount(200),
      prepareStep: context.createPrepareStep(),
    });
    await result.consumeStream();

    assert.deepStrictEqual(reminderTextsIn(latestStreamPrompt(model)), [
      '<system-reminder>EXPLAIN THE DENIAL</system-reminder>',
    ]);
  });

  it('evaluates tool-output reminders for invalid tool input errors', async () => {
    const context = new ContextEngine({
      store: new InMemoryContextStore(),
      chatId: 'invalid-tool-input',
      userId: 'u1',
    });
    const model = scriptedModel([
      { tool: 'requiredInputTool', input: '{}' },
      { text: 'recovered' },
    ]);
    context.set(
      reminder('REPAIR THE TOOL INPUT', {
        when: toolOutput({
          name: 'requiredInputTool',
          state: 'output-error',
        }),
        target: 'tool-output',
      }),
    );
    await context.continue(userMessage('call the required tool'));

    const result = streamText({
      model,
      messages: [{ role: 'user', content: 'call the required tool' }],
      tools: { requiredInputTool },
      stopWhen: isStepCount(200),
      prepareStep: context.createPrepareStep(),
    });
    await result.consumeStream();

    assert.deepStrictEqual(reminderTextsIn(latestStreamPrompt(model)), [
      '<system-reminder>REPAIR THE TOOL INPUT</system-reminder>',
    ]);
  });

  it('injects one reminder for the final async-iterable tool output', async () => {
    const context = new ContextEngine({
      store: new InMemoryContextStore(),
      chatId: 'streaming-tool',
      userId: 'u1',
    });
    const model = scriptedModel([{ tool: 'streamingTool' }, { text: 'done' }]);
    const chatAgent = await makeAgent(context, model, 'streaming-tool', {
      streamingTool,
    });
    context.set(
      reminder('CHECK FINAL OUTPUT', {
        when: afterTurn(0),
        target: 'tool-output',
      }),
    );
    await context.continue(userMessage('run the streaming tool'));

    await drain(await chat(chatAgent));

    assert.deepStrictEqual(reminderTextsIn(latestStreamPrompt(model)), [
      '<system-reminder>CHECK FINAL OUTPUT</system-reminder>',
    ]);
    assert.deepStrictEqual(toolResultValuesIn(latestStreamPrompt(model)), [
      { progress: 2 },
    ]);
  });

  it("preserves the tool's own toModelOutput when a reminder fires", async () => {
    const store = new InMemoryContextStore();
    const context = new ContextEngine({ store, chatId: 'meta', userId: 'u1' });
    const model = scriptedModel([{ tool: 'metaTool' }, { text: 'done' }]);
    const chatAgent = await makeAgent(context, model, 'meta', { metaTool });

    context.set(
      reminder('CHECK', { when: afterTurn(0), target: 'tool-output' }),
    );

    await context.continue(userMessage('run the task'));
    await drain(await chat(chatAgent));

    const lastPrompt = latestStreamPrompt(model);
    assert.deepStrictEqual(toolResultValuesIn(lastPrompt), [{ value: 42 }]);
    assert.deepStrictEqual(reminderTextsIn(lastPrompt), [
      '<system-reminder>CHECK</system-reminder>',
    ]);
  });

  it('composes reminders with the default host-only meta projection', async () => {
    const store = new InMemoryContextStore();
    const context = new ContextEngine({
      store,
      chatId: 'default-meta',
      userId: 'u1',
    });
    const model = scriptedModel([
      { tool: 'defaultMetaTool' },
      { text: 'done' },
    ]);
    const chatAgent = await makeAgent(context, model, 'default-meta', {
      defaultMetaTool,
    });
    context.set(
      reminder('CHECK', { when: afterTurn(0), target: 'tool-output' }),
    );

    await context.continue(userMessage('run the task'));
    await drain(await chat(chatAgent));

    assert.deepStrictEqual(
      (await context.getMessages()).flatMap(toolOutputsOf),
      [{ value: 42, meta: { hidden: 'SECRET' } }],
    );
    assert.deepStrictEqual(toolResultValuesIn(latestStreamPrompt(model)), [
      { value: 42 },
    ]);
    assert.deepStrictEqual(reminderTextsIn(latestStreamPrompt(model)), [
      '<system-reminder>CHECK</system-reminder>',
    ]);
  });

  it('awaits an asynchronous model projection before adding the reminder', async () => {
    const store = new InMemoryContextStore();
    const context = new ContextEngine({
      store,
      chatId: 'async-projection',
      userId: 'u1',
    });
    const model = scriptedModel([{ tool: 'asyncMetaTool' }, { text: 'done' }]);
    const chatAgent = await makeAgent(context, model, 'async-projection', {
      asyncMetaTool,
    });
    context.set(
      reminder('CHECK', { when: afterTurn(0), target: 'tool-output' }),
    );

    await context.continue(userMessage('run the task'));
    await drain(await chat(chatAgent));

    assert.deepStrictEqual(toolResultOutputsIn(latestStreamPrompt(model)), [
      {
        type: 'json',
        value: { value: 42 },
        providerOptions: { test: { projection: 'async' } },
      },
    ]);
    assert.deepStrictEqual(reminderTextsIn(latestStreamPrompt(model)), [
      '<system-reminder>CHECK</system-reminder>',
    ]);
  });

  it('preserves content projections and adds the reminder as a message', async () => {
    const store = new InMemoryContextStore();
    const context = new ContextEngine({
      store,
      chatId: 'content-projection',
      userId: 'u1',
    });
    const model = scriptedModel([{ tool: 'contentTool' }, { text: 'done' }]);
    const chatAgent = await makeAgent(context, model, 'content-projection', {
      contentTool,
    });
    context.set(
      reminder('CHECK', { when: afterTurn(0), target: 'tool-output' }),
    );

    await context.continue(userMessage('read the artifact'));
    await drain(await chat(chatAgent));

    assert.deepStrictEqual(toolResultOutputsIn(latestStreamPrompt(model)), [
      {
        type: 'content',
        value: [
          {
            type: 'file',
            data: { type: 'text', text: 'artifact contents' },
            mediaType: 'text/plain',
            filename: 'artifact.txt',
            providerOptions: { test: { projection: 'content' } },
          },
        ],
      },
    ]);
    assert.deepStrictEqual(reminderTextsIn(latestStreamPrompt(model)), [
      '<system-reminder>CHECK</system-reminder>',
    ]);
  });

  it('preserves text projections and adds the reminder as a message', async () => {
    const context = new ContextEngine({
      store: new InMemoryContextStore(),
      chatId: 'text-projection',
      userId: 'u1',
    });
    const model = scriptedModel([{ tool: 'textTool' }, { text: 'done' }]);
    const chatAgent = await makeAgent(context, model, 'text-projection', {
      textTool,
    });
    context.set(
      reminder('CHECK', { when: afterTurn(0), target: 'tool-output' }),
    );
    await context.continue(userMessage('read the text'));

    await drain(await chat(chatAgent));

    assert.deepStrictEqual(toolResultOutputsIn(latestStreamPrompt(model)), [
      { type: 'text', value: 'projected text result' },
    ]);
    assert.deepStrictEqual(reminderTextsIn(latestStreamPrompt(model)), [
      '<system-reminder>CHECK</system-reminder>',
    ]);
  });

  it('preserves error-text projections and adds the reminder as a message', async () => {
    const context = new ContextEngine({
      store: new InMemoryContextStore(),
      chatId: 'error-text-projection',
      userId: 'u1',
    });
    const model = scriptedModel([{ tool: 'errorTextTool' }, { text: 'done' }]);
    const chatAgent = await makeAgent(context, model, 'error-text-projection', {
      errorTextTool,
    });
    context.set(
      reminder('CHECK', { when: afterTurn(0), target: 'tool-output' }),
    );
    await context.continue(userMessage('run the failing operation'));

    await drain(await chat(chatAgent));

    assert.deepStrictEqual(toolResultOutputsIn(latestStreamPrompt(model)), [
      { type: 'error-text', value: 'projected failure' },
    ]);
    assert.deepStrictEqual(reminderTextsIn(latestStreamPrompt(model)), [
      '<system-reminder>CHECK</system-reminder>',
    ]);
  });

  it('preserves error-json projections and adds the reminder as a message', async () => {
    const context = new ContextEngine({
      store: new InMemoryContextStore(),
      chatId: 'error-json-projection',
      userId: 'u1',
    });
    const model = scriptedModel([{ tool: 'errorJsonTool' }, { text: 'done' }]);
    const chatAgent = await makeAgent(context, model, 'error-json-projection', {
      errorJsonTool,
    });
    context.set(
      reminder('CHECK', { when: afterTurn(0), target: 'tool-output' }),
    );
    await context.continue(userMessage('run the failing operation'));

    await drain(await chat(chatAgent));

    assert.deepStrictEqual(toolResultOutputsIn(latestStreamPrompt(model)), [
      { type: 'error-json', value: { code: 'E_PROJECTED' } },
    ]);
    assert.deepStrictEqual(reminderTextsIn(latestStreamPrompt(model)), [
      '<system-reminder>CHECK</system-reminder>',
    ]);
  });

  it('preserves execution-denied projections and adds the reminder as a message', async () => {
    const context = new ContextEngine({
      store: new InMemoryContextStore(),
      chatId: 'execution-denied-projection',
      userId: 'u1',
    });
    const model = scriptedModel([{ tool: 'deniedTool' }, { text: 'done' }]);
    const chatAgent = await makeAgent(
      context,
      model,
      'execution-denied-projection',
      { deniedTool },
    );
    context.set(
      reminder('CHECK', { when: afterTurn(0), target: 'tool-output' }),
    );
    await context.continue(userMessage('run the denied operation'));

    await drain(await chat(chatAgent));

    assert.deepStrictEqual(toolResultOutputsIn(latestStreamPrompt(model)), [
      { type: 'execution-denied', reason: 'approval denied' },
    ]);
    assert.deepStrictEqual(reminderTextsIn(latestStreamPrompt(model)), [
      '<system-reminder>CHECK</system-reminder>',
    ]);
  });
});
