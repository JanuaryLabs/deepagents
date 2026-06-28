import {
  type ToolSet,
  type UIMessage,
  generateId,
  isToolUIPart,
  simulateReadableStream,
  tool,
} from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { InMemoryFs } from 'just-bash';
import assert from 'node:assert';
import { describe, it } from 'node:test';
import { z } from 'zod';

import {
  ContextEngine,
  InMemoryContextStore,
  afterTurn,
  agent,
  chat,
  createBashTool,
  createVirtualSandbox,
  reminder,
  stripReminders,
} from '@deepagents/context';

const testUsage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
} as const;

type StepSpec = { tool: string } | { text: string };

function scriptedModel(steps: StepSpec[], prompts: unknown[][]) {
  let call = 0;
  return new MockLanguageModelV3({
    doStream: async ({ prompt }) => {
      prompts.push(prompt as unknown[]);
      const spec = steps[Math.min(call, steps.length - 1)];
      call++;
      const id = `s${call}`;
      const chunks: Record<string, unknown>[] = [];
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
          input: '{}',
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
        stream: simulateReadableStream({ chunks: chunks as never }),
        rawCall: { rawPrompt: undefined, rawSettings: {} },
      };
    },
  });
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

async function makeAgent(
  context: ContextEngine,
  model: MockLanguageModelV3,
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

async function drain(stream: ReadableStream) {
  const reader = stream.getReader();
  while (true) {
    const { done } = await reader.read();
    if (done) break;
  }
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

const WRAPPED_STORED = {
  result: { ok: true },
  systemReminder: '<system-reminder>CHECK THE FS TOOLS</system-reminder>',
  meta: { reminder: true },
};
const WRAPPED_VISIBLE = {
  result: { ok: true },
  systemReminder: '<system-reminder>CHECK THE FS TOOLS</system-reminder>',
};

describe('tool-output reminders (execute-time wrapping)', () => {
  it('wraps the output the model sees on its next step AND the stored part identically (parity)', async () => {
    const store = new InMemoryContextStore();
    const context = new ContextEngine({ store, chatId: 'wrap', userId: 'u1' });
    const prompts: unknown[][] = [];
    const model = scriptedModel([{ tool: 'noop' }, { text: 'done' }], prompts);
    const chatAgent = await makeAgent(context, model, 'wrap');

    context.set(
      reminder('CHECK THE FS TOOLS', {
        when: afterTurn(0),
        target: 'tool-output',
      }),
    );

    await context.continue(userMessage('run the task'));
    await drain(await chat(chatAgent));

    const assistantMsg = await storedAssistant(store, 'wrap');
    assert.deepStrictEqual(toolOutputsOf(assistantMsg), [WRAPPED_STORED]);

    const lastPrompt = prompts[prompts.length - 1];
    assert.deepStrictEqual(
      toolResultValuesIn(lastPrompt),
      [WRAPPED_VISIBLE],
      'the model sees result+reminder but not the host-only meta marker',
    );
  });

  it('wraps every matching execution, including multiple calls in one turn', async () => {
    const store = new InMemoryContextStore();
    const context = new ContextEngine({ store, chatId: 'multi', userId: 'u1' });
    const prompts: unknown[][] = [];
    const model = scriptedModel(
      [{ tool: 'noop' }, { tool: 'noop' }, { text: 'done' }],
      prompts,
    );
    const chatAgent = await makeAgent(context, model, 'multi');

    context.set(
      reminder('CHECK THE FS TOOLS', {
        when: afterTurn(0),
        target: 'tool-output',
      }),
    );

    await context.continue(userMessage('run the task twice'));
    await drain(await chat(chatAgent));

    const assistantMsg = await storedAssistant(store, 'multi');
    assert.deepStrictEqual(toolOutputsOf(assistantMsg), [
      WRAPPED_STORED,
      WRAPPED_STORED,
    ]);
  });

  it('leaves the output untouched when the predicate does not fire', async () => {
    const store = new InMemoryContextStore();
    const context = new ContextEngine({ store, chatId: 'quiet', userId: 'u1' });
    const prompts: unknown[][] = [];
    const model = scriptedModel([{ tool: 'noop' }, { text: 'done' }], prompts);
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

    const lastPrompt = prompts[prompts.length - 1];
    assert.deepStrictEqual(toolResultValuesIn(lastPrompt), [{ ok: true }]);
  });

  it('stripReminders unwraps the envelope back to the raw output', async () => {
    const store = new InMemoryContextStore();
    const context = new ContextEngine({ store, chatId: 'strip', userId: 'u1' });
    const prompts: unknown[][] = [];
    const model = scriptedModel([{ tool: 'noop' }, { text: 'done' }], prompts);
    const chatAgent = await makeAgent(context, model, 'strip');

    context.set(
      reminder('CHECK THE FS TOOLS', {
        when: afterTurn(0),
        target: 'tool-output',
      }),
    );

    await context.continue(userMessage('run the task'));
    await drain(await chat(chatAgent));

    const assistantMsg = await storedAssistant(store, 'strip');
    assert.deepStrictEqual(toolOutputsOf(assistantMsg), [WRAPPED_STORED]);

    const stripped = stripReminders(assistantMsg);
    assert.deepStrictEqual(toolOutputsOf(stripped), [{ ok: true }]);
  });

  it("applies the wrapped tool's own toModelOutput to the inner result when a reminder fires", async () => {
    const store = new InMemoryContextStore();
    const context = new ContextEngine({ store, chatId: 'meta', userId: 'u1' });
    const prompts: unknown[][] = [];
    const model = scriptedModel(
      [{ tool: 'metaTool' }, { text: 'done' }],
      prompts,
    );
    const chatAgent = await makeAgent(context, model, 'meta', { metaTool });

    context.set(
      reminder('CHECK', { when: afterTurn(0), target: 'tool-output' }),
    );

    await context.continue(userMessage('run the task'));
    await drain(await chat(chatAgent));

    const lastPrompt = prompts[prompts.length - 1];
    assert.deepStrictEqual(
      toolResultValuesIn(lastPrompt),
      [
        {
          result: { value: 42 },
          systemReminder: '<system-reminder>CHECK</system-reminder>',
        },
      ],
      "the tool's host-only meta must be stripped from the inner result even when a reminder fires",
    );
  });
});
