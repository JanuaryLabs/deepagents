import {
  createDockerSandbox,
  pkg,
  withStraceFileChanges,
} from '@deepagents/context';

import { report, timed } from './profile.ts';

const bucket = process.env.MINIO_BUCKET ?? 'agent-storage';

// The `agent-storage` rclone volume is created by `docker compose up` (its
// driver_opts carry the MinIO config); run.ts just attaches to it.
const sandbox = await timed('createDockerSandbox', () =>
  createDockerSandbox({
    name: `minio-demo`,
    image: 'alpine:latest',
    installers: [pkg(['strace'])],
    volumes: [
      {
        type: 'volume',
        name: 'agent-storage',
        containerPath: '/workspace/storage',
        readOnly: false,
        lifecycle: 'external',
      },
    ],
  }),
);

const tracked = await timed('withStraceFileChanges', () =>
  withStraceFileChanges(sandbox, {
    include: ['/workspace/storage', '/workspace/storage/**'],
    onFileChanges: (changes) => {
      for (const change of changes) {
        console.log(`[strace] ${change.op} ${change.path}`);
      }
    },
  }),
);

const name = `from-sandbox-${Date.now()}.txt`;
await timed('executeCommand (write)', () =>
  tracked.executeCommand(
    `echo 'written by the deepagents sandbox' > /workspace/storage/${name}`,
  ),
);

const readback = await timed('executeCommand (read)', () =>
  tracked.executeCommand(`cat /workspace/storage/${name}`),
);
console.log(`[run] readback: ${readback.stdout.trim()}`);
console.log(
  `[run] now an object in MinIO — open http://localhost:9001 -> "${bucket}" -> ${name}`,
);

report();
