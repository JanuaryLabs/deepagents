import { type CommandResult } from 'bash-tool';
import spawn, { type SubprocessError } from 'nano-spawn';
import { spawn as childSpawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AppleContainerCreationError,
  AppleContainerImageBuildError,
  AppleContainerSandboxError,
  AppleContainerVolumeCreateError,
  AppleContainerVolumeInspectError,
  AppleContainerVolumePathError,
  AppleContainerVolumeRemoveError,
  ContainerServiceNotRunningError,
} from './apple-container-sandbox-errors.ts';
import type {
  ContainerEngine,
  ImageBuildSpec,
  SandboxVolume,
} from './container-engine.ts';
import { ContainerfileStrategy, RuntimeStrategy } from './container-sandbox.ts';
import { PackageInstallError } from './docker-sandbox-errors.ts';
import {
  type Installer,
  type InstallerContext,
  type PackageManager,
  isDebianBased,
} from './installers/installer.ts';
import { shellQuote } from './shell-quote.ts';
import type { DisposableSandbox } from './types.ts';

export {
  AppleContainerCreationError,
  AppleContainerImageBuildError,
  AppleContainerSandboxError,
  AppleContainerVolumeCreateError,
  AppleContainerVolumeInspectError,
  AppleContainerVolumePathError,
  AppleContainerVolumeRemoveError,
  ContainerServiceNotRunningError,
} from './apple-container-sandbox-errors.ts';

const CLI = 'container';

/** Working directory every sandbox command runs in, mirroring the Docker backend. */
const WORKDIR = '/workspace';

export interface AppleContainerBindVolume {
  type: 'bind';
  hostPath: string;
  containerPath: string;
  /** Default: `true`. */
  readOnly?: boolean;
}

export interface AppleContainerNamedVolume {
  type: 'volume';
  name: string;
  containerPath: string;
  /** Default: `true`. */
  readOnly?: boolean;
  /** Default: `'external'`. */
  lifecycle?: 'external' | 'managed';
  /** Default: `true` for managed volumes created by this sandbox. */
  removeOnDispose?: boolean;
}

/**
 * Apple `container` volumes are always local ext4 disk images — there is no
 * pluggable driver model (unlike Docker's `--driver`). Back a volume with
 * remote storage by bind-mounting a host directory instead.
 */
export type AppleContainerVolume =
  | AppleContainerBindVolume
  | AppleContainerNamedVolume;

export interface AppleContainerResources {
  /** `--memory` — e.g. `'1024M'`, `'2G'` (MB granularity). */
  memory?: string;
  /** `--cpus` — number of CPUs. */
  cpus?: number;
}

/**
 * Stable identity suffix for the container. When provided, the container is
 * named `sandbox-<name>` instead of a randomized `sandbox-<8hex>`. If a
 * container with that name already exists, the sandbox attaches to it:
 * installers, volume preparation, and env are skipped. If it exists but is
 * stopped, it is started first. Otherwise it is created fresh.
 *
 * This is get-or-create for SEQUENTIAL callers. Creating the same name from
 * two callers concurrently is not supported — the `container` runtime races on
 * duplicate-name `run` (it can leave a container mid-transition and fail with
 * an internal error); serialize creation of a given name.
 *
 * Must match `/^[A-Za-z0-9_.-]+$/`.
 */
type StableContainerName = string;

export interface AppleContainerCommonOptions {
  volumes?: AppleContainerVolume[];
  resources?: AppleContainerResources;
  env?: Record<string, string>;
  name?: StableContainerName;
  /**
   * Args appended after the image at `container run` time.
   * - `undefined` (default): `['tail', '-f', '/dev/null']` keep-alive so a bare
   *   image stays up for installers and `executeCommand`.
   * - `[]` or `null`: nothing appended; the image's own `CMD`/`ENTRYPOINT` runs.
   * - A non-empty array: appended verbatim, overriding the image command.
   */
  command?: readonly string[] | null;
  /**
   * `-a, --arch` — `'arm64'` (native on Apple silicon) or `'amd64'` (emulated
   * via Rosetta). Replaces the Docker backend's `--platform`.
   */
  arch?: 'arm64' | 'amd64';
}

export interface AppleContainerRuntimeOptions extends AppleContainerCommonOptions {
  /** Image to run (default: `'docker.io/library/alpine:latest'`). */
  image?: string;
  /**
   * Ordered installers run after the container starts. Use `pkg([...])`,
   * `urlBinary({...})`, `npm(...)`, `pip(...)`, `githubRelease({...})`, or any
   * custom `Installer` — the same installers the Docker backend accepts.
   */
  installers?: Installer[];
}

export interface AppleContainerfileOptions extends AppleContainerCommonOptions {
  /** Inline Dockerfile content (contains `\n`) or a path to one. */
  dockerfile: string;
  /** Build context directory (default: `'.'`). */
  context?: string;
  /** Stream `container build` output instead of buffering it. Default `false`. */
  showBuildLogs?: boolean;
}

