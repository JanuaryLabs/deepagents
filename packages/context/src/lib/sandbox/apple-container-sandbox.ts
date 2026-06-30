import { type CommandResult } from 'bash-tool';
import spawn from 'nano-spawn';
import { spawn as childSpawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
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
import type { ContainerEngine } from './container-engine.ts';
import { PackageInstallError } from './docker-sandbox-errors.ts';
import {
  type DockerCommonOptions,
  type DockerNamedVolume,
  DockerSandboxStrategy,
  type DockerSandboxVolume,
} from './docker-sandbox.ts';
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

function buildMountArg(volume: DockerSandboxVolume): string {
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
  const err = error as Error & { stderr?: string; stdout?: string };
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
 * `DockerSandboxStrategy` skeleton. Mirrors `dockerEngine` but for the
 * micro-VM runtime: `--cwd`/`--env` exec flags, JSON `inspect` parsing,
 * virtiofs mounts, `apiserver`-down detection, and Apple error classes.
 */
const appleEngine: ContainerEngine = {
  cli: CLI,

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

/**
 * Apple-container layer over the shared `DockerSandboxStrategy` skeleton: wires
 * the `appleEngine` dialect and overrides the handful of run-time divergences
 * (the `container run` argv, and the `mkdir /workspace` bootstrap that the
 * `--cwd`-per-exec model needs).
 */
abstract class AppleSandboxStrategy extends DockerSandboxStrategy {
  protected arch?: 'arm64' | 'amd64';

  constructor(args: AppleContainerCommonOptions = {}) {
    super(
      {
        volumes: args.volumes,
        resources: args.resources,
        env: args.env,
        name: args.name,
        command: args.command,
      } satisfies DockerCommonOptions,
      appleEngine,
    );
    this.arch = args.arch;
  }

  protected override buildDockerArgs(
    image: string,
    containerId: string,
  ): string[] {
    const { memory = '1024M', cpus = 2 } = this.resources;
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

    if (this.arch) {
      args.push('--arch', this.arch);
    }
    for (const [key, value] of Object.entries(this.env)) {
      args.push('--env', `${key}=${value}`);
    }
    for (const volume of this.volumes) {
      args.push('--mount', this.engine.mountArg(volume));
    }

    args.push(image);
    if (this.command === undefined) {
      args.push('tail', '-f', '/dev/null');
    } else if (this.command !== null) {
      args.push(...this.command);
    }

    return args;
  }

  protected override async ensureWorkspace(): Promise<void> {
    // `container exec --cwd <dir>` fails if <dir> is absent, so WORKDIR can't be
    // created from inside itself — bootstrap it from the image's default cwd.
    await spawn(this.engine.cli, [
      'exec',
      this.context.containerId,
      'sh',
      '-c',
      `mkdir -p ${WORKDIR}`,
    ]);
  }
}

export interface AppleContainerRuntimeStrategyArgs extends AppleContainerCommonOptions {
  image?: string;
  installers?: Installer[];
}

/** Starts a vanilla image and runs the supplied installers in order. */
export class AppleContainerRuntimeStrategy extends AppleSandboxStrategy {
  private image: string;
  private installers: Installer[];

  constructor(args: AppleContainerRuntimeStrategyArgs = {}) {
    super(args);
    this.image = args.image ?? 'docker.io/library/alpine:latest';
    this.installers = args.installers ?? [];
  }

  protected async getImage(): Promise<string> {
    return this.image;
  }

  protected async configure(): Promise<void> {
    const ctx = createAppleInstallerContext(
      this.context.containerId,
      this.image,
    );
    for (const installer of this.installers) {
      await installer.install(ctx);
    }
  }
}

export interface AppleContainerfileStrategyArgs extends AppleContainerCommonOptions {
  dockerfile: string;
  context?: string;
  showBuildLogs?: boolean;
}

/**
 * Builds a custom image from a Dockerfile with `container build`
 * (content-hash caching). Runs no post-start configuration.
 */
export class AppleContainerfileStrategy extends AppleSandboxStrategy {
  private imageTag: string;
  private dockerfile: string;
  private buildContext: string;
  private showBuildLogs: boolean;

  constructor(args: AppleContainerfileStrategyArgs) {
    super(args);
    this.dockerfile = args.dockerfile;
    this.buildContext = args.context ?? '.';
    this.showBuildLogs = args.showBuildLogs ?? false;
    this.imageTag = this.computeImageTag();
  }

  private computeImageTag(): string {
    const content = this.isInlineDockerfile()
      ? this.dockerfile
      : readFileSync(this.dockerfile, 'utf-8');
    const hash = createHash('sha256')
      .update(content)
      .update(this.arch ?? '')
      .digest('hex')
      .slice(0, 12);
    return `sandbox-${hash}`;
  }

  private isInlineDockerfile(): boolean {
    return this.dockerfile.includes('\n');
  }

  protected async getImage(): Promise<string> {
    if (!(await this.imageExists())) {
      await this.buildImage();
    }
    return this.imageTag;
  }

  protected async configure(): Promise<void> {}

  private async imageExists(): Promise<boolean> {
    try {
      await spawn(CLI, ['image', 'inspect', this.imageTag]);
      return true;
    } catch {
      return false;
    }
  }

  private async buildImage(): Promise<void> {
    const archFlag = this.arch ? ['--arch', this.arch] : [];

    // `container build` has no `-f -` (stdin) mode, so an inline Dockerfile is
    // written to a fresh temp dir that doubles as a minimal build context
    // (a real directory — `container build` rejects the `/tmp` symlink).
    if (this.isInlineDockerfile()) {
      const tempDir = await mkdtemp(join(tmpdir(), 'sandbox-containerfile-'));
      const dockerfilePath = join(tempDir, 'Dockerfile');
      await writeFile(dockerfilePath, this.dockerfile);
      try {
        await this.runBuild([
          'build',
          ...archFlag,
          '-t',
          this.imageTag,
          '-f',
          dockerfilePath,
          tempDir,
        ]);
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
      return;
    }

    await this.runBuild([
      'build',
      ...archFlag,
      '-t',
      this.imageTag,
      '-f',
      this.dockerfile,
      this.buildContext,
    ]);
  }

  private async runBuild(args: string[]): Promise<void> {
    try {
      if (this.showBuildLogs) {
        await runStreamed(CLI, args);
      } else {
        await spawn(CLI, args);
      }
    } catch (error) {
      throw new AppleContainerImageBuildError(getCliErrorMessage(error));
    }
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
  const strategy = isAppleContainerfileOptions(options)
    ? new AppleContainerfileStrategy({
        dockerfile: options.dockerfile,
        context: options.context,
        showBuildLogs: options.showBuildLogs,
        volumes: options.volumes,
        resources: options.resources,
        env: options.env,
        name: options.name,
        command: options.command,
        arch: options.arch,
      })
    : new AppleContainerRuntimeStrategy({
        image: options.image,
        installers: options.installers,
        volumes: options.volumes,
        resources: options.resources,
        env: options.env,
        name: options.name,
        command: options.command,
        arch: options.arch,
      });

  return strategy.create();
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
