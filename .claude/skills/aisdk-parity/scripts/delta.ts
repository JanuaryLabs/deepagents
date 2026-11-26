// Prints what the AI SDK and the vercel / vercel-labs orgs shipped since the
// AI SDK parity ledger was last checked (docs/aisdk-parity.md), from the
// published npm tarballs and the GitHub API, and the ledger rows whose cited
// files no longer exist. --write records the live state as the new baseline in
// docs/aisdk-parity.snapshot.json.
//
// Usage, from the repo root: node .claude/skills/aisdk-parity/scripts/delta.ts [--write]
import { Semaphore } from '@zukhruf/async';
import { TemporaryFiles, isErrno } from '@zukhruf/fs';
import { execFile } from 'node:child_process';
import { glob, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import ts from 'typescript';

const ORGS = ['vercel', 'vercel-labs'] as const;
type Org = (typeof ORGS)[number];

interface Snapshot {
  checkedAt: string;
  /** npm packages outside vercel/ai that the ledger follows, such as eve or just-bash. */
  watch: string[];
  versions: Record<string, string>;
  repos: Record<Org, string[]>;
}

interface Manifest {
  name: string;
  version: string;
  description?: string;
  dist: { tarball: string };
  exports?: unknown;
  types?: string;
  repository?: string | { url: string; directory?: string };
}

interface Repo {
  name: string;
  description: string | null;
  stargazers_count: number;
  created_at: string;
}

interface Release {
  version: string;
  entries: string[];
}

const repoRoot = new URL('../../../../', import.meta.url);
const snapshotFile = new URL('docs/aisdk-parity.snapshot.json', repoRoot);
const ledgerFile = new URL('docs/aisdk-parity.md', repoRoot);
const packagesDirectory = fileURLToPath(new URL('packages/', repoRoot));
const run = promisify(execFile);
const network = new Semaphore(12);
const temporaryFiles = new TemporaryFiles();

async function gh(args: string[]): Promise<string> {
  const { stdout } = await run('gh', ['api', ...args], {
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
}

/** The npm names of the public packages under vercel/ai `packages/` on main. */
async function aiSdkPackages(): Promise<string[]> {
  const directories: string[] = JSON.parse(
    await gh([
      'repos/vercel/ai/contents/packages?ref=main',
      '--jq',
      '[.[] | select(.type == "dir") | .name]',
    ]),
  );
  const blobs = directories.map(
    (directory, index) =>
      `p${index}: object(expression: "main:packages/${directory}/package.json") { ... on Blob { text } }`,
  );
  const response: {
    data: { repository: Record<string, { text: string } | null> };
  } = JSON.parse(
    await gh([
      'graphql',
      '-f',
      `query=query { repository(owner: "vercel", name: "ai") { ${blobs.join(' ')} } }`,
    ]),
  );
  return Object.values(response.data.repository).flatMap((blob) => {
    if (!blob) return [];
    const pkg: { name: string; private?: boolean } = JSON.parse(blob.text);
    return pkg.private ? [] : [pkg.name];
  });
}

async function orgRepos(org: Org): Promise<Repo[]> {
  const lines = await gh([
    '--paginate',
    `orgs/${org}/repos?per_page=100&type=public`,
    '--jq',
    '.[] | select(.archived | not) | {name, description, stargazers_count, created_at}',
  ]);
  return lines
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/** A version's manifest, or undefined when npm has no such package yet. */
async function manifest(
  name: string,
  version: string,
): Promise<Manifest | undefined> {
  using _permit = await network.acquire({ signal: undefined });
  const response = await fetch(
    `https://registry.npmjs.org/${name.replace('/', '%2f')}/${version}`,
  );
  if (response.status === 404) return undefined;
  if (!response.ok) {
    throw new Error(
      `npm registry answered ${response.status} for ${name}@${version}`,
    );
  }
  const body: Manifest = JSON.parse(await response.text());
  return body;
}

async function unpack(tarball: string, into: string): Promise<string> {
  using _permit = await network.acquire({ signal: undefined });
  const response = await fetch(tarball);
  if (!response.ok) {
    throw new Error(`${tarball} answered ${response.status}`);
  }
  const file = join(into, 'package.tgz');
  await writeFile(file, Buffer.from(await response.arrayBuffer()));
  await run('tar', ['-xzf', file, '-C', into]);
  return join(into, 'package');
}

function typesOf(target: unknown): string | undefined {
  if (typeof target === 'string') {
    return /\.d\.[cm]?ts$/.test(target) ? target : undefined;
  }
  if (typeof target !== 'object' || target === null) return undefined;
  const conditions = new Map(Object.entries(target));
  for (const condition of ['types', 'import', 'default', 'node', 'require']) {
    const found = typesOf(conditions.get(condition));
    if (found) return found;
  }
  return undefined;
}

/** Each export subpath of the package and the declaration file that types it. */
function entryPoints(pkg: Manifest): Map<string, string> {
  const entries = new Map<string, string>();
  const exports = pkg.exports;
  if (typeof exports === 'object' && exports !== null) {
    for (const [subpath, target] of Object.entries(exports)) {
      const types = typesOf(target);
      if (subpath.startsWith('.') && !subpath.includes('*') && types) {
        entries.set(subpath, types);
      }
    }
  } else if (pkg.types) {
    entries.set('.', pkg.types);
  }
  return entries;
}

function exportNames(declarationFile: string): Set<string> {
  const program = ts.createProgram([declarationFile], {
    noEmit: true,
    noLib: true,
    skipLibCheck: true,
    types: [],
  });
  const source = program.getSourceFile(declarationFile);
  const checker = program.getTypeChecker();
  const module = source && checker.getSymbolAtLocation(source);
  return new Set(
    module
      ? checker.getExportsOfModule(module).map((symbol) => symbol.name)
      : [],
  );
}

function surface(directory: string, pkg: Manifest): Map<string, Set<string>> {
  return new Map(
    [...entryPoints(pkg)].map(([subpath, file]) => [
      subpath,
      exportNames(join(directory, file)),
    ]),
  );
}

function surfaceChanges(
  before: Map<string, Set<string>>,
  after: Map<string, Set<string>>,
): string[] {
  const lines: string[] = [];
  for (const subpath of new Set([...before.keys(), ...after.keys()])) {
    const old = before.get(subpath);
    const next = after.get(subpath);
    if (!old) {
      lines.push(`- new entry point \`${subpath}\` (${next?.size} exports)`);
    } else if (!next) {
      lines.push(`- entry point \`${subpath}\` removed`);
    } else {
      const added = [...next.difference(old)];
      const removed = [...old.difference(next)];
      if (added.length) {
        lines.push(
          `- \`${subpath}\` adds ${added.map((n) => `\`${n}\``).join(', ')}`,
        );
      }
      if (removed.length) {
        lines.push(
          `- \`${subpath}\` removes ${removed.map((n) => `\`${n}\``).join(', ')}`,
        );
      }
    }
  }
  return lines;
}

/**
 * The CHANGELOG.md releases after `from` up to and including `to`, without
 * changesets' "Updated dependencies" entries. Changesets writes the newest
 * release first, so the range is the lines between the two headers; undefined
 * when `from` has no header.
 */
function releaseNotes(
  changelog: string,
  from: string,
  to: string,
): Release[] | undefined {
  const releases: Release[] = [];
  let inRange = false;
  for (const line of changelog.split('\n')) {
    const header = /^## (\S+)/.exec(line);
    if (header) {
      if (header[1] === from) {
        return releases
          .map((release) => ({
            ...release,
            entries: release.entries.filter(
              (entry) =>
                !entry.startsWith('Updated dependencies') &&
                !/^(@[\w.-]+\/)?[\w.-]+@\S+$/.test(entry),
            ),
          }))
          .filter((release) => release.entries.length);
      }
      inRange ||= header[1] === to;
      if (inRange) releases.push({ version: header[1], entries: [] });
      continue;
    }
    const entries = releases.at(-1)?.entries;
    if (!inRange || !entries) continue;
    if (line.startsWith('- ')) entries.push(line.slice(2));
    else if (/^\s+\S/.test(line) && entries.length) {
      entries[entries.length - 1] += `\n${line}`;
    }
  }
  return undefined;
}

/** The tarball's CHANGELOG.md, else the one beside the package's source on GitHub. */
async function readChangelog(
  directory: string,
  pkg: Manifest,
): Promise<string | undefined> {
  try {
    return await readFile(join(directory, 'CHANGELOG.md'), 'utf8');
  } catch (error) {
    if (!isErrno(error, 'ENOENT')) throw error;
  }
  const repository =
    typeof pkg.repository === 'string'
      ? { url: pkg.repository }
      : pkg.repository;
  const github =
    repository && /github\.com[/:]([^/]+)\/([^/.#]+)/.exec(repository.url);
  if (!repository || !github) return undefined;
  const path = [repository.directory, 'CHANGELOG.md'].filter(Boolean).join('/');
  try {
    return await gh([
      `repos/${github[1]}/${github[2]}/contents/${path}`,
      '-H',
      'Accept: application/vnd.github.raw',
    ]);
  } catch (error) {
    if (
      Error.isError(error) &&
      'stderr' in error &&
      String(error.stderr).includes('HTTP 404')
    ) {
      return undefined;
    }
    throw error;
  }
}

function releaseSection(
  changelog: string | undefined,
  releases: Release[] | undefined,
  fromVersion: string,
): string[] {
  if (changelog === undefined) {
    return [
      'No CHANGELOG.md in the tarball or beside its source: read the releases.',
    ];
  }
  if (releases === undefined) {
    return [`CHANGELOG.md has no \`## ${fromVersion}\` header.`];
  }
  return releases.flatMap((release) => [
    `#### ${release.version}`,
    '',
    ...release.entries.map((entry) => `- ${entry}`),
    '',
  ]);
}

/** The section of the report for one package whose version moved. */
async function packageDelta(
  name: string,
  from: Manifest,
  to: Manifest,
): Promise<string | undefined> {
  await using before = await temporaryFiles.directory('aisdk-delta-');
  await using after = await temporaryFiles.directory('aisdk-delta-');
  const [old, next] = await Promise.all([
    unpack(from.dist.tarball, before.path),
    unpack(to.dist.tarball, after.path),
  ]);
  const changelog = await readChangelog(next, to);
  const releases =
    changelog === undefined
      ? undefined
      : releaseNotes(changelog, from.version, to.version);
  const api = surfaceChanges(surface(old, from), surface(next, to));
  if (releases?.length === 0 && api.length === 0) return undefined;
  const notes = releaseSection(changelog, releases, from.version);
  return [
    `### ${name} ${from.version} → ${to.version}`,
    '',
    ...(api.length ? ['Export changes:', '', ...api, ''] : []),
    ...notes,
  ].join('\n');
}

const snapshot: Snapshot = JSON.parse(await readFile(snapshotFile, 'utf8'));
const [aiSdk, vercelRepos, labsRepos] = await Promise.all([
  aiSdkPackages(),
  orgRepos('vercel'),
  orgRepos('vercel-labs'),
]);
const repos: Record<Org, Repo[]> = {
  vercel: vercelRepos,
  'vercel-labs': labsRepos,
};
const names = [...new Set([...aiSdk, ...snapshot.watch])].sort();
const latest = new Map(
  await Promise.all(
    names.map(async (name) => [name, await manifest(name, 'latest')] as const),
  ),
);

const moved = names.filter((name) => {
  const recorded = snapshot.versions[name];
  const current = latest.get(name);
  return recorded && current && current.version !== recorded;
});
const deltas = await Promise.all(
  moved.map(async (name) => {
    const from = await manifest(name, snapshot.versions[name] ?? '');
    const to = latest.get(name);
    if (!from || !to) {
      throw new Error(`${name}: the recorded or latest version is not on npm`);
    }
    return [name, await packageDelta(name, from, to)] as const;
  }),
);

const changed = deltas.flatMap(([, delta]) => (delta ? [delta] : []));
const dependencyOnly = deltas
  .filter(([, delta]) => !delta)
  .map(([name]) => name);
const report = [
  `# Upstream delta since ${snapshot.checkedAt}`,
  '',
  `${moved.length} of ${names.length} followed packages moved; ${changed.length} changed more than their dependencies.`,
  '',
];
if (moved.length) {
  report.push(
    '## Changed packages',
    '',
    ...changed.flatMap((delta) => [delta, '']),
  );
}
if (dependencyOnly.length) {
  report.push(`Dependency updates only: ${dependencyOnly.join(', ')}`, '');
}

const added = names.filter((name) => !snapshot.versions[name]);
if (added.length) {
  report.push('## New packages', '');
  for (const name of added) {
    const pkg = latest.get(name);
    report.push(
      pkg
        ? `- ${name}@${pkg.version}${pkg.description ? `: ${pkg.description}` : ''}`
        : `- ${name}: not published to npm yet`,
    );
  }
  report.push('');
}
const gone = Object.keys(snapshot.versions).filter(
  (name) => !names.includes(name),
);
if (gone.length)
  report.push(
    '## Packages no longer followed',
    '',
    ...gone.map((name) => `- ${name}`),
    '',
  );

for (const org of ORGS) {
  const known = new Set(snapshot.repos[org]);
  const live = repos[org];
  const fresh = live.filter((repo) => !known.has(repo.name));
  const removed = [...known.difference(new Set(live.map((repo) => repo.name)))];
  if (fresh.length) {
    report.push(`## New ${org} repositories`, '');
    for (const repo of fresh.toSorted(
      (a, b) => b.stargazers_count - a.stargazers_count,
    )) {
      report.push(
        `- [${org}/${repo.name}](https://github.com/${org}/${repo.name}) ★${repo.stargazers_count}, created ${repo.created_at.slice(0, 10)}: ${repo.description ?? ''}`,
      );
    }
    report.push('');
  }
  if (removed.length) {
    report.push(
      `## Archived or deleted ${org} repositories`,
      '',
      ...removed.map((name) => `- ${name}`),
      '',
    );
  }
}

/**
 * Each ledger row's `Ours` citation of a file under packages/ that no longer
 * exists. Only paths that start with a package directory count: a bare file
 * name after a full path ("…/filesystem.ts:12; container.ts:7") has no
 * directory of its own.
 */
async function staleCitations(): Promise<string[]> {
  const roots = (await readdir(packagesDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  const citation = new RegExp(
    String.raw`(?:^|[\s;(])((?:${roots.join('|')})/[\w./*@-]+)`,
    'g',
  );
  const stale: string[] = [];
  for (const line of (await readFile(ledgerFile, 'utf8')).split('\n')) {
    const id = /^\| ([A-Z]\d+) \| /.exec(line)?.[1];
    const ours = line.split(/(?<!\\) \| /)[3];
    if (!id || !ours) continue;
    for (const [, cited = ''] of ours.replaceAll('`', '').matchAll(citation)) {
      const path = cited.replace(/[.,]+$/, '');
      const found = await Array.fromAsync(
        glob(path, { cwd: packagesDirectory }),
      );
      if (!found.length) stale.push(`- ${id}: \`${path}\``);
    }
  }
  return stale;
}

const stale = await staleCitations();
if (stale.length) {
  report.push('## Ledger rows citing missing files', '', ...stale, '');
}

console.log(report.join('\n'));

if (process.argv.includes('--write')) {
  const next: Snapshot = {
    checkedAt: new Date().toISOString().slice(0, 10),
    watch: snapshot.watch.toSorted(),
    versions: Object.fromEntries(
      names.flatMap((name) => {
        const version = latest.get(name)?.version;
        return version ? [[name, version]] : [];
      }),
    ),
    repos: {
      vercel: vercelRepos.map((repo) => repo.name).toSorted(),
      'vercel-labs': labsRepos.map((repo) => repo.name).toSorted(),
    },
  };
  await writeFile(snapshotFile, `${JSON.stringify(next, null, 2)}\n`);
}
