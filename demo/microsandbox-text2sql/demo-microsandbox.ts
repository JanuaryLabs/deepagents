import { openai } from '@ai-sdk/openai';
import { Destination, Rule } from 'microsandbox';

import { input, printer } from '@deepagents/agent';
import {
  agent,
  chat,
  createBashTool,
  createMicrosandboxSandbox,
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
import { demoImage } from './image.ts';

// Postgres runs on the HOST. Inside the microVM the host is reachable via the
// guest's default-route gateway, so when no PGHOST was baked into the sandbox
// env the daemon resolves it from the routing table at spawn time.
const resolvePghostFromGateway = `export PGHOST="\${PGHOST:-$(ip route | awk '/default/ {print $3; exit}')}"`;

const backend = await createMicrosandboxSandbox({
  // Stable name → get-or-create: re-runs resume this one microVM (dispose()
  // stops it with rootfs state intact instead of removing it).
  name: 'deepagents-text2sql-demo',
  // Build + load this image first: `node demo/microsandbox-text2sql/bootstrap.ts`.
  image: demoImage,
  memory: 2048,
  env: {
    NODE_NO_WARNINGS: '1',
    TEXT2SQL_OUT_DIR: text2SqlOutDir,
    TEXT2SQL_DAEMON_URL: daemonUrl,
    PORT: String(daemonPort),
    PGPORT: process.env.PGPORT ?? '5432',
    PGUSER: process.env.PGUSER ?? 'postgres',
    PGPASSWORD: process.env.PGPASSWORD ?? 'postgres',
    // PGHOST is only baked when the caller pins one; otherwise startDaemon
    // resolves the host via the guest's default-route gateway.
    ...(process.env.PGHOST ? { PGHOST: process.env.PGHOST } : {}),
  },
  // microsandbox boots the microVM with its guest agent as PID 1 rather than
  // the image CMD, so the daemon must be started explicitly; the factory
  // returns only once it's ready and disposes the microVM if startup fails.
  readiness: (sandbox) =>
    startDaemon(sandbox, { prelude: resolvePghostFromGateway }),
  configure: (builder) =>
    builder
      // The image was loaded into the local cache by bootstrap.ts; a registry
      // pull of this name would fail confusingly, so forbid it outright.
      .pullPolicy('never')
      // Default egress is public-only, which blocks the host-side Postgres.
      // Extend it with the `host` destination group instead of allowing the
      // whole private range.
      .network((network) =>
        network.policy({
          defaultEgress: 'deny',
          defaultIngress: 'allow',
          rules: [
            Rule.allowDns(),
            Rule.allowEgress(Destination.group('public')),
            Rule.allowEgress(Destination.group('host')),
          ],
        }),
      ),
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
// strace (baked into the image; ptrace works inside the microVM's own kernel).
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
  name: 'text2sql-microsandbox',
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
