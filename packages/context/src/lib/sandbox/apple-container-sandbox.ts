import spawn, { SubprocessError } from 'nano-spawn';
import { spawn as childSpawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import z from 'zod';

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
import {
  commandResultFrom,
  existsOverExec,
  readFileOverExec,
  toSandboxProcess,
  writeFilesOverExec,
} from './cli-process.ts';
import type {
  ContainerEngine,
  EngineContainer,
  ImageBuildSpec,
  SandboxVolume,
} from './container-engine.ts';
import { ContainerfileStrategy, RuntimeStrategy } from './container-sandbox.ts';
import {
  type Installer,
  type InstallerContext,
  createInstallerContext,
} from './installers/installer.ts';
import { shellQuote } from './shell-quote.ts';
import type {
  CommandResult,
  DisposableSandbox,
  ExecuteCommandOptions,
  SandboxProcess,
  SpawnOptions,
} from './types.ts';

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
  AppleContainerBindVolume | AppleContainerNamedVolume;

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
  /** DNS nameservers passed to `container run --dns`. */
  dns?: readonly string[];
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
  /** Image to run (default: `'docker.io/library/bash:5.3-alpine3.24'`). */
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
  AppleContainerRuntimeOptions | AppleContainerfileOptions;

export function isAppleContainerfileOptions(
  opts: AppleContainerSandboxOptions,
): opts is AppleContainerfileOptions {
  return 'dockerfile' in opts;
}

function buildMountArg(volume: SandboxVolume): string {
  const readOnly = volume.readOnly !== false;
  if (volume.type === 'volume') {
    // Named volumes use `-v name:path[:ro]` — the one syntax every CLI version
    // accepts: pre-1.0 rejects `--mount type=volume` ("unknown mount type")
    // and 1.0.0 rejects `type=virtiofs,source=<name>` (source became a host
    // path). Pair with the `-v/--volume` flag, not `--mount`.
    return `${volume.name}:${volume.containerPath}${readOnly ? ':ro' : ''}`;
  }
  const parts = [
    'type=bind',
    `source=${volume.hostPath}`,
    `target=${volume.containerPath}`,
  ];
  if (readOnly) {
    parts.push('readonly');
  }
  return parts.join(',');
}

function getCliErrorMessage(error: unknown): string {
  if (error instanceof SubprocessError) {
    return error.stderr.trim() || error.stdout.trim() || error.message;
  }
  return (error instanceof Error && error.message) || String(error);
}

function safeParseArray(stdout: string): unknown[] {
  try {
    const parsed = JSON.parse(stdout || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * One `container inspect` entry. CLI 1.0.0 nests the state in a `status`
 * object; pre-1.0 returned a bare string ("booted" was a pre-1.0 transient
 * right after `run --detach`).
 */
const containerInspectEntry = z.object({
  status: z.union([
    z.string(),
    z.object({ state: z.string() }).transform(({ state }) => state),
  ]),
});

function readContainerStatus(entry: unknown): 'running' | 'stopped' {
  const parsed = containerInspectEntry.safeParse(entry);
  const status = parsed.success ? parsed.data.status.toLowerCase() : '';
  // "running"/"booted" are up → attach. "stopped" is the only state
  // `container start` accepts. Fail loud on anything else (error/exited/…)
  // rather than attaching to a broken container.
  if (status === 'running' || status === 'booted') return 'running';
  if (status === 'stopped') return 'stopped';
  throw new AppleContainerSandboxError(
    `Container is in an unexpected state "${status}"`,
  );
}

function isServiceDown(message: string): boolean {
  return /apiserver|not running|connection refused|could not connect|xpc/i.test(
    message,
  );
}

function isMissing(message: string): boolean {
  return /not found|no such/i.test(message);
}

function isNameConflict(message: string): boolean {
  return /already exists/i.test(message);
}

function execArgs(
  name: string,
  command: string,
  options?: { cwd?: string; env?: Record<string, string> },
): string[] {
  const flags: string[] = ['--cwd', options?.cwd || WORKDIR];
  for (const [key, value] of Object.entries(options?.env ?? {})) {
    if (key.length === 0 || key.includes('=')) {
      throw new AppleContainerSandboxError(
        `Invalid environment variable key: "${key}"`,
      );
    }
    flags.push('--env', `${key}=${value}`);
  }
  return ['exec', ...flags, name, 'bash', '-lc', command];
}

/** Runs `args` with the `container` CLI as a command result. */
async function run(
  args: string[],
  signal?: AbortSignal,
): Promise<CommandResult> {
  try {
    const result = await spawn(CLI, args, { signal });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
  } catch (error) {
    return commandResultFrom(error);
  }
}

/** A sandbox container of the Apple `container` runtime. */
class AppleContainer implements EngineContainer {
  readonly name: string;

  constructor(name: string) {
    this.name = name;
  }

  executeCommand(
    command: string,
    options?: ExecuteCommandOptions,
  ): Promise<CommandResult> {
    return run(execArgs(this.name, command), options?.signal);
  }

  async spawn(
    command: string,
    options?: SpawnOptions,
  ): Promise<SandboxProcess> {
    return toSandboxProcess(
      childSpawn(CLI, execArgs(this.name, command, options)),
      options?.signal,
    );
  }

  readFile(path: string): Promise<Uint8Array> {
    return readFileOverExec((command) => this.executeCommand(command), path);
  }

  writeFiles(
    files: Array<{ path: string; content: string | Buffer }>,
  ): Promise<void> {
    return writeFilesOverExec((command) => this.executeCommand(command), files);
  }

  exists(path: string): Promise<boolean> {
    return existsOverExec((command) => this.executeCommand(command), path);
  }

  installerContext(image: string): InstallerContext {
    // The Docker installer suite, driven through `container exec`.
    return createInstallerContext(
      {
        exec: (command) => run(['exec', this.name, 'sh', '-c', command]),
        SandboxError: AppleContainerSandboxError,
      },
      this.name,
      image,
    );
  }

  async stop(): Promise<void> {
    try {
      await spawn(CLI, ['stop', this.name]);
    } catch {
      // already stopped
    }
  }
}

/**
 * The Apple `container` CLI dialect, plugged into the shared
 * `ContainerSandboxStrategy` skeleton: `--cwd`/`--env` exec flags, JSON
 * `inspect` parsing, virtiofs mounts, `apiserver`-down detection, and Apple
 * error classes. `runArgs` and `parseStatus` are its argv and status dialect.
 */
export const appleEngine: ContainerEngine<AppleContainerCommonOptions> & {
  runArgs(
    image: string,
    containerId: string,
    opts: AppleContainerCommonOptions,
    workdir: string,
  ): string[];
  parseStatus(stdout: string): 'running' | 'stopped' | 'absent';
} = {
  bindMountsOnClient: true,
  defaultImage: 'docker.io/library/bash:5.3-alpine3.24',

  runArgs(image, containerId, opts) {
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
    for (const nameserver of opts.dns ?? []) {
      args.push('--dns', nameserver);
    }
    for (const [key, value] of Object.entries(opts.env ?? {})) {
      args.push('--env', `${key}=${value}`);
    }
    for (const volume of opts.volumes ?? []) {
      args.push(
        volume.type === 'volume' ? '--volume' : '--mount',
        buildMountArg(volume),
      );
    }

    args.push(image);
    if (opts.command === undefined) {
      args.push('tail', '-f', '/dev/null');
    } else if (opts.command !== null) {
      args.push(...opts.command);
    }

    return args;
  },

  parseStatus(stdout) {
    const entries = safeParseArray(stdout);
    if (entries.length === 0) return 'absent';
    return readContainerStatus(entries[0]);
  },

  async attach(name, image) {
    let status: 'running' | 'stopped' | 'absent';
    try {
      const result = await spawn(CLI, ['inspect', name]);
      status = this.parseStatus(result.stdout.trim());
    } catch (error) {
      const message = getCliErrorMessage(error);
      if (isServiceDown(message)) throw new ContainerServiceNotRunningError();
      if (isMissing(message)) return undefined;
      throw new AppleContainerSandboxError(
        `Failed to inspect container "${name}": ${message}`,
      );
    }
    if (status === 'absent') return undefined;
    if (status === 'stopped') {
      try {
        await spawn(CLI, ['start', name]);
      } catch (error) {
        const message = getCliErrorMessage(error);
        if (isServiceDown(message)) throw new ContainerServiceNotRunningError();
        throw new AppleContainerCreationError(
          message,
          image,
          error instanceof Error ? error : undefined,
        );
      }
    }
    return new AppleContainer(name);
  },

  async run(image, name, opts, workdir) {
    try {
      await spawn(CLI, this.runArgs(image, name, opts, workdir));
    } catch (error) {
      const message = getCliErrorMessage(error);
      if (isServiceDown(message)) throw new ContainerServiceNotRunningError();
      if (isNameConflict(message)) return { created: false };
      throw new AppleContainerCreationError(
        message,
        image,
        error instanceof Error ? error : undefined,
      );
    }
    return { created: true, container: new AppleContainer(name) };
  },

  async volumeExists(name) {
    try {
      await spawn(CLI, ['volume', 'inspect', name]);
      return true;
    } catch (error) {
      const reason = getCliErrorMessage(error);
      if (isServiceDown(reason)) throw new ContainerServiceNotRunningError();
      if (isMissing(reason)) return false;
      throw new AppleContainerVolumeInspectError(name, reason);
    }
  },

  async createVolume(volume) {
    try {
      await spawn(CLI, ['volume', 'create', volume.name]);
    } catch (error) {
      const reason = getCliErrorMessage(error);
      if (isServiceDown(reason)) throw new ContainerServiceNotRunningError();
      throw new AppleContainerVolumeCreateError(volume.name, reason);
    }
  },

  async removeVolume(name) {
    try {
      await spawn(CLI, ['volume', 'rm', name]);
    } catch (error) {
      const reason = getCliErrorMessage(error);
      if (isServiceDown(reason)) throw new ContainerServiceNotRunningError();
      throw new AppleContainerVolumeRemoveError(name, reason);
    }
  },

  async ensureWorkdir(container, workdir) {
    // `container exec --cwd <dir>` fails if <dir> is absent, so the workdir
    // can't be created from inside itself — bootstrap it from the image's
    // default cwd with a plain (no `--cwd`) exec.
    await spawn(CLI, [
      'exec',
      container.name,
      'bash',
      '-lc',
      `mkdir -p ${shellQuote(workdir)}`,
    ]);
  },

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

  async dispose() {
    // The CLI holds no connection.
  },

  errors: {
    generic: (message, containerId) =>
      new AppleContainerSandboxError(message, containerId),
    volumePath: (source, containerPath, reason) =>
      new AppleContainerVolumePathError(source, containerPath, reason),
    volumeInspect: (name, reason) =>
      new AppleContainerVolumeInspectError(name, reason),
    volumeCreate: (name, reason) =>
      new AppleContainerVolumeCreateError(name, reason),
  },
};

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
 *   image: 'docker.io/library/bash:5.3-alpine3.24',
 *   installers: [pkg(['curl', 'jq'])],
 * });
 * const { stdout } = await sandbox.executeCommand('echo hello');
 * ```
 *
 * @example Dockerfile
 * ```ts
 * await using sandbox = await createAppleContainerSandbox({
 *   dockerfile: `
 *     FROM docker.io/library/bash:5.3-alpine3.24
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
