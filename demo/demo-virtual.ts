import { openai } from '@ai-sdk/openai';
import { InMemoryFs } from 'just-bash';

import { input, printer } from '@deepagents/agent';
import {
  agent,
  chat,
  createBashTool,
  createVirtualSandbox,
  errorRecoveryGuardrail,
  user,
} from '@deepagents/context';
import { Text2Sql, createSqlCommand } from '@deepagents/text2sql';

import adapters from './demo-adapters.ts';
import context, { defaultFragments, index } from './demo-context.ts';

const text2Sql = new Text2Sql({
  adapters,
  version: process.env.TEXT2SQL_INDEX_VERSION,
});
const { command: sqlCommand } = createSqlCommand(text2Sql);

const backend = await createVirtualSandbox({
  fs: new InMemoryFs(),
  env: { TEXT2SQL_OUT_DIR: '/sql' },
  customCommands: [sqlCommand],
});

const sandbox = await createBashTool({ sandbox: backend });

const schemaFragments = await index(sandbox.sandbox);
context.set(...defaultFragments, ...schemaFragments);

const demoAgent = agent({
  name: 'text2sql-virtual',
  sandbox,
  model: openai('gpt-5.4-mini'),
  context,
  guardrails: [errorRecoveryGuardrail],
  maxGuardrailRetries: 3,
});

let text = 'List the top 5 longest films in pagila.';

while (true) {
  await context.continue(user(text));
  const stream = await chat(demoAgent);
  await printer.readableStream(stream);
  text = await input();
}
