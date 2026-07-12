import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';
import {
  type UIMessage,
  generateId,
  isToolUIPart,
  simulateReadableStream,
} from 'ai';
import {
  MockLanguageModelV4,
  convertReadableStreamToArray as drain,
} from 'ai/test';
import { InMemoryFs } from 'just-bash';
import assert from 'node:assert';
import { describe, it } from 'node:test';

import {
  ContextEngine,
  InMemoryContextStore,
  agent,
  chat,
  createBashTool,
  createVirtualSandbox,
  reminder,
} from '@deepagents/context';

const USAGE = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
} as const;

const NUDGE = 'VALIDATE-FIRST-NUDGE';

// step 1 -> call `bash` with `command`, step 2 -> emit text and stop.
function bashThenStop(command: string) {
  const model = new MockLanguageModelV4({
    doStream: async () => {
      const call = model.doStreamCalls.length;
      const id = `s${call}`;
      const chunks: LanguageModelV4StreamPart[] =
        call === 1
          ? [
              {
                type: 'tool-call',
                toolCallId: 'c1',
                toolName: 'bash',
                input: JSON.stringify({ command, reasoning: 'run it' }),
              },
              {
                type: 'finish',
                finishReason: { unified: 'tool-calls', raw: '' },
                usage: USAGE,
              },
            ]
          : [
              { type: 'text-start', id },
              { type: 'text-delta', id, delta: 'done' },
              { type: 'text-end', id },
              {
                type: 'finish',
                finishReason: { unified: 'stop', raw: '' },
                usage: USAGE,
              },
            ];
      return {
        stream: simulateReadableStream({ chunks }),
      };
    },
  });
  return model;
}

function userMessage(text: string): UIMessage {
  return { id: generateId(), role: 'user', parts: [{ type: 'text', text }] };
}

async function storedToolOutput(
  store: InMemoryContextStore,
  chatId: string,
): Promise<Record<string, unknown>> {
  const branch = await store.getActiveBranch(chatId);
  assert.ok(branch?.headMessageId, 'expected a branch head');
  const chain = await store.getMessageChain(branch.headMessageId);
  const outputs = chain
    .filter((entry) => entry.name === 'assistant')
    .flatMap((entry) => (entry.data as UIMessage).parts)
    .filter(isToolUIPart)
    .filter((part) => part.state === 'output-available')
    .map((part) => part.output);
  assert.equal(outputs.length, 1, 'expected exactly one tool output');
  return outputs[0] as Record<string, unknown>;
}

async function runBash(chatId: string, command: string) {
  const store = new InMemoryContextStore();
  const context = new ContextEngine({ store, chatId, userId: 'u1' });
  const model = bashThenStop(command);
  const sandbox = await createBashTool({
    sandbox: await createVirtualSandbox({ fs: new InMemoryFs() }),
  });
  const chatAgent = agent({ sandbox, name: chatId, context, model });

  context.set(
    reminder(NUDGE, {
      target: 'tool-output',
      when: (ctx) => {
        const call = ctx.toolOutcome;
        return (
          call?.name === 'bash' &&
          /^\s*sql\s+run\b/.test((call.input as { command: string }).command)
        );
      },
    }),
  );

  await context.continue(userMessage('go'));
  await drain(await chat(chatAgent));
  return { output: await storedToolOutput(store, chatId), model };
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

describe('ctx.toolOutcome gates a tool-output reminder on the live bash command', () => {
  it('injects a reminder after a matching `sql run` result', async () => {
    const { output, model } = await runBash('run', 'sql run main "SELECT 1"');
    assert.ok('exitCode' in output, 'stored output remains the raw result');
    assert.deepStrictEqual(
      reminderTextsIn(model.doStreamCalls.at(-1)?.prompt ?? []),
      [`<system-reminder>${NUDGE}</system-reminder>`],
    );
  });

  it('does not inject after `sql validate` when the input predicate misses', async () => {
    const { output, model } = await runBash(
      'validate',
      'sql validate main "SELECT 1"',
    );
    assert.ok(
      'exitCode' in output,
      'stored output is the raw bash CommandResult',
    );
    assert.deepStrictEqual(
      reminderTextsIn(model.doStreamCalls.at(-1)?.prompt ?? []),
      [],
    );
  });
});
