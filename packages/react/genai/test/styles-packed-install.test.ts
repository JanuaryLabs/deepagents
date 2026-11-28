// @vitest-environment node
import { TemporaryFiles } from '@zukhruf/fs';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'vitest';

const run = promisify(execFile);
const repoRoot = join(import.meta.dirname, '../../../..');

/**
 * Classes that only Streamdown's own dist names. A host's CSS lacks them unless
 * Tailwind scans that dist, and then a list's bullets hang outside the text
 * column (#6051). They live here, outside the host tree Tailwind scans.
 */
const STREAMDOWN_CLASSES = ['list-inside', '[li_&]:ps-6', '[&>p]:inline'];

/** An older Streamdown at the top of the host, so npm nests react-genai's own copy. */
const HOST_STREAMDOWN = '2.7.1';

/** The workspace packages a react-genai install pulls in, packed together as they ship. */
const PACKED_WORKSPACES = [
  '@deepagents/react-genai',
  '@deepagents/react-input',
  '@deepagents/react-formatters',
  '@deepagents/elements',
  '@deepagents/context',
  '@deepagents/agent',
];

/** The @zukhruf/* packages the host itself imports, as react-genai's README says. */
const HOST_ZUKHRUF = ['@zukhruf/shadcn', '@zukhruf/ui'];

async function installedManifest(name: string): Promise<{
  version: string;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}> {
  return JSON.parse(
    await readFile(
      join(repoRoot, 'node_modules', name, 'package.json'),
      'utf8',
    ),
  );
}

async function installedVersion(name: string): Promise<[string, string]> {
  return [name, (await installedManifest(name)).version];
}

/** Packs into `destination` and maps each package name to its `file:` tarball. */
async function pack(
  targets: string[],
  destination: string,
  signal: AbortSignal,
) {
  const { stdout } = await run(
    'npm',
    [
      'pack',
      ...targets,
      '--ignore-scripts',
      '--json',
      `--pack-destination=${destination}`,
    ],
    { cwd: repoRoot, signal, maxBuffer: 64 * 1024 * 1024 },
  );
  const packed: Record<string, { filename: string }> = JSON.parse(stdout);
  return Object.fromEntries(
    Object.entries(packed).map(([name, { filename }]) => [
      name,
      `file:${join(destination, filename)}`,
    ]),
  );
}

/**
 * Packs every @zukhruf/* package the install reaches from `roots`, as the
 * repo's lockfile installed it, so the host never asks a registry for one
 * (#6163): a fresh @zukhruf release names sibling ranges the registry may not
 * serve yet.
 */
async function packZukhrufClosure(
  roots: string[],
  destination: string,
  signal: AbortSignal,
) {
  const closure = new Set<string>(
    roots.filter((name) => name.startsWith('@zukhruf/')),
  );
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
  return pack(
    [...closure].map((name) => join(repoRoot, 'node_modules', name)),
    destination,
    signal,
  );
}

/**
 * Builds the CSS of a Vite host that installs the packed react-genai and
 * follows its README. Returns where react-genai's Streamdown was installed and
 * the Streamdown classes the CSS lacks.
 */
