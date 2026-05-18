import { openai } from '@ai-sdk/openai';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { input, printer } from '@deepagents/agent';
import {
  ContextEngine,
  type ContextFragment,
  InMemoryContextStore,
  agent,
  bin,
  chat,
  createBashTool,
  createDockerSandbox,
  errorRecoveryGuardrail,
  user,
} from '@deepagents/context';
import { instructions } from '@deepagents/text2sql';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const containerWorkspace = '/workspace';

const sqlBinaryContainer = `${containerWorkspace}/packages/text2sql/dist/bin/sql.js`;
const adaptersContainer = `${containerWorkspace}/demo/demo-adapters.ts`;

const model = openai('gpt-5.4-mini');
const backend = await createDockerSandbox({
  image: 'node:lts-alpine',
  installers: [bin(sqlBinaryContainer)],
  volumes: [
    {
      type: 'bind',
      hostPath: repoRoot,
      containerPath: containerWorkspace,
      readOnly: false,
    },
    {
      type: 'bind',
      hostPath:
        '/Users/ezzabuzaid/Desktop/January/text2sql/tools/gameboard.sqlite',
      containerPath: '/data/gameboard.sqlite',
      readOnly: true,
    },
    {
      type: 'bind',
      hostPath:
        '/Users/ezzabuzaid/Desktop/January/text2sql/tools/gpu-database.sqlite',
      containerPath: '/data/gpu-database.sqlite',
      readOnly: true,
    },
  ],
  env: {
    NODE_NO_WARNINGS: '1',
    TEXT2SQL_ADAPTERS: adaptersContainer,
  },
});
const sandbox = await createBashTool({ sandbox: backend });
const store = new InMemoryContextStore();
const context = new ContextEngine({
  chatId: 'text2sql-demo',
  userId: 'demo-user',
  store,
});

async function index() {
  const result = await sandbox.sandbox.executeCommand('sql index');
  if (result.exitCode !== 0) {
    throw new Error(`sql index failed: ${result.stderr}`);
  }
  const indexManifest = JSON.parse(result.stdout) as {
    fragmentsPath: string;
    eventsPath: string;
    adapters: string[];
    fragments: number;
  };
  return JSON.parse(
    await sandbox.sandbox.readFile(indexManifest.fragmentsPath),
  ) as ContextFragment[];
}

context.set(...instructions(), ...(await index()));
const demoAgent = agent({
  name: 'text2sql',
  sandbox,
  model,
  context,
  guardrails: [errorRecoveryGuardrail],
  maxGuardrailRetries: 3,
});

let text = 'List the top 5 board games by rating.';

while (true) {
  await context.continue(user(text));
  const stream = await chat(demoAgent);
  await printer.readableStream(stream);
  text = await input();
}
