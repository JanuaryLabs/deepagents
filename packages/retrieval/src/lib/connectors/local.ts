import { readFile, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';

import fg from 'fast-glob';
import ignore from 'ignore';

import type { Connector } from './connector.js';

/**
 * Cache for gitignore patterns to avoid repeated file reads
 */
const gitignoreCache = new Map<string, ReturnType<typeof ignore>>();

/**
 * Collect all .gitignore patterns from root directory up to target directory
 */
async function collectGitignorePatterns(
  targetPath: string,
): Promise<ReturnType<typeof ignore>> {
  const absolutePath = resolve(targetPath);

  if (gitignoreCache.has(absolutePath)) {
    return gitignoreCache.get(absolutePath)!;
  }

  const ig = ignore();

  // Find all .gitignore files from root to target directory
  const pathSegments = absolutePath.split('/');
  const gitignoreFiles: string[] = [];

  // Check each level from root to target
  for (let i = 1; i <= pathSegments.length; i++) {
    const currentPath = pathSegments.slice(0, i).join('/');
    const gitignorePath = join(currentPath, '.gitignore');

    try {
      await stat(gitignorePath);
      gitignoreFiles.push(gitignorePath);
    } catch {
      // .gitignore doesn't exist at this level, continue
    }
  }

  // Read and add patterns from all .gitignore files
  for (const gitignoreFile of gitignoreFiles) {
    try {
      const content = await readFile(gitignoreFile, 'utf8');
      const patterns = content
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#'));

      ig.add(patterns);
    } catch {
      // Skip if can't read gitignore file
    }
  }

  gitignoreCache.set(absolutePath, ig);
  return ig;
}

/**
 * Get all files matching the pattern while respecting .gitignore files
 */
async function getFilteredFiles(
  cwd: string,
  pattern: string,
): Promise<string[]> {
  // Get all files matching the pattern without gitignore filtering first
  const allFiles = await fg(pattern, {
    dot: false,
    absolute: true,
    onlyFiles: true,
    cwd: cwd,
    followSymbolicLinks: false,
    ignore: [
      '**/node_modules/**',
      '**/.git/**',
      '**/.DS_Store',
      '**/Thumbs.db',
      '**/*.tmp',
      '**/*.temp',
      '**/coverage/**',
      '**/dist/**',
      '**/build/**',
    ],
  });

  if (allFiles.length === 0) {
    return [];
  }

  // Group files by their directory to optimize gitignore pattern collection
  const filesByDir = new Map<string, string[]>();

  for (const file of allFiles) {
    const dir = dirname(file);
    if (!filesByDir.has(dir)) {
      filesByDir.set(dir, []);
    }
    filesByDir.get(dir)!.push(file);
  }

  const filteredFiles: string[] = [];

  // Process each directory and filter files
  for (const [dir, files] of filesByDir) {
    const ignoreFilter = await collectGitignorePatterns(dir);

    for (const file of files) {
      if (!ignoreFilter.ignores(relative(cwd, file))) {
        filteredFiles.push(file);
      }
    }
  }

  return filteredFiles.sort();
}

export function local(
  pattern: string,
  options?: {
    ingestWhen?: 'never' | 'contentChanged' | 'expired';
    expiresAfter?: number;
    cwd?: string;
  },
): Connector {
  const sourceId = `glob:${pattern}`;
  return {
    sourceId,
    ingestWhen: options?.ingestWhen,
    expiresAfter: options?.expiresAfter,
    sources: async function* () {
      const paths = await getFilteredFiles(
        options?.cwd ?? process.cwd(),
        pattern,
      );
      for (const filePath of paths) {
        yield {
          id: filePath,
          content: () => readFile(filePath, 'utf8').catch(() => ''),
        };
      }
    },
  };
}
