import { execa } from 'execa';

import type { Connector } from './connector.ts';

interface ReleaseFetchOptions {
  /** Stop fetching when this tag is encountered (latest-first order). */
  untilTag?: string;
  /** Include the matching untilTag release (default true). */
  inclusive?: boolean;
  /** Include draft releases (default false). */
  includeDrafts?: boolean;
  /** Include prereleases (default false). */
  includePrerelease?: boolean;
}

function fs(path: string) {
  const [owner, repo, ...filePath] = path.split('/');
  return {
    readFile: async () => {
      const url = `https://api.github.com/repos/${owner}/${repo}/contents/${filePath.join('/')}`;
      const res = await fetch(url);
      const data = (await res.json()) as { content: string };
      return atob(data.content);
    },
    release: async (repo: string, opts: ReleaseFetchOptions = {}) => {
      const [owner, repoName] = repo.split('/');
      const perPage = 100; // always fetch max per page for efficiency
      const maxPages = 10; // internal safety cap, not user configurable
      const releases: Array<{
        tag_name: string;
        name: string | null;
        body: string | null;
        updated_at: string;
        published_at: string;
        html_url: string;
        draft: boolean;
        prerelease: boolean;
      }> = [];
      let stop = false;

      for (let page = 1; page <= maxPages && !stop; page++) {
        const url = `https://api.github.com/repos/${owner}/${repoName}/releases?per_page=${perPage}&page=${page}`;
        const res = await fetch(url, {
          headers: { Accept: 'application/vnd.github+json' },
        });
        if (!res.ok) break;
        const pageData = (await res.json()) as typeof releases;
        if (!pageData.length) break;
        for (const rel of pageData) {
          if (!opts.includeDrafts && rel.draft) continue;
          if (!opts.includePrerelease && rel.prerelease) continue;

          releases.push(rel);
          if (opts.untilTag && rel.tag_name === opts.untilTag) {
            if (opts.inclusive === false) {
              releases.pop();
            }
            stop = true;
            break;
          }
        }
      }
      return releases;
    },
  };
}

export const github = {
  file(filePath: string): Connector {
    const sourceId = `github:file:${filePath}`;
    const documentId = filePath;
    return {
      sourceId,
      sources: async function* () {
        const { readFile } = fs(filePath);
        yield {
          id: documentId,
          content: () => readFile(),
        };
      },
    };
  },
  /**
   * Create a connector over GitHub Releases with optional pagination & early-stop.
   * @param repo owner/repo string
   * @param options Release filtering & pagination controls
   */
  release: (repo: string, options: ReleaseFetchOptions = {}): Connector => {
    const sourceId = `github:releases:${repo}`;
    return {
      sourceId,
      sources: async function* () {
        const releases = await fs(repo).release(repo, options);
        for (const rel of releases) {
          yield {
            id: `${repo}:release:${rel.tag_name}`,
            content: async () => {
              const name = rel.name || rel.tag_name;
              const body = rel.body || '';
              return `Release: ${name}\nTag: ${rel.tag_name}\nPublished at: ${rel.published_at}\nUpdated at: ${rel.updated_at}\nURL: ${rel.html_url}\nDraft: ${rel.draft}\nPrerelease: ${rel.prerelease}\n\n${body}`;
            },
          };
        }
      },
    };
  },
  /**
   * Create a connector over a GitHub repository file tree using gitingest to produce a markdown digest.
   * @param repoUrl full https://github.com/OWNER/REPO or .../tree/BRANCH/subdir URL
   */
  repo: (
    repoUrl: string,
    opts: {
      includes: string[];
      excludes?: string[];
      branch?: string;
      includeGitignored?: boolean;
      includeSubmodules?: boolean;
      githubToken?: string;
      ingestWhen?: 'never' | 'contentChanged';
    },
  ): Connector => {
    const sourceId = `github:repo:${repoUrl}`;
    const {
      excludes = [
        '**/node_modules/**',
        '**/dist/**',
        '**/coverage/**',
        '**/*.test.ts',
        '**/*.test.tsx',
        '**/dist/**',
        '**/.git/**',
        '**/.github/**',
        '**/.vscode/**',
        '**/.idea/**',
        '**/build/**',
        '**/out/**',
        '**/vendor/**',
        '**/__tests__/**',
        '**/*.d.ts',
      ],
      branch,
      includeGitignored = false,
      includeSubmodules = false,
      githubToken,
      ingestWhen,
      includes,
    } = opts;

    async function gitingestDigest(): Promise<string> {
      const args = [
        'gitingest',
        ...(branch ? ['-b', branch] : []),
        ...includes.flatMap((p) => ['-i', p]),
        ...excludes.flatMap((p) => ['-e', p]),
        ...(includeGitignored ? ['--include-gitignored'] : []),
        ...(includeSubmodules ? ['--include-submodules'] : []),
        repoUrl,
        '-o',
        '-',
      ];
      const { stdout } = await execa('uvx', args, {
        env: githubToken
          ? { ...process.env, GITHUB_TOKEN: githubToken }
          : process.env,
        stdout: 'pipe',
        stderr: 'inherit',
      });
      return stdout;
    }

    return {
      sourceId,
      ingestWhen,
      sources: async function* () {
        const content = await gitingestDigest();
        yield {
          id: 'digest.md',
          content: async () => content,
        };
      },
    };
  },
};
