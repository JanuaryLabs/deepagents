import { openai } from '@ai-sdk/openai';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { input, printer } from '@deepagents/agent';
import {
  ContextEngine,
  type ContextFragment,
  InMemoryContextStore,
  Installer,
  type InstallerContext,
  agent,
  chat,
  createContainerTool,
  errorRecoveryGuardrail,
  user,
} from '@deepagents/context';
import { instructions } from '@deepagents/text2sql';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const containerWorkspace = '/workspace';

const sqlBinaryContainer = `${containerWorkspace}/packages/text2sql/dist/bin/sql.js`;
const adaptersContainer = `${containerWorkspace}/demo/demo-adapters.ts`;

interface SqlIndexManifest {
  fragmentsPath: string;
  eventsPath: string;
  adapters: string[];
  fragments: number;
}

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
  image: 'node:lts-alpine',
  installers: [new SqlLinkInstaller(sqlBinaryContainer)],
  mounts: [
    {
      hostPath: repoRoot,
      containerPath: containerWorkspace,
      readOnly: false,
    },
    {
      hostPath:
        '/Users/ezzabuzaid/Desktop/January/text2sql/tools/gameboard.sqlite',
      containerPath: '/data/gameboard.sqlite',
      readOnly: true,
    },
    {
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
const store = new InMemoryContextStore();
const context = new ContextEngine({
  chatId: 'text2sql-demo',
  userId: 'demo-user',
  store,
});

const indexResult = await sandbox.sandbox.executeCommand('sql index');
if (indexResult.exitCode !== 0) {
  throw new Error(`sql index failed: ${indexResult.stderr}`);
}
const indexManifest = JSON.parse(indexResult.stdout) as SqlIndexManifest;
const indexFragments = JSON.parse(
  await sandbox.sandbox.readFile(indexManifest.fragmentsPath),
) as ContextFragment[];

context.set(...instructions(), ...indexFragments);
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
