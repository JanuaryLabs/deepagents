import spawn from 'nano-spawn';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { pushImage } from './image.ts';

// Builds the shared text2sql-daemon image and publishes it to the local
// self-hosted Daytona stack's registry. Run once (and after daemon/Dockerfile
// changes) before `node demo-daytona.ts`:
//
//   node demo/daytona-text2sql/bootstrap.ts
//
// WHY buildx with these exact flags (verified against the local Daytona stack):
// createDaytonaSandbox(client, { name, image }) does NOT pull the image
// directly. The Daytona SDK wraps a string image as a `FROM <image>` Dockerfile
// and runs a server-side buildkit BUILD_SNAPSHOT job. buildkit's `FROM`
// resolution rejects a multi-arch OCI index / attestation manifest ("no match
// for platform"), so the image must be a PLAIN single-arch manifest:
//   --provenance=false --sbom=false  -> no attestation manifest in the index
//   --platform linux/<arch>          -> single arch matching the runner host
//   pinned tag (NOT :latest)         -> Daytona rejects :latest for snapshots
//
// Precondition: the Daytona runner must be below its disk-availability cutoff,
// else the API logs "No available runners" and creates hang. If so, free space
// with `docker builder prune -af` on the host.
//
// PLATFORM must match the Daytona runner host architecture. This stack runs on
// Apple Silicon (aarch64), so linux/arm64. Override via DEEPAGENTS_DEMO_PLATFORM
// (e.g. linux/amd64) if your runner differs.

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
  '--provenance=false',
  '--sbom=false',
  '-f',
  dockerfile,
  '-t',
  pushImage,
  '--push',
  repoRoot,
]);

console.log(
  `\n[bootstrap] published ${pushImage} (${platform}, single-arch, no attestation)`,
);
