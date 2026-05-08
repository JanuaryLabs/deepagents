import { openai } from '@ai-sdk/openai';
import { InMemoryFs } from 'just-bash';
import { DatabaseSync } from 'node:sqlite';

import { input, printer } from '@deepagents/agent';
import {
  ContextEngine,
  InMemoryContextStore,
  agent,
  chat,
  createBashTool,
  createRoutingSandbox,
  createVirtualSandbox,
  errorRecoveryGuardrail,
  user,
} from '@deepagents/context';

import { Sqlite, info, tables } from './adapters/sqlite/index.ts';
import { instructions } from './instructions.ts';
import { sqlSandboxExtension } from './sandbox.ts';
import { Text2Sql } from './sql.ts';

function open(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  return new Sqlite({
    grounding: [tables(), info()],
    execute: (sql: string) => db.prepare(sql).all(),
  });
}

const adapters = {
  gameboard: open(
    '/Users/ezzabuzaid/Desktop/January/text2sql/tools/gameboard.sqlite',
  ),
  gpu_database: open(
    '/Users/ezzabuzaid/Desktop/January/text2sql/tools/gpu-database.sqlite',
  ),
};

const model = openai('gpt-5.4-mini');

const sandbox = await createBashTool({
  destination: '/',
  sandbox: await createRoutingSandbox({
    backend: await createVirtualSandbox({ fs: new InMemoryFs() }),
    hostExtensions: [sqlSandboxExtension(adapters)],
  }),
});

const store = new InMemoryContextStore();
const context = new ContextEngine({
  chatId: 'text2sql-demo',
  userId: 'demo-user',
  store,
});
const text2sql = new Text2Sql({ version: 'demo', adapters, model });

const ai = agent({
  name: 'text2sql',
  sandbox,
  model,
  context,
  guardrails: [errorRecoveryGuardrail],
  maxGuardrailRetries: 3,
});

let text = 'List the top 5 board games by rating.';

while (true) {
  context.set(...instructions(), ...(await text2sql.index()));
  await context.continue(user(text));
  await printer.readableStream(await chat(ai));
  text = await input();
}
