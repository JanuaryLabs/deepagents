import { openai } from '@ai-sdk/openai';
import { dirname, resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { input, printer } from '@deepagents/agent';
import {
  agent,
  chat,
  createBashTool,
  createDockerSandbox,
  errorRecoveryGuardrail,
  user,
} from '@deepagents/context';

import context, { defaultFragments, index } from './demo-context.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..');
const dockerfile = resolve(here, '..', 'text2sql-daemon', 'Dockerfile');

const demoWorkspace = '/tmp/deepagents-demo';
const text2SqlOutDir = `${demoWorkspace}/sql`;

const daemonPort = 4747;
const daemonUrl = `http://127.0.0.1:${daemonPort}/rpc`;

async function waitForDaemon(
  sandbox: Awaited<ReturnType<typeof createDockerSandbox>>,
): Promise<void> {
  const healthProbe =
    `node -e "fetch('http://127.0.0.1:${daemonPort}/health')` +
    `.then(r => r.ok ? r.text().then(t => { process.stdout.write(t); process.exit(0); }) : process.exit(1))` +
    `.catch(() => process.exit(1))"`;

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const health = await sandbox.executeCommand(healthProbe);
    if (health.exitCode === 0) {
      console.log(`[demo] daemon ready: ${health.stdout.trim()}`);
      return;
    }
    await setTimeout(250);
  }

  // The daemon runs as the container's main process (CMD), so if it never
  // becomes ready the container has usually exited — most often because the
  // external Postgres at PGHOST is unreachable.
  throw new Error(
    `daemon did not become ready within 15s. The daemon runs as the ` +
      `container's main process; check that Postgres at ` +
      `${process.env.PGHOST ?? 'host.docker.internal'}:${process.env.PGPORT ?? '5432'} is reachable.`,
  );
}

const backend = await createDockerSandbox({
  dockerfile,
  context: repo,
  command: null,
  env: {
    NODE_NO_WARNINGS: '1',
    TEXT2SQL_OUT_DIR: text2SqlOutDir,
    TEXT2SQL_DAEMON_URL: daemonUrl,
    PORT: String(daemonPort),
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

await waitForDaemon(backend);

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

let text =
  'List the top 5 longest films in pagila and store them in a file in artifacts folder.';

while (true) {
  await context.continue(user(text));
  const stream = await chat(demoAgent);
  await printer.readableStream(stream);
  text = await input();
}
