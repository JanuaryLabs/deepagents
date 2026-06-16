import { openai } from '@ai-sdk/openai';
import { Daytona } from '@daytona/sdk';
import { setTimeout } from 'node:timers/promises';

import { input, printer } from '@deepagents/agent';
import {
  agent,
  chat,
  createBashTool,
  createDaytonaSandbox,
  errorRecoveryGuardrail,
  user,
} from '@deepagents/context';

import context, { defaultFragments, index } from './demo-context.ts';
import { runnerImage } from './image.ts';

const daemonDir = '/repo/demo/text2sql-daemon/daemon';
const daemonScript = `${daemonDir}/demo-daemon.ts`;

const demoWorkspace = '/tmp/deepagents-demo';
const text2SqlOutDir = `${demoWorkspace}/sql`;

const daemonPort = 4747;
const daemonUrl = `http://127.0.0.1:${daemonPort}/rpc`;
const daemonLogPath = '/tmp/text2sql-daemon.log';

// Daytona boots the sandbox with its own init rather than the image CMD, so the
// daemon is started explicitly here: spawn it detached, confirm the process is
// alive, then poll /health until the Hono server is accepting requests.
async function startDaemon(
  sandbox: Awaited<ReturnType<typeof createDaytonaSandbox>>,
): Promise<void> {
  // Daytona's exec shell is POSIX sh (alpine), so no `disown` bash-ism — nohup
  // + redirected stdio already detaches the daemon so it survives this exec.
  const spawnResult = await sandbox.executeCommand(
    `nohup node ${daemonScript} > ${daemonLogPath} 2>&1 < /dev/null & echo $!`,
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
    `daemon did not become ready within 15s. Check that Postgres at ` +
      `${process.env.PGHOST ?? 'host.docker.internal'}:${process.env.PGPORT ?? '5432'} ` +
      `is reachable from the Daytona sandbox. Log tail:\n${log.stdout}`,
  );
}

const client = new Daytona({
  apiKey:
    'dtn_05fc820697b48a2980b168711c218c1c945a5f591843e986d6b010d1043bb975',
  apiUrl: 'http://localhost:3000/api',
});

const backend = await createDaytonaSandbox(client, {
  // Stable name → get-or-create: re-runs reuse this one sandbox instead of
  // orphaning a fresh one each time (dispose() never deletes it).
  name: 'deepagents-text2sql-demo',
  // Build + publish this image first: `node demo/daytona-text2sql/bootstrap.ts`.
  // createDaytonaSandbox(client, { name, image }) makes Daytona run a buildkit
  // BUILD_SNAPSHOT (FROM <image>) the first time — ~40s, then buildkit-cached
  // (~1s). The pinned single-arch tag (see bootstrap.ts) is what lets that
  // build resolve.
  image: runnerImage,
  createTimeout: 120,
  onSnapshotCreateLogs: (chunk) =>
    process.stdout.write(`[daytona build] ${chunk}`),
  envVars: {
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

process.once(
  'SIGINT',
  () => void backend.dispose().then(() => process.exit(0)),
);

// The image pre-creates these, but own the dirs here so the demo doesn't break
// silently if demoWorkspace ever diverges from the Dockerfile's mkdir.
const prepare = await backend.executeCommand(
  `mkdir -p "${demoWorkspace}" "${text2SqlOutDir}"`,
);
if (prepare.exitCode !== 0) {
  throw new Error(
    prepare.stderr || `mkdir failed with exit code ${prepare.exitCode}`,
  );
}

await startDaemon(backend);

const sandbox = await createBashTool({
  sandbox: backend,
  destination: demoWorkspace,
  // Per-tool-call filesystem-change tracking is always on via strace. Requires the
  // runner image to bake in strace — re-run bootstrap.ts after the Dockerfile change.
  onFileChanges: (changes) => {
    for (const c of changes) {
      console.log(
        `[files] ${c.op} ${c.path}${c.from ? ` (from ${c.from})` : ''}`,
      );
    }
  },
});

const schemaFragments = await index(sandbox.sandbox);
context.set(...defaultFragments, ...schemaFragments);

const demoAgent = agent({
  name: 'text2sql-daytona',
  sandbox,
  model: openai('gpt-5.4-nano'),
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
