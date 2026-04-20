import { readFile, readdir } from 'node:fs/promises';
import * as path from 'node:path';

export interface WalkedFile {
  /** Absolute host path of the file. */
  path: string;
  /** Relative POSIX path from the walk root (suitable for sandbox targets). */
  relativePath: string;
  /** File contents (as Buffer to preserve binary assets). */
  content: Buffer;
}

function expandHome(input: string): string {
  if (!input.startsWith('~')) return input;
  const home = process.env.HOME ?? '';
  return path.join(home, input.slice(1));
}

/**
 * Recursively list every regular file under `root`. Skips symlinks (to avoid
 * escaping `root`) and dotfiles / dot-directories (e.g. `.git`, `.DS_Store`,
 * `.env`). Binary contents are preserved.
 *
 * Returns an empty array when `root` does not exist.
 */
export async function walkDirectory(root: string): Promise<WalkedFile[]> {
  const absoluteRoot = path.resolve(expandHome(root));
  const files: WalkedFile[] = [];

  async function walk(current: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      if (entry.isSymbolicLink()) continue;

      const entryPath = path.join(current, entry.name);

      if (entry.isDirectory()) {
        await walk(entryPath);
      } else if (entry.isFile()) {
        const content = await readFile(entryPath);
        const relative = path
          .relative(absoluteRoot, entryPath)
          .split(path.sep)
          .join('/');
        files.push({ path: entryPath, relativePath: relative, content });
      }
    }
  }

  await walk(absoluteRoot);
  return files;
}
