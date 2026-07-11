import {
  type UIMessage,
  generateId,
  isToolUIPart,
  simulateReadableStream,
} from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { InMemoryFs } from 'just-bash';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';

import {
  ContextEngine,
  InMemoryContextStore,
  agent,
  chat,
  createBashTool,
  createVirtualSandbox,
} from '@deepagents/context';
import {
  FileIndexLock,
  Text2Sql,
  createSqlCommand,
  sqlValidateReminder,
} from '@deepagents/text2sql';
import { Sqlite, info, tables } from '@deepagents/text2sql/sqlite';

const USAGE = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
} as const;

function sqlCommand() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL);`);
  db.exec(`INSERT INTO users (id, name) VALUES (1, 'Alice'), (2, 'Bob');`);
  const mem = new Sqlite({
    execute: (sql) => db.prepare(sql).all(),
    grounding: [tables(), info()],
  });
  const text2Sql = new Text2Sql({
    adapters: { mem },
    lock: new FileIndexLock(),
  });
  return createSqlCommand(text2Sql).command;
}

// One `bash` tool call per command, in order, then a text step that stops.
function scriptedBash(commands: string[]) {
  let call = 0;
  return new MockLanguageModelV4({
    doStream: async () => {
      const idx = call;
      call++;
      const id = `s${call}`;
      const chunks: Record<string, unknown>[] =
        idx < commands.length
          ? [
              {
                type: 'tool-call',
                toolCallId: `c${call}`,
                toolName: 'bash',
                input: JSON.stringify({
                  command: commands[idx],
                  reasoning: 'run the query',
                }),
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

async function drain(stream: ReadableStream) {
  const reader = stream.getReader();
  while (true) {
    const { done } = await reader.read();
    if (done) break;
  }
}

// Drive a real agent loop over `commands` with the sql-validate reminder
// registered, and return the stored tool outputs in call order.
async function runToolOutputs(
  chatId: string,
  commands: string[],
): Promise<Record<string, unknown>[]> {
  const backend = await createVirtualSandbox({
    fs: new InMemoryFs(),
    customCommands: [sqlCommand()],
  });
  await backend.executeCommand('mkdir -p /workspace /sql');
  const sandbox = await createBashTool({ sandbox: backend });

  const store = new InMemoryContextStore();
  const context = new ContextEngine({ store, chatId, userId: 'u1' });
  context.set(sqlValidateReminder());

  const chatAgent = agent({
    sandbox,
    name: chatId,
    context,
    model: scriptedBash(commands),
  });

  await context.continue({
    id: generateId(),
    role: 'user',
    parts: [{ type: 'text', text: 'answer the question' }],
  });
  await drain(await chat(chatAgent));

  const branch = await store.getActiveBranch(chatId);
  assert.ok(branch?.headMessageId);
  const chain = await store.getMessageChain(branch.headMessageId);
  const assistant = chain.findLast((e) => e.name === 'assistant');
  assert.ok(assistant, 'expected a stored assistant message');
  return (assistant.data as UIMessage).parts
    .filter(isToolUIPart)
    .filter((p) => p.state === 'output-available')
    .map((p) => p.output as Record<string, unknown>);
}

const QUERY = 'sql run mem "SELECT id, name FROM users"';
const VALIDATE = 'sql validate mem "SELECT id, name FROM users"';

describe('sqlValidateReminder over a real agent loop', () => {
  it('nudges on a `sql run` that was not preceded by a validate', async () => {
    const [runOutput] = await runToolOutputs('unvalidated', [QUERY]);
    assert.ok('systemReminder' in runOutput, 'run result should be wrapped');
    assert.match(String(runOutput.systemReminder), /<system-reminder>/);
    assert.match(String(runOutput.systemReminder), /sql validate/);
  });

  it('suppresses the nudge when the same query was already validated', async () => {
    const [validateOutput, runOutput] = await runToolOutputs('validated', [
      VALIDATE,
      QUERY,
    ]);
    assert.ok(
      !('systemReminder' in validateOutput),
      'validate result is never nudged',
    );
    assert.ok(
      !('systemReminder' in runOutput),
      'run after a matching validate must not be nudged',
    );
  });
});
