import { type UIMessage, tool } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { InMemoryFs } from 'just-bash';
import assert from 'node:assert';
import { describe, it } from 'node:test';
import z from 'zod';

import {
  ContextEngine,
  InMemoryContextStore,
  agent,
  assistant,
  createBashTool,
  createVirtualSandbox,
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

async function createVirtualAgentSandbox() {
  return createBashTool({
    sandbox: await createVirtualSandbox({ fs: new InMemoryFs() }),
  });
}

// Mirrors createBashTool's toModelOutput contract: the host-only `meta` channel
// (text2sql populates it via setHidden({ formattedSql })) is stripped before the
// output reaches the model, while the visible fields pass through.
const sqlTool = tool({
  description: 'Run a SQL query',
  inputSchema: z.object({ question: z.string() }),
  execute: async () => ({
    rows: [{ id: 1 }],
    meta: { formattedSql: 'SELECT id FROM users' },
  }),
  toModelOutput: ({ output }: { output: unknown }) => {
    const { meta: _meta, ...visible } = output as { meta?: unknown };
    return { type: 'json' as const, value: visible };
  },
});

// A persisted prior turn: the assistant UIMessage stores the RAW execute() output
// (meta included), because toModelOutput only runs when building model messages,
// not at save time.
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

function toolResultOutputs(
  prompt: readonly { role: string; content: unknown }[],
) {
  const outputs: unknown[] = [];
  for (const message of prompt) {
    if (message.role !== 'tool') continue;
    const content = Array.isArray(message.content) ? message.content : [];
    for (const part of content) {
      if ((part as { type?: string }).type === 'tool-result') {
        outputs.push((part as { output: unknown }).output);
      }
    }
  }
  return outputs;
}

describe('replaying history with a tool result carrying host-only meta', () => {
  it('honors the tool toModelOutput on replay so meta never reaches the model', async () => {
    const engine = new ContextEngine({
      store: new InMemoryContextStore(),
      chatId: `tool-model-output-${Math.random().toString(36).slice(2)}`,
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

    let capturedPrompt: { role: string; content: unknown }[] = [];
    const model = new MockLanguageModelV3({
      doGenerate: async (options) => {
        capturedPrompt = options.prompt as { role: string; content: unknown }[];
        return {
          finishReason: { unified: 'stop', raw: undefined },
          usage: testUsage,
          content: [{ type: 'text', text: 'There are no admins.' }],
          warnings: [],
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

    await sut.generate({});

    const [output] = toolResultOutputs(capturedPrompt);
    assert.deepStrictEqual(output, {
      type: 'json',
      value: { rows: [{ id: 1 }] },
    });
  });
});
