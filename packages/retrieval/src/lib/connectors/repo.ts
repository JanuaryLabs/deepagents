import { opendir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import fg from 'fast-glob';

import type { Connector } from './connector.js';

export function repo(
  dir: string,
  extensions: string[],
  ingestWhen: Connector['ingestWhen'],
): Connector {
  const sourceId = `repo:${dir}`;
  return {
    sourceId,
    ingestWhen,
    sources: async function* () {
      const paths = await collectFiles(dir, extensions);
      for await (const path of paths) {
        const maxSize = 3 * 1024; // 3KB
        const st = await stat(path);
        if (st.size > maxSize) {
          continue;
        }
        yield {
          id: path,
          metadata: { repo: dir },
          content: () => readFile(path, 'utf8').catch(() => ''),
        };
      }
    },
  };
}

export async function* findAllGitRepos(root: string) {
  const stack = [root];
  const skip = [
    'node_modules',
    'Library',
    'Applications',
    'Pictures',
    'Movies',
    'Music',
    'Downloads',
    '.cache',
    '.npm',
    '.pnpm',
    'development',
  ];
  while (stack.length) {
    const folder = stack.pop()!;
    const isGitRepo = await stat(join(folder, '.git'))
      .then((st) => st.isDirectory() || st.isFile())
      .catch(() => false);
    if (isGitRepo) {
      yield folder;
      continue;
    }
    const dir = await opendir(folder);
    for await (const dirent of dir) {
      if (
        dirent.isDirectory() &&
        !dirent.isSymbolicLink() &&
        !skip.includes(dirent.name) &&
        !dirent.name.startsWith('.')
      ) {
        stack.push(join(folder, dirent.name));
      }
    }
  }
}

function detectRepoTooling(repo: string) {
  const tools: string[] = [];
  return tools;
}

async function gitignore(gitignoreFile: string) {
  const content = await readFile(gitignoreFile, 'utf8').catch(() => '');
  if (!content) {
    return [];
  }
  const patterns = content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  return patterns;
}

export async function collectFiles(
  repo: string,
  extensions: string[],
): Promise<AsyncIterable<string>> {
  const exts = extensions.map((ext) => ext.replace(/^\./, ''));
  return fg.stream(
    extensions.length > 1 ? `**/*.{${exts.join(',')}}` : `**/*.${exts[0]}`,
    {
      dot: false,
      onlyFiles: true,
      unique: true,
      absolute: true,
      cwd: repo,
      ignore: [
        // Inherit repo-specific ignore patterns
        ...(await gitignore(join(repo, '.gitignore'))),

        // Package managers & dependency dirs
        'node_modules/**',
        '**/node_modules/**',
        '**/.pnpm/**',
        '**/.npm/**',
        '**/.yarn/**',
        '**/vendor/**', // PHP / Go modules (when vendored)
        '**/3rdparty/**',

        // Version control + VCS metadata
        '**/.git/**',
        '**/.svn/**',
        '**/.hg/**',

        // OS / system junk
        '**/.DS_Store',
        '**/Thumbs.db',
        '**/Library/**',
        '**/Applications/**',
        '**/Pictures/**',
        '**/Movies/**',
        '**/Music/**',
        '**/Downloads/**',
        '**/.cache/**',

        // Environment / secrets (explicit)
        '**/.env',
        '**/.env.*',

        // Lockfiles & generated dependency state
        '**/*.lock',
        '**/yarn.lock',
        '**/package-lock.json',
        '**/pnpm-lock.yaml',

        // Build / compilation outputs
        '**/dist/**',
        '**/debug/**',
        '**/build/**',
        '**/out/**',
        '**/target/**', // Rust / JVM
        '**/bin/**',
        '**/obj/**',
        '**/classes/**',

        // Framework / tool specific build artifacts
        '**/.next/**',
        '**/.vercel/**',
        '**/.turbo/**',
        '**/.docusaurus/**',
        '**/.vite/**',
        '**/.parcel-cache/**',
        '**/.rollup.cache/**',
        '**/.vuepress/**',
        'cdk.out/**',

        // Infra & deployment tooling
        '**/.serverless/**',
        '**/.terraform/**',
        '**/.terragrunt-cache/**',
        '**/.pulumi/**',

        // Coverage & testing caches
        '**/coverage/**',
        '**/.nyc_output/**',
        '**/jest-cache/**',
        '**/.pytest_cache/**',

        // Language / tooling caches
        '**/__pycache__/**',
        '**/.mypy_cache/**',
        '**/.tox/**',
        '**/.gradle/**',
        '**/.mvn/**',
        '**/.eslintcache',
        '**/.stylelintcache',

        // IDE / editor configs + history (we don't want to embed these)
        '**/.idea/**',
        '**/.vscode/**',
        '**/.fleet/**',
        '**/.history/**',

        // Virtual environments
        '**/.venv/**',
        '**/venv/**',
      ],
    },
  ) as AsyncIterable<string>;
}
