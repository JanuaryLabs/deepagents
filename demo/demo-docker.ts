import { openai } from '@ai-sdk/openai';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { input, printer } from '@deepagents/agent';
import {
  agent,
  bin,
  chat,
  createBashTool,
  createDockerSandbox,
  errorRecoveryGuardrail,
  user,
} from '@deepagents/context';

import context, { defaultFragments, index } from './demo-context.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const containerWorkspace = '/workspace';
const demoWorkspace = '/tmp/deepagents-demo';
const text2SqlOutDir = `${demoWorkspace}/sql`;
const sandboxName = `text2sql-demo-${process.pid}-${Date.now().toString(36)}`;
const dockerContainerName = `sandbox-${sandboxName}`;

const sqlBinaryContainer = `${containerWorkspace}/packages/text2sql/dist/bin/sql.js`;
const adaptersContainer = `${containerWorkspace}/demo/demo-adapters.ts`;

let backend: Awaited<ReturnType<typeof createDockerSandbox>> | undefined;
let disposing = false;
let needsSyncContainerCleanup = false;

function isUserAbort(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'AbortError' ||
      (error as Error & { code?: string }).code === 'ABORT_ERR')
  );
}

async function disposeBackend(): Promise<void> {
  if (!backend || disposing) return;
  disposing = true;
  await backend.dispose();
  needsSyncContainerCleanup = false;
}

process.once('SIGINT', () => {
  void disposeBackend().finally(() => process.exit(130));
});

process.once('SIGTERM', () => {
  void disposeBackend().finally(() => process.exit(143));
});

process.once('exit', () => {
  if (!needsSyncContainerCleanup) return;
  spawnSync('docker', ['stop', dockerContainerName], { stdio: 'ignore' });
});

async function main(): Promise<void> {
  needsSyncContainerCleanup = true;
  backend = await createDockerSandbox({
    image: 'node:lts-alpine',
    name: sandboxName,
    installers: [bin(sqlBinaryContainer)],
    volumes: [
      {
        type: 'bind',
        hostPath: repoRoot,
        containerPath: containerWorkspace,
        readOnly: false,
      },
    ],
    env: {
      NODE_NO_WARNINGS: '1',
      TEXT2SQL_ADAPTERS: adaptersContainer,
      TEXT2SQL_OUT_DIR: text2SqlOutDir,
      // Container reaches the host's text2sql-database-1 via host.docker.internal.
      PGHOST: process.env.PGHOST ?? 'host.docker.internal',
      PGPORT: process.env.PGPORT ?? '5432',
      PGUSER: process.env.PGUSER ?? 'postgres',
      PGPASSWORD: process.env.PGPASSWORD ?? 'postgres',
    },
  });

  const prepareResult = await backend.executeCommand(
    `mkdir -p "${demoWorkspace}" "${text2SqlOutDir}"`,
  );
  if (prepareResult.exitCode !== 0) {
    throw new Error(
      prepareResult.stderr ||
        `mkdir failed with exit code ${prepareResult.exitCode}`,
    );
  }

  const sandbox = await createBashTool({
    sandbox: backend,
    destination: demoWorkspace,
  });

  const schemaFragments = await index(sandbox.sandbox);
  context.set(...defaultFragments, ...schemaFragments);

  const demoAgent = agent({
    name: 'text2sql-docker',
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
}

try {
  await main();
} catch (error) {
  if (isUserAbort(error)) {
    await disposeBackend();
    process.exitCode = 130;
  } else {
    await disposeBackend();
    throw error;
  }
}
