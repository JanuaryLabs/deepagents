import { execFileSync } from 'node:child_process';
import { mkdtempDisposable, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface Lockfile {
  packages: Record<string, { version: string }>;
}

const SINGLE_COPY_PACKAGES = ['ai', 'react'];

const publicProjects: string[] = JSON.parse(
  execFileSync(
    'npx',
    ['nx', 'show', 'projects', '--projects=tag:npm:public', '--json'],
    { encoding: 'utf8' },
  ),
);

await using consumer = await mkdtempDisposable(
  join(tmpdir(), 'deepagents-consumer-'),
);

const packedPackages: Record<string, { filename: string }> = JSON.parse(
  execFileSync(
    'npm',
    [
      'pack',
      ...publicProjects.map((project) => `--workspace=${project}`),
      '--ignore-scripts',
      '--json',
      `--pack-destination=${consumer.path}`,
    ],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  ),
);

const tarballs = Object.fromEntries(
  Object.entries(packedPackages).map(([name, { filename }]) => [
    name,
    `file:./${filename}`,
  ]),
);

await writeFile(
  join(consumer.path, 'package.json'),
  JSON.stringify({
    name: 'deepagents-consumer',
    private: true,
    dependencies: {
      ...tarballs,
      ...Object.fromEntries(
        SINGLE_COPY_PACKAGES.map((name) => [name, 'latest']),
      ),
    },
    overrides: tarballs,
  }),
);

// The repo's .npmrc sets legacy-peer-deps=true, which hides ERESOLVE. A failed
// install throws here, and npm has printed the conflict.
execFileSync(
  'npm',
  [
    'install',
    '--package-lock-only',
    '--ignore-scripts',
    '--legacy-peer-deps=false',
    '--no-audit',
    '--no-fund',
  ],
  { cwd: consumer.path, stdio: 'inherit' },
);

const { packages }: Lockfile = JSON.parse(
  await readFile(join(consumer.path, 'package-lock.json'), 'utf8'),
);

const duplicates = SINGLE_COPY_PACKAGES.flatMap((name) => {
  const copies = Object.entries(packages).filter(
    ([path]) =>
      path === `node_modules/${name}` || path.endsWith(`/node_modules/${name}`),
  );
  return copies.length > 1 ? copies : [];
});

if (duplicates.length > 0) {
  console.error(
    'A consumer of the packed packages gets more than one copy of:',
  );
  for (const [path, { version }] of duplicates) {
    console.error(`  ${path} ${version}`);
  }
  process.exitCode = 1;
} else {
  console.log(
    `${publicProjects.length} packed packages resolve with one copy each of ${SINGLE_COPY_PACKAGES.join(' and ')}`,
  );
}
