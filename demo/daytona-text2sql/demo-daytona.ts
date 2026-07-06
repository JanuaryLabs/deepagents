import { openai } from '@ai-sdk/openai';
import { Daytona } from '@daytona/sdk';

import { input, printer } from '@deepagents/agent';
import {
  agent,
  chat,
  createBashTool,
  createDaytonaSandbox,
  errorRecoveryGuardrail,
  user,
  withStraceFileChanges,
} from '@deepagents/context';
import {
  daemonPort,
  daemonUrl,
  demoWorkspace,
  startDaemon,
  text2SqlOutDir,
} from '@deepagents/demo-text2sql-daemon/host';

import context, { defaultFragments, index } from './demo-context.ts';
import { runnerImage } from './image.ts';

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
  // Daytona boots the sandbox with its own init rather than the image CMD, so
  // the daemon must be started explicitly; the factory returns only once it's
  // ready.
  readiness: startDaemon,
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

// Per-tool-call filesystem-change tracking is composed onto the backend via
// strace. Requires the runner image to bake in strace — re-run bootstrap.ts
// after the Dockerfile change.
const tracked = await withStraceFileChanges(backend, {
  include: [demoWorkspace, `${demoWorkspace}/**`],
  onFileChanges: (changes) => {
    for (const c of changes) {
      console.log(
        `[files] ${c.op} ${c.path}${c.from ? ` (from ${c.from})` : ''}`,
      );
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
