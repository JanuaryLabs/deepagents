import { openai } from '@ai-sdk/openai';
import { dirname, resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { input, printer } from '@deepagents/agent';
import {
  agent,
  bin,
  chat,
  createBashTool,
  createDockerSandbox,
  errorRecoveryGuardrail,
  gcs,
  user,
} from '@deepagents/context';

import context, { defaultFragments, index } from './demo-context.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');
const containerWorkspace = '/workspace';
const demoWorkspace = '/tmp/deepagents-demo';
const text2SqlOutDir = `${demoWorkspace}/sql`;
const defaultCloudStoragePath = `${demoWorkspace}/artifacts`;

const sqlShimContainer = `${containerWorkspace}/demo/sql-shim.ts`;
const daemonScriptContainer = `${containerWorkspace}/demo/demo-daemon.ts`;
const daemonPort = 4747;
const daemonUrl = `http://127.0.0.1:${daemonPort}/rpc`;
const daemonLogPath = '/tmp/text2sql-daemon.log';
const adaptersContainer = `${containerWorkspace}/demo/demo-adapters.ts`;

// The artifacts folder is a GCS bucket the DAEMON HOST has mounted with gcsfuse;
// gcs() just binds that host mountpoint into the container (no in-container FUSE,
// no caps). On the daemon host, before running this:
//   gcsfuse january-9f554-deepagents-demo /mnt/gcs-demo
// See the GCS Cloud Storage recipe. Requires a Linux daemon host — not Docker
// Desktop on macOS, where the daemon host is a hidden VM.
const cloudHostMount = '/mnt/gcs-demo';

async function startDaemon(
  sandbox: Awaited<ReturnType<typeof createDockerSandbox>>,
): Promise<void> {
  const spawnResult = await sandbox.executeCommand(
    `nohup node ${daemonScriptContainer} > ${daemonLogPath} 2>&1 < /dev/null & disown; echo $!`,
  );
  const daemonPid = spawnResult.stdout.trim();
  if (spawnResult.exitCode !== 0 || !/^\d+$/.test(daemonPid)) {
    throw new Error(
      `failed to spawn daemon: ${spawnResult.stderr || spawnResult.stdout}`,
    );
  }

  const liveness = await sandbox.executeCommand(`kill -0 ${daemonPid}`);
  if (liveness.exitCode !== 0) {
    const log = await sandbox.executeCommand(`tail -50 ${daemonLogPath}`);
    throw new Error(
      `daemon process ${daemonPid} died immediately. Log tail:\n${log.stdout}`,
    );
  }

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

  const log = await sandbox.executeCommand(`tail -50 ${daemonLogPath}`);
  throw new Error(
    `daemon failed to become ready within 15s. Log tail:\n${log.stdout}`,
  );
}

const backend = await createDockerSandbox({
  name: `demo`,
  image: 'node:lts-alpine',
  installers: [bin(sqlShimContainer, { name: 'sql' })],
  volumes: [
    {
      type: 'bind',
      hostPath: repo,
      containerPath: containerWorkspace,
      readOnly: false,
    },
    gcs({ hostPath: cloudHostMount, mountPath: defaultCloudStoragePath }),
  ],
  env: {
    NODE_NO_WARNINGS: '1',
    TEXT2SQL_ADAPTERS: adaptersContainer,
    TEXT2SQL_OUT_DIR: text2SqlOutDir,
    TEXT2SQL_DAEMON_URL: daemonUrl,
    DEEPAGENTS_DEMO_CLOUD_STORAGE_PATH: defaultCloudStoragePath,
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

await startDaemon(backend);

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