export type AppleContainerSandboxOptions =
  | AppleContainerRuntimeOptions
  | AppleContainerfileOptions;

export function isAppleContainerfileOptions(
  opts: AppleContainerSandboxOptions,
): opts is AppleContainerfileOptions {
  return 'dockerfile' in opts;
}

function buildMountArg(volume: SandboxVolume): string {
  const readOnly = volume.readOnly !== false;
  const parts =
    volume.type === 'bind'
      ? [
          'type=bind',
          `source=${volume.hostPath}`,
          `target=${volume.containerPath}`,
        ]
      : [
          // Named volumes mount as virtiofs; `container` has no `type=volume`.
          'type=virtiofs',
          `source=${volume.name}`,
          `target=${volume.containerPath}`,
        ];
  if (readOnly) {
    parts.push('readonly');
  }
  return parts.join(',');
}

function getCliErrorMessage(error: unknown): string {
  const err = error as SubprocessError;
  return (
    err.stderr?.trim() || err.stdout?.trim() || err.message || String(error)
  );
}

function safeParseArray(stdout: string): unknown[] {
  try {
    const parsed = JSON.parse(stdout || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function readContainerStatus(entry: unknown): 'running' | 'stopped' {
  const status = String(
    (entry as Record<string, unknown>)?.status ?? '',
  ).toLowerCase();
  // "running" and the transient "booted" (right after `run --detach`) are up →
  // attach. "stopped" is the only state `container start` accepts. Fail loud on
  // anything else (error/exited/…) rather than attaching to a broken container.
  if (status === 'running' || status === 'booted') return 'running';
  if (status === 'stopped') return 'stopped';
  throw new AppleContainerSandboxError(
    `Container is in an unexpected state "${status}"`,
  );
}

/**
 * The Apple `container` CLI dialect, plugged into the shared
 * `ContainerSandboxStrategy` skeleton. Mirrors `dockerEngine` but for the
 * micro-VM runtime: `--cwd`/`--env` exec flags, JSON `inspect` parsing,
 * virtiofs mounts, `apiserver`-down detection, and Apple error classes.
 */
const appleEngine: ContainerEngine<AppleContainerCommonOptions> = {
  cli: CLI,

  runArgs(
    image: string,
    containerId: string,
    opts: AppleContainerCommonOptions,
  ): string[] {
    const { memory = '1024M', cpus = 2 } = opts.resources ?? {};
    const args: string[] = [
      'run',
      '--detach',
      '--rm',
      '--name',
      containerId,
      '--memory',
      memory,
      '--cpus',
      String(cpus),
    ];

    if (opts.arch) {
      args.push('--arch', opts.arch);
    }
    for (const [key, value] of Object.entries(opts.env ?? {})) {
      args.push('--env', `${key}=${value}`);
    }
    for (const volume of opts.volumes ?? []) {
      args.push('--mount', buildMountArg(volume));
    }

    args.push(image);
    if (opts.command === undefined) {
      args.push('tail', '-f', '/dev/null');
    } else if (opts.command !== null) {
      args.push(...opts.command);
    }

    return args;
  },

  execArgs(containerId, command, options) {
    const flags: string[] = ['--cwd', options?.cwd || WORKDIR];
    if (options?.env) {
      for (const [key, value] of Object.entries(options.env)) {
        if (key.length === 0 || key.includes('=')) {
          throw new AppleContainerSandboxError(
            `Invalid environment variable key: "${key}"`,
          );
        }
        flags.push('--env', `${key}=${value}`);
      }
    }
    return ['exec', ...flags, containerId, 'sh', '-c', command];
  },

  inspectArgs(containerId) {
    return ['inspect', containerId];
  },

  mountArg: buildMountArg,

  parseStatus(stdout) {
    const entries = safeParseArray(stdout);
    if (entries.length === 0) return 'absent';
    return readContainerStatus(entries[0]);
  },

  volumeCreateArgs(volume) {
    return ['volume', 'create', volume.name];
  },

  errorMessage: getCliErrorMessage,

  isServiceDown(message) {
    return /apiserver|not running|connection refused|could not connect|xpc/i.test(
      message,
    );
  },

  isMissingContainer(message) {
    return /not found|no such/i.test(message);
  },

  isMissingVolume(message) {
    return /not found|no such/i.test(message);
  },

  isNameConflict(message) {
    return /already exists/i.test(message);
  },

  async ensureWorkdir(containerId: string, workdir: string): Promise<void> {
    // `container exec --cwd <dir>` fails if <dir> is absent, so the workdir
    // can't be created from inside itself — bootstrap it from the image's
    // default cwd with a plain (no `--cwd`) exec.
    await spawn(CLI, ['exec', containerId, 'sh', '-c', `mkdir -p ${workdir}`]);
  },

  defaultImage: 'docker.io/library/alpine:latest',

  createInstallerContext: createAppleInstallerContext,

  async imageExists(tag: string): Promise<boolean> {
    try {
      await spawn(CLI, ['image', 'inspect', tag]);
      return true;
    } catch {
      return false;
    }
  },

  async buildImage(spec: ImageBuildSpec): Promise<void> {
    const archFlag = spec.identity ? ['--arch', spec.identity] : [];
    // `container build` has no `-f -` (stdin) mode, so an inline Dockerfile is
    // written to a fresh temp dir that doubles as a minimal build context
    // (a real directory — `container build` rejects the `/tmp` symlink).
    if (spec.dockerfile.includes('\n')) {
      const tempDir = await mkdtemp(join(tmpdir(), 'sandbox-containerfile-'));
      const dockerfilePath = join(tempDir, 'Dockerfile');
      await writeFile(dockerfilePath, spec.dockerfile);
      try {
        await runAppleBuild(
          ['build', ...archFlag, '-t', spec.tag, '-f', dockerfilePath, tempDir],
          spec.showBuildLogs,
        );
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
      return;
    }
    await runAppleBuild(
      [
        'build',
        ...archFlag,
        '-t',
        spec.tag,
        '-f',
        spec.dockerfile,
        spec.context,
      ],
      spec.showBuildLogs,
    );
  },

  errors: {
    serviceNotAvailable: () => new ContainerServiceNotRunningError(),
    creation: (message, image, cause) =>
      new AppleContainerCreationError(message, image, cause),
    generic: (message, containerId) =>
      new AppleContainerSandboxError(message, containerId),
    volumePath: (source, containerPath, reason) =>
      new AppleContainerVolumePathError(source, containerPath, reason),
    volumeInspect: (name, reason) =>
      new AppleContainerVolumeInspectError(name, reason),
    volumeCreate: (name, reason) =>
      new AppleContainerVolumeCreateError(name, reason),
    volumeRemove: (name, reason) =>
      new AppleContainerVolumeRemoveError(name, reason),
  },
};

/**
 * Apple-container installer context: the Docker installer suite (`pkg`, `npm`,
 * `pip`, `urlBinary`, `githubRelease`, `bin`) runs against this, driving the
 * container through `container exec` instead of `docker exec`. The installer
 * classes are shared verbatim; only this exec/arch/package-manager wiring is
 * forked.
 */
function createAppleInstallerContext(
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
      const result = await spawn(CLI, [
        'exec',
        containerId,
        'sh',
        '-c',
        command,
      ]);
      return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
    } catch (error) {
      const err = error as SubprocessError;
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
          throw new AppleContainerSandboxError(
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

async function runAppleBuild(
  args: string[],
  showBuildLogs: boolean,
): Promise<void> {
  try {
    if (showBuildLogs) {
      await runStreamed(CLI, args);
    } else {
      await spawn(CLI, args);
    }
  } catch (error) {
    throw new AppleContainerImageBuildError(getCliErrorMessage(error));
  }
}

function runStreamed(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = childSpawn(command, args, { stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0
        ? resolve()
        : reject(
            new Error(
              `${command} build exited with code ${code} (see build output above)`,
            ),
          ),
    );
  });
}

/**
 * Create a sandbox backed by Apple's `container` CLI — Linux containers run as
 * lightweight per-container virtual machines on Apple silicon (macOS 26+).
 *
 * Requires the `container` service to be running (`container system start`)
 * with a guest kernel configured (`container system kernel set --recommended`).
 *
 * @example Runtime with installers
 * ```ts
 * import { createAppleContainerSandbox, pkg } from '@deepagents/context';
 *
 * await using sandbox = await createAppleContainerSandbox({
 *   image: 'docker.io/library/alpine:latest',
 *   installers: [pkg(['curl', 'jq'])],
 * });
 * const { stdout } = await sandbox.executeCommand('echo hello');
 * ```
 *
 * @example Dockerfile
 * ```ts
 * await using sandbox = await createAppleContainerSandbox({
 *   dockerfile: `
 *     FROM docker.io/library/alpine:latest
 *     RUN apk add --no-cache curl
 *   `,
 * });
 * ```
 */
export async function createAppleContainerSandbox(
  options: AppleContainerSandboxOptions = {},
): Promise<DisposableSandbox> {
  if (isAppleContainerfileOptions(options)) {
    return new ContainerfileStrategy(options, appleEngine, {
      dockerfile: options.dockerfile,
      context: options.context ?? '.',
      showBuildLogs: options.showBuildLogs ?? false,
      identity: options.arch,
    }).create();
  }
  return new RuntimeStrategy(options, appleEngine, {
    image: options.image ?? appleEngine.defaultImage,
    installers: options.installers ?? [],
  }).create();
}

/**
 * Run a function with an Apple container sandbox; the container is disposed on
 * completion (success or thrown).
 */
export async function useAppleContainerSandbox<T>(
  options: AppleContainerSandboxOptions,
  fn: (sandbox: DisposableSandbox) => Promise<T>,
): Promise<T> {
  const sandbox = await createAppleContainerSandbox(options);
  try {
    return await fn(sandbox);
  } finally {
    await sandbox.dispose();
  }
}