async function buildHostCss(
  hostDependencies: Record<string, string>,
  signal: AbortSignal,
) {
  const temporaryFiles = new TemporaryFiles();
  await using tarballs = await temporaryFiles.directory(
    'react-genai-tarballs-',
  );
  await using host = await temporaryFiles.directory('react-genai-host-');
  const workspaces = await pack(
    PACKED_WORKSPACES.map((name) => `--workspace=${name}`),
    tarballs.path,
    signal,
  );
  const zukhruf = await packZukhrufClosure(
    [...PACKED_WORKSPACES, ...HOST_ZUKHRUF],
    tarballs.path,
    signal,
  );

  await writeFile(
    join(host.path, 'package.json'),
    JSON.stringify({
      name: 'react-genai-host',
      private: true,
      type: 'module',
      dependencies: {
        ...workspaces,
        ...Object.fromEntries(
          HOST_ZUKHRUF.map((name) => [name, zukhruf[name]]),
        ),
        ...Object.fromEntries(
          await Promise.all(
            [
              '@tailwindcss/vite',
              'tailwindcss',
              'vite',
              'react',
              'react-dom',
            ].map(installedVersion),
          ),
        ),
        ...hostDependencies,
      },
      overrides: { ...workspaces, ...zukhruf },
    }),
  );
  // A @zukhruf/* package comes only from the repo's own install, never from a
  // registry that may not serve a fresh publish yet (#6163): port 9 refuses.
  await writeFile(
    join(host.path, '.npmrc'),
    '@zukhruf:registry=http://127.0.0.1:9/\n',
  );
  // Tailwind's source detection skips git-ignored paths, as in an installed host.
  await writeFile(join(host.path, '.gitignore'), 'node_modules\ndist\n');
  await run('git', ['init', '--quiet'], { cwd: host.path, signal });
  await writeFile(
    join(host.path, 'vite.config.js'),
    "import tailwindcss from '@tailwindcss/vite';\nexport default { plugins: [tailwindcss()] };\n",
  );
  await writeFile(
    join(host.path, 'index.html'),
    '<!doctype html><div id="root"></div><script type="module" src="/src/main.js"></script>\n',
  );
  await mkdir(join(host.path, 'src'));
  await writeFile(
    join(host.path, 'src/main.js'),
    [
      "import { Response } from '@deepagents/react-genai';",
      "import { createElement } from 'react';",
      "import { createRoot } from 'react-dom/client';",
      "import './styles.css';",
      "createRoot(document.getElementById('root')).render(createElement(Response, null, '- an item'));",
      '',
    ].join('\n'),
  );
  await writeFile(
    join(host.path, 'src/styles.css'),
    [
      "@import 'tailwindcss';",
      "@import '@zukhruf/shadcn/styles.css';",
      "@import '@zukhruf/ui/styles.css';",
      "@import '@deepagents/react-genai/styles.css';",
      '',
    ].join('\n'),
  );

  await run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: host.path,
    signal,
    maxBuffer: 64 * 1024 * 1024,
  });
  await run(
    process.execPath,
    [
      join(host.path, 'node_modules/vite/bin/vite.js'),
      'build',
      '--logLevel=error',
    ],
    { cwd: host.path, signal, maxBuffer: 64 * 1024 * 1024 },
  );

  const assets = join(host.path, 'dist/assets');
  const [stylesheet] = (await readdir(assets)).filter((file) =>
    file.endsWith('.css'),
  );
  const css = await readFile(join(assets, stylesheet), 'utf8');
  const { stdout: streamdownEntry } = await run(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      "console.log(import.meta.resolve('streamdown'))",
    ],
    { cwd: join(host.path, 'node_modules/@deepagents/react-genai'), signal },
  );
  return {
    streamdown: relative(
      host.path,
      dirname(dirname(fileURLToPath(streamdownEntry.trim()))),
    ),
    missing: STREAMDOWN_CLASSES.filter(
      (name) => !css.includes(`.${name.replaceAll(/[[\]&>:]/g, '\\$&')}`),
    ),
  };
}

test('a host that installs react-genai with Streamdown hoisted gets Streamdown classes', async ({
  signal,
}) => {
  assert.deepStrictEqual(await buildHostCss({}, signal), {
    streamdown: 'node_modules/streamdown',
    missing: [],
  });
}, 600_000);

test("a host whose own Streamdown nests react-genai's copy gets that copy's classes", async ({
  signal,
}) => {
  assert.deepStrictEqual(
    await buildHostCss({ streamdown: HOST_STREAMDOWN }, signal),
    {
      streamdown:
        'node_modules/@deepagents/react-genai/node_modules/streamdown',
      missing: [],
    },
  );
}, 600_000);
