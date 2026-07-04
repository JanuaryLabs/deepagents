import {
  type UIMessage,
  generateId,
  isToolUIPart,
  simulateReadableStream,
} from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
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
  let call = 0;
  return new MockLanguageModelV3({
    doStream: async () => {
      call++;
      const id = `s${call}`;
      const chunks: Record<string, unknown>[] =
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
        stream: simulateReadableStream({ chunks: chunks as never }),
        rawCall: { rawPrompt: undefined, rawSettings: {} },
      };
    },
  });
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

async function storedToolOutput(
  store: InMemoryContextStore,
  chatId: string,
): Promise<Record<string, unknown>> {
  const branch = await store.getActiveBranch(chatId);
  assert.ok(branch?.headMessageId, 'expected a branch head');
  const chain = await store.getMessageChain(branch.headMessageId);
  const assistant = chain.findLast((e) => e.name === 'assistant');
  assert.ok(assistant, 'expected a stored assistant message');
  const msg = assistant.data as UIMessage;
  const outputs = msg.parts
    .filter(isToolUIPart)
    .filter((p) => p.state === 'output-available')
    .map((p) => p.output);
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
        const call = ctx.executingTool;
        return (
          call?.name === 'bash' &&
          /^\s*sql\s+run\b/.test((call.input as { command: string }).command)
        );
      },
    }),
  );

  await context.continue(userMessage('go'));
  await drain(await chat(chatAgent));
  return storedToolOutput(store, chatId);
}

describe('ctx.executingTool gates a tool-output reminder on the live bash command', () => {
  it('wraps a `sql run` result with the tagged reminder', async () => {
    const output = await runBash('run', 'sql run main "SELECT 1"');
    assert.ok('systemReminder' in output, 'sql run output should be wrapped');
    assert.match(String(output.systemReminder), /<system-reminder>/);
    assert.match(String(output.systemReminder), new RegExp(NUDGE));
    assert.ok('result' in output, 'wrapped envelope carries the inner result');
  });

  it('does NOT wrap a `sql validate` result (input predicate misses)', async () => {
    const output = await runBash('validate', 'sql validate main "SELECT 1"');
    assert.ok(
      !('systemReminder' in output),
      'sql validate output must be the raw, unwrapped result',
    );
    assert.ok(
      'exitCode' in output,
      'unwrapped result is the raw bash CommandResult',
    );
  });
});
