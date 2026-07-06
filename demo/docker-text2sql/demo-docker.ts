import { openai } from '@ai-sdk/openai';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { printer } from '@deepagents/agent';
import {
  BashException,
  agent,
  chat,
  createBashTool,
  createDockerSandbox,
  errorRecoveryGuardrail,
  user,
  withStraceFileChanges,
} from '@deepagents/context';
import {
  daemonPort,
  daemonUrl,
  demoWorkspace,
  text2SqlOutDir,
  waitForDaemonReady,
} from '@deepagents/demo-text2sql-daemon/host';

import context, { defaultFragments, index } from './demo-context.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..');
const dockerfile = resolve(here, '..', 'text2sql-daemon', 'Dockerfile');

const backend = await createDockerSandbox({
  name: 'text2sql-daemon',
  dockerfile,
  context: repo,
  // The image build (npm ci + nx build) takes minutes; stream it so the first
  // run shows progress instead of a blank screen.
  showBuildLogs: true,
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
  // The daemon runs as the container's main process (CMD), so only readiness
  // is waited for here — if it never becomes ready the container has usually
  // exited, most often because the external Postgres at PGHOST is
  // unreachable. The factory disposes the container when that wait fails.
  readiness: waitForDaemonReady,
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

class FileChangeError extends BashException {
  override format() {
    return {
      stdout: '',
      stderr: `You cannot do: ${this.message}. tell the user to elevate with IT`,
      exitCode: 1,
    };
  }
}

// Per-tool-call filesystem-change tracking is composed onto the backend via
// strace (baked into the image); onFileChanges fires after each command with
// that call's manifest. Here it's a tripwire that rejects any change. On a
// tool-call command the throw fails that bash call (throw a BashException
// instead to control the exact failed result the model sees); the command still
// ran. onError fires only for the spawn path, which has no tool result to fail.
const tracked = await withStraceFileChanges(backend, {
  include: [demoWorkspace, `${demoWorkspace}/**`],
  onFileChanges: (changes) => {
    for (const c of changes) {
      const change = `${c.op} ${c.path}${c.from ? ` (from ${c.from})` : ''}`;
      // Tripwire: reject writes into artifacts/, log every other change.
      if (c.path.includes('artifacts')) {
        throw new FileChangeError(`Unexpected file change: ${change}`);
      }
      console.warn(`Unexpected file change: ${change}`);
    }
  },
});
const sandbox = await createBashTool({
  sandbox: tracked,
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

const text =
  'List the top 5 longest films in pagila and store them in a file in artifacts folder.';

await context.continue(user(text));
const stream = await chat(demoAgent);
await printer.readableStream(stream);
