import { openai } from '@ai-sdk/openai';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { input, printer } from '@deepagents/agent';
import {
  ContextEngine,
  InMemoryContextStore,
  Installer,
  type InstallerContext,
  agent,
  chat,
  createContainerTool,
  errorRecoveryGuardrail,
  user,
} from '@deepagents/context';
import { Text2Sql, instructions } from '@deepagents/text2sql';

import adapters from './demo-adapters.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const containerWorkspace = '/workspace';

const sqlBinaryContainer = `${containerWorkspace}/packages/text2sql/dist/bin/sql.js`;
const adaptersContainer = `${containerWorkspace}/demo/demo-adapters.ts`;

const gameboardDbHost =
  process.env.TEXT2SQL_DEMO_GAMEBOARD_DB ??
  '/Users/ezzabuzaid/Desktop/January/text2sql/tools/gameboard.sqlite';
const gpuDbHost =
  process.env.TEXT2SQL_DEMO_GPU_DB ??
  '/Users/ezzabuzaid/Desktop/January/text2sql/tools/gpu-database.sqlite';

class SqlLinkInstaller extends Installer {
  readonly kind = 'sql-link';
  readonly #binary: string;
  constructor(binary: string) {
    super();
    this.#binary = binary;
  }
  async install(ctx: InstallerContext): Promise<void> {
    const result = await ctx.exec(
      `chmod +x ${this.#binary} && ln -sf ${this.#binary} /usr/local/bin/sql`,
    );
    if (result.exitCode !== 0) {
      throw new Error(`sql link install failed: ${result.stderr}`);
    }
  }
}

const model = openai('gpt-5.4-mini');
const sandbox = await createContainerTool({
  image: 'node:22-alpine',
  installers: [new SqlLinkInstaller(sqlBinaryContainer)],
  mounts: [
    {
      hostPath: repoRoot,
      containerPath: containerWorkspace,
      readOnly: false,
    },
    {
      hostPath: gameboardDbHost,
      containerPath: '/data/gameboard.sqlite',
      readOnly: true,
    },
    {
      hostPath: gpuDbHost,
      containerPath: '/data/gpu-database.sqlite',
      readOnly: true,
    },
  ],
  env: {
    NODE_NO_WARNINGS: '1',
    TEXT2SQL_ADAPTERS: adaptersContainer,
    TEXT2SQL_DEMO_GAMEBOARD_DB: '/data/gameboard.sqlite',
    TEXT2SQL_DEMO_GPU_DB: '/data/gpu-database.sqlite',
  },
});
const store = new InMemoryContextStore();
const context = new ContextEngine({
  chatId: 'text2sql-demo',
  userId: 'demo-user',
  store,
});

const text2sql = new Text2Sql({ version: 'demo', adapters, model });
context.set(...instructions(), ...(await text2sql.index()));

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
