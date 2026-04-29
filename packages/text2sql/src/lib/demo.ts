import { openai } from '@ai-sdk/openai';
import { InMemoryFs } from 'just-bash';
import { DatabaseSync } from 'node:sqlite';

import { input, printer } from '@deepagents/agent';
import {
  ContextEngine,
  InMemoryContextStore,
  createBashTool,
  createRoutingSandbox,
  createVirtualSandbox,
  user,
} from '@deepagents/context';

import { Sqlite, info, tables } from './adapters/sqlite/index.ts';
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

const sandbox = await createBashTool({
  destination: '/',
  sandbox: await createRoutingSandbox({
    backend: await createVirtualSandbox({ fs: new InMemoryFs() }),
    hostExtensions: [sqlSandboxExtension(adapters)],
  }),
});

const store = new InMemoryContextStore();
const engine = new ContextEngine({
  chatId: 'text2sql-demo',
  userId: 'demo-user',
  store,
});
const text2sql = new Text2Sql({
  version: 'demo',
  sandbox,
  adapters,
  model: openai('gpt-5.4-mini'),
  context: (...fragments) => engine.set(...fragments),
});

let text = 'List the top 5 board games by rating.';

while (true) {
  const stream = await text2sql.chat([user(text)]);
  await printer.readableStream(stream);
  text = await input();
}
