import { type CommandResult } from 'bash-tool';
import spawn from 'nano-spawn';

import {
  DockerSandboxError,
  PackageInstallError,
} from '../docker-sandbox-errors.ts';

export type PackageManager = 'apk' | 'apt-get';

/**
 * Shared state passed to every installer's `install()` call.
 *
 * The context owns one container's installation lifecycle:
 * - memoised architecture (one `uname -m` per sandbox)
 * - resolved package manager
 * - `apt-get update` runs at most once
 * - idempotent `ensureTool` (cache keyed on install name)
 */
export interface InstallerContext {
  readonly containerId: string;
  readonly image: string;
  readonly packageManager: PackageManager;
  arch(): Promise<string>;
  exec(command: string): Promise<CommandResult>;
  /**
   * Install OS packages via the container's package manager.
   * `apt-get update` runs at most once per container, then subsequent calls
   * issue install only.
   */
  installPackages(packages: string[]): Promise<void>;
  /**
   * Ensure a tool is callable.
   *
   * @param checkName Binary name probed via `which` (e.g. `'node'`).
   * @param installName Package to install when missing (e.g. `'nodejs'`).
   *   Defaults to `checkName` when binary name == package name.
   */
  ensureTool(checkName: string, installName?: string): Promise<void>;
}

export abstract class Installer {
  abstract readonly kind: string;
  abstract install(ctx: InstallerContext): Promise<void>;
}

export function isDebianBased(image: string): boolean {
  const lower = image.toLowerCase();
  if (lower.includes('alpine')) return false;
  const debianPatterns = ['debian', 'ubuntu', 'node', 'python'];
  return debianPatterns.some((pattern) => lower.includes(pattern));
}

/**
 * POSIX shell single-quote escape: wrap in `'...'`, replace any embedded
 * `'` with `'\''`. Safe for arbitrary content inside `sh -c`.
 */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function createInstallerContext(
  containerId: string,
  image: string,
): InstallerContext {
  const packageManager: PackageManager = isDebianBased(image)
    ? 'apt-get'
    : 'apk';

  let archPromise: Promise<string> | null = null;
  const ensuredTools = new Set<string>();
  let aptUpdated = false;

  const exec = async (command: string): Promise<CommandResult> => {
    try {
      const result = await spawn('docker', [
        'exec',
        containerId,
        'sh',
        '-c',
        command,
      ]);
      return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
    } catch (error) {
      const err = error as Error & {
        stdout?: string;
        stderr?: string;
        exitCode?: number;
      };
      return {
        stdout: err.stdout ?? '',
        stderr: err.stderr ?? err.message ?? '',
        exitCode: err.exitCode ?? 1,
      };
    }
  };

  const arch = async (): Promise<string> => {
    if (!archPromise) {
      const attempt = (async () => {
        const result = await exec('uname -m');
        if (result.exitCode !== 0) {
          throw new DockerSandboxError(
            `Failed to detect container architecture: ${result.stderr}`,
            containerId,
          );
        }
        return result.stdout.trim();
      })();
      archPromise = attempt.catch((err) => {
        archPromise = null;
        throw err;
      });
    }
    return archPromise;
  };

  const installPackages = async (packages: string[]): Promise<void> => {
    if (packages.length === 0) return;
    const quoted = packages.map(shellQuote).join(' ');

    let cmd: string;
    if (packageManager === 'apt-get') {
      cmd = aptUpdated
        ? `apt-get install -y ${quoted}`
        : `apt-get update && apt-get install -y ${quoted}`;
    } else {
      cmd = `apk add --no-cache ${quoted}`;
    }

    const result = await exec(cmd);
    if (result.exitCode !== 0) {
      throw new PackageInstallError(
        packages,
        image,
        packageManager,
        result.stderr,
        containerId,
      );
    }
    if (packageManager === 'apt-get') aptUpdated = true;
  };

  const ensureTool = async (
    checkName: string,
    installName?: string,
  ): Promise<void> => {
    const cacheKey = installName ?? checkName;
    if (ensuredTools.has(cacheKey)) return;

    const check = await exec(`which ${shellQuote(checkName)}`);
    if (check.exitCode === 0) {
      ensuredTools.add(cacheKey);
      return;
    }

    await installPackages([installName ?? checkName]);
    ensuredTools.add(cacheKey);
  };

  return {
    containerId,
    image,
    packageManager,
    arch,
    exec,
    installPackages,
    ensureTool,
  };
}
