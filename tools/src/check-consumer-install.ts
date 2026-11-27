import { TemporaryFiles } from '@zukhruf/fs';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

interface Lockfile {
  packages: Record<string, { version: string }>;
}

interface Manifest {
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

const SINGLE_COPY_PACKAGES = ['ai', 'react'];

const publicProjects: string[] = JSON.parse(
  execFileSync(
    'npx',
    ['nx', 'show', 'projects', '--projects=tag:npm:public', '--json'],
    { encoding: 'utf8' },
  ),
);

await using consumer = await new TemporaryFiles().directory(
  'deepagents-consumer-',
);

/**
 * Packs into the consumer and maps each package name to its `file:` tarball.
 * The path is absolute: npm reads a relative one from the dependent package's
 * folder for a peer edge, and retries it as a corrupted tarball.
 */
function pack(targets: string[]): Record<string, string> {
  const packed: Record<string, { filename: string }> = JSON.parse(
    execFileSync(
      'npm',
      [
        'pack',
        ...targets,
        '--ignore-scripts',
        '--json',
        `--pack-destination=${consumer.path}`,
      ],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    ),
  );
  return Object.fromEntries(
    Object.entries(packed).map(([name, { filename }]) => [
      name,
      `file:${join(consumer.path, filename)}`,
    ]),
  );
}

async function installedManifest(name: string): Promise<Manifest> {
  return JSON.parse(
    await readFile(join('node_modules', name, 'package.json'), 'utf8'),
  );
}

/**
 * Packs every @zukhruf/* package the install reaches from `roots`, as the
 * root lockfile installed it, so the consumer never asks a registry for one
 * (#6221): a fresh @zukhruf release names sibling ranges the registry may not
 * serve yet. Copied from react-genai's packed-install test (#6163); the
 * ledger is tools/docs/copied-from-react-genai.md.
 */
async function packZukhrufClosure(roots: string[]) {
  const closure = new Set<string>();
  const pending = [...roots];
  for (let name = pending.pop(); name; name = pending.pop()) {
    const manifest = await installedManifest(name);
    for (const dependency of Object.keys({
      ...manifest.dependencies,
      ...manifest.peerDependencies,
      ...manifest.optionalDependencies,
    })) {
      if (dependency.startsWith('@zukhruf/') && !closure.has(dependency)) {
        closure.add(dependency);
        pending.push(dependency);
      }
    }
  }
  return pack([...closure].map((name) => resolve('node_modules', name)));
}

const tarballs = pack(
  publicProjects.map((project) => `--workspace=${project}`),
);
const zukhruf = await packZukhrufClosure(publicProjects);

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
    overrides: { ...tarballs, ...zukhruf },
  }),
);
// Port 9 refuses, so a registry request for a @zukhruf package fails the
// install instead of resolving a release the registry may not serve yet.
await writeFile(
  join(consumer.path, '.npmrc'),
  '@zukhruf:registry=http://127.0.0.1:9/\n',
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
