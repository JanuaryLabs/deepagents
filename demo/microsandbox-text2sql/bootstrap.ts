import spawn from 'nano-spawn';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { demoImage } from './image.ts';

// Builds the shared text2sql-daemon image with Docker and loads it into the
// local microsandbox image cache. Run once (and after daemon/Dockerfile
// changes) before `node demo-microsandbox.ts`:
//
//   node demo/microsandbox-text2sql/bootstrap.ts
//
// microsandbox has no Dockerfile build of its own — it boots OCI images. The
// bridge is `docker save` -> `msb image load`, which accepts a Docker/OCI
// archive. The image must match the host architecture (microVMs run the host
// arch), so the build pins --platform; override via DEEPAGENTS_DEMO_PLATFORM
// (e.g. linux/amd64) on non-Apple-silicon hosts. Unlike the Daytona
// bootstrap, no --provenance/--sbom stripping is needed: msb's loader picks
// the platform manifest and ignores attestation entries (verified against
// 0.6.4 with the containerd image store, where attestations survive save).

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const dockerfile = resolve(here, '..', 'text2sql-daemon', 'Dockerfile');

const platform = process.env.DEEPAGENTS_DEMO_PLATFORM ?? 'linux/arm64';

async function run(command: string, args: string[]): Promise<void> {
  console.log(`\n$ ${command} ${args.join(' ')}`);
  const subprocess = spawn(command, args, { cwd: repoRoot });
  for await (const line of subprocess) {
    console.log(line);
  }
  await subprocess;
}

await run('docker', [
  'buildx',
  'build',
  '--platform',
  platform,
  '--load',
  '-f',
  dockerfile,
  '-t',
  demoImage,
  repoRoot,
]);

const archiveDir = await mkdtemp(join(tmpdir(), 'deepagents-msb-image-'));
const archive = join(archiveDir, 'image.tar');
try {
  await run('docker', ['save', demoImage, '-o', archive]);
  await run('msb', ['image', 'load', '--input', archive]);
} finally {
  await rm(archiveDir, { recursive: true, force: true });
}

console.log(
  `\n[bootstrap] loaded ${demoImage} (${platform}) into the microsandbox image cache`,
);
