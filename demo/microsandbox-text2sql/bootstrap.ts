import { Image } from 'microsandbox';
import spawn from 'nano-spawn';
import { mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { demoImage } from './image.ts';

// Builds the shared text2sql-daemon image with Docker and loads it into the
// local microsandbox image cache. Run once (and after daemon/Dockerfile
// changes) before `node demo-microsandbox.ts`:
//
//   node demo/microsandbox-text2sql/bootstrap.ts
//
// Buildx emits an OCI archive that the SDK imports directly. The image must
// match the host architecture (microVMs run the host arch), so override
// DEEPAGENTS_DEMO_PLATFORM on non-Apple-silicon hosts.

const repoRoot = resolve(import.meta.dirname, '..', '..');
const dockerfile = resolve(repoRoot, 'demo', 'text2sql-daemon', 'Dockerfile');
const platform = process.env.DEEPAGENTS_DEMO_PLATFORM ?? 'linux/arm64';

async function run(command: string, args: string[]): Promise<void> {
  console.log(`\n$ ${command} ${args.join(' ')}`);
  const subprocess = spawn(command, args, { cwd: repoRoot });
  for await (const line of subprocess) {
    console.log(line);
  }
  await subprocess;
}

await using archiveDirectory = await mkdtempDisposable(
  join(tmpdir(), 'deepagents-msb-image-'),
);
const archive = join(archiveDirectory.path, 'image.tar');

await run('docker', [
  'buildx',
  'build',
  '--platform',
  platform,
  '-f',
  dockerfile,
  '-t',
  demoImage,
  '--output',
  `type=oci,dest=${archive}`,
  repoRoot,
]);

await Image.load(archive, { tag: demoImage });

console.log(
  `\n[bootstrap] loaded ${demoImage} (${platform}) into the microsandbox image cache`,
);
