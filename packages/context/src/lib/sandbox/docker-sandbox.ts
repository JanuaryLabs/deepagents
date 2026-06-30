import { type CommandResult } from 'bash-tool';
import spawn from 'nano-spawn';
import { type StdioOptions, spawn as childSpawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

import {
  base64ReadCommand,
  base64WriteCommands,
  toSandboxProcess,
} from './cli-process.ts';
import { type ContainerEngine, dockerEngine } from './container-engine.ts';
import { ContainerSandboxError } from './container-sandbox-errors.ts';
import {
  ComposeStartError,
  DockerSandboxError,
  DockerfileBuildError,
} from './docker-sandbox-errors.ts';
import {
  type Installer,
  createInstallerContext,
} from './installers/installer.ts';
import { shellQuote } from './shell-quote.ts';
import type {
  DisposableSandbox,
  ExecuteCommandOptions,
  SandboxProcess,
  SpawnOptions,
} from './types.ts';

export type { CommandResult as ExecResult, Sandbox } from 'bash-tool';
export {
  ComposeStartError,
  ContainerCreationError,
  DockerNotAvailableError,
  DockerSandboxError,
  DockerfileBuildError,
  type InstallErrorOptions,
  type InstallKind,
  InstallError,
  MissingRuntimeError,
  PackageInstallError,
  VolumeCreateError,
  VolumeInspectError,
  VolumePathError,
  VolumeRemoveError,
} from './docker-sandbox-errors.ts';

export interface DockerBindVolume {
  type: 'bind';
  hostPath: string;
  containerPath: string;
  /** Default: `true`. */
  readOnly?: boolean;
}

export interface DockerNamedVolume {
  type: 'volume';
  name: string;
  containerPath: string;
  /** Default: `true`. */
  readOnly?: boolean;
  /** Default: `'external'`. */
  lifecycle?: 'external' | 'managed';
  /** Docker volume driver used when `lifecycle` is `'managed'`. */
  driver?: string;
  /** Docker volume driver options used when `lifecycle` is `'managed'`. */
  driverOptions?: Record<string, string>;
  subPath?: string;
  noCopy?: boolean;
  /** Default: `true` for managed volumes created by this sandbox. */
  removeOnDispose?: boolean;
}

export type DockerSandboxVolume = DockerBindVolume | DockerNamedVolume;

export interface DockerResources {
  /** `--memory` — e.g. `'1g'`, `'512m'`. */
  memory?: string;
  /** `--cpus` — number of CPUs. */
  cpus?: number;
  /**
   * `--memory-swap` — total memory + swap (e.g. `'1g'`). Without it Docker
   * allows swap up to 2× `memory`; set it equal to `memory` to forbid swap
   * entirely. Must be ≥ `memory`.
   */
  memorySwap?: string;
  /** `--shm-size` — size of `/dev/shm` (e.g. `'64m'`). Raise for Chromium/ML workloads. */
  shmSize?: string;
  /** `--pids-limit` — cap the container's process count (fork-bomb protection). */
  pidsLimit?: number;
  /** `--ulimit` per entry — e.g. `['nofile=1024:2048']`. */
  ulimits?: string[];
  /** `--cpuset-cpus` — CPUs the container may run on, e.g. `'0-1'`. */
  cpusetCpus?: string;
  /** `--cpu-shares` — relative CPU weight under contention. */
  cpuShares?: number;
}

/**
 * Container hardening for `docker run`. All optional — omit for the daemon's
 * defaults (shared kernel, root user, writable root filesystem).
 */
export interface DockerSecurity {
  /**
   * `--cap-drop` per entry. `['ALL']` drops every Linux capability — the
   * baseline for running untrusted code; re-grant via {@link capAdd}.
   */
  capDrop?: string[];
  /** `--cap-add` per entry. Re-grant only what's needed after dropping `ALL`. */
  capAdd?: string[];
  /**
   * `--read-only` — mount the container root filesystem read-only. Writes then
   * only land in `tmpfs`/volume mounts; pair with a writable `/workspace`
   * (a {@link tmpfs} entry or volume) or the sandbox's `writeFiles` and the
   * installer phase will fail.
   */
  readOnly?: boolean;
  /**
   * `--user` (`uid[:gid]`) — run as a non-root user. The installer phase
   * (`apk`/`apt`/`npm -g`/`pip`) needs root, so non-root suits a pre-baked
   * Dockerfile image rather than the runtime-image + installers path.
   */
  user?: string;
  /**
   * `--tmpfs` per entry (e.g. `'/tmp'`, `'/workspace:size=64m'`) — ephemeral,
   * in-memory writable directories. The companion to {@link readOnly}.
   */
  tmpfs?: string[];
  /**
   * `--security-opt` per entry — e.g. `['seccomp=/path/profile.json']` to apply
   * a custom seccomp profile, or `['no-new-privileges']`.
   */
  securityOpt?: string[];
}

/** Networking for `docker run`. */
export interface DockerNetwork {
  /**
   * `--network` — e.g. `'none'` (no network at all; strong isolation for
   * untrusted code, but breaks network installers), a custom network name, or
   * `'host'` (shares the host network stack — defeats isolation).
   */
  mode?: string;
  /** `--publish` per entry — e.g. `['8080:80']` to expose a container port. */
  publish?: string[];
  /** `--dns` per entry — custom DNS servers. */
  dns?: string[];
  /** `--add-host` per entry — e.g. `['db:10.0.0.5']` host-to-IP mappings. */
  addHost?: string[];
  /** `--hostname` — the container hostname. */
  hostname?: string;
}

/**
 * Stable identity suffix for the container. When provided, the container
 * is named `sandbox-<name>` instead of getting a randomized
 * `sandbox-<8hex>`. If a container with that name already exists on the
 * host, the sandbox attaches to it: installers, volume preparation, and
 * env are skipped (the pre-existing container is assumed already
 * configured). If it exists but is stopped, it is started first.
 * Otherwise the container is created fresh and installers run as usual.
 *
 * Must match `/^[A-Za-z0-9_.-]+$/`. The full Docker container name
 * (`sandbox-<name>`) is always legal because the prefix begins with an
 * alphanumeric character.
 *
 * Warning: `dispose()` stops (and `--rm` removes) the container regardless
 * of whether it was created or attached to. If two callers in the same
 * process share a name, the first `dispose()` destroys the container the
 * other one is still using.
 */
type StableContainerName = string;

/**
 * Run-configuration shared by the runtime-image and Dockerfile sandbox
 * strategies. Every field maps to one or more `docker run` flags.
 */
export interface DockerCommonOptions {
  volumes?: DockerSandboxVolume[];
  resources?: DockerResources;
  env?: Record<string, string>;
  name?: StableContainerName;
  /**
   * Args appended after the image at `docker run` time.
   * - `undefined` (default): `['tail', '-f', '/dev/null']` — keep-alive so a
   *   bare image (e.g. `alpine:latest`) stays up for installers and
   *   `executeCommand`.
   * - `[]` or `null`: nothing is appended; the image's own `CMD`/`ENTRYPOINT`
   *   runs as declared (use this when the image already has a long-running
   *   process, e.g. a daemon).
   * - A non-empty array: appended verbatim, overriding the image `CMD`.
   */
  command?: readonly string[] | null;
  /**
   * `--platform` (e.g. `'linux/amd64'`) — emulated when it differs from the host
   * arch. For the Dockerfile strategy it also applies to `docker build` and is
   * folded into the image-build cache key.
   */
  platform?: string;
  /**
   * `--runtime` for `docker run` — selects the OCI runtime that backs the
   * container (default: the daemon's default, usually `runc`). Set to a
   * registered runtime such as `'kata-runtime'` (or `'io.containerd.kata.v2'`)
   * to run the container inside a lightweight VM with its own guest kernel
   * instead of sharing the host kernel. The runtime must already be installed on
   * the host and registered in the Docker daemon — and the host must have
   * hardware virtualization (`/dev/kvm`); it is not provisioned here.
   */
  runtime?: string;
  /** Container hardening: capabilities, read-only rootfs, user, tmpfs, security-opt. */
  security?: DockerSecurity;
  /** Networking: network mode, published ports, DNS, host mappings, hostname. */
  network?: DockerNetwork;
  /**
   * `--gpus` — e.g. `'all'`. Requires the nvidia container runtime on the host
   * and is incompatible with a `runtime` such as `'kata-runtime'`.
   */
  gpus?: string;
  /**
   * `--device` per entry — expose a host device, e.g. `['/dev/fuse']`. Passed
   * through verbatim; the library never injects a device implicitly.
   */
  devices?: string[];
  /** `--init` — run an init process as PID 1 that reaps zombie subprocesses. */
  init?: boolean;
  /** `--label` — container metadata, emitted as `key=value` per entry. */
  labels?: Record<string, string>;
  /** `--sysctl` — kernel parameters, emitted as `key=value` per entry. */
  sysctls?: Record<string, string>;
  /** `--entrypoint` — override the image `ENTRYPOINT`. */
  entrypoint?: string;
  /** `--workdir` — working directory inside the container (default `'/workspace'`). */
  workdir?: string;
}

export interface RuntimeSandboxOptions extends DockerCommonOptions {
  /** Docker image to use (default: `'alpine:latest'`). */
  image?: string;
  /**
   * Ordered list of installers run after the container starts. Use
   * `pkg([...])`, `urlBinary({...})`, `npm(...)`, `pip(...)`,
   * `githubRelease({...})`, or any custom `Installer` subclass.
   */
  installers?: Installer[];
}

export interface DockerfileSandboxOptions extends DockerCommonOptions {
  /** Inline Dockerfile content (contains `\n`) or a path. */
  dockerfile: string;
  /** Build context directory (default: `'.'`). */
  context?: string;
  /**
   * Stream `docker build` output to the parent stdio instead of buffering it.
   * A Dockerfile build (e.g. `npm ci` + a project build) can take minutes and
   * otherwise runs silently. Default `false`.
   */
  showBuildLogs?: boolean;
}

export interface ComposeSandboxOptions {
  compose: string;
  service: string;
  resources?: DockerResources;
}

export type DockerSandboxOptions =
  | RuntimeSandboxOptions
  | DockerfileSandboxOptions
  | ComposeSandboxOptions;

export function isDockerfileOptions(
  opts: DockerSandboxOptions,
): opts is DockerfileSandboxOptions {
  return 'dockerfile' in opts;
}

export function isComposeOptions(
  opts: DockerSandboxOptions,
): opts is ComposeSandboxOptions {
  return 'compose' in opts;
}

interface StrategyContext {
  containerId: string;
  image: string;
}

const CONTAINER_NAME_PATTERN = /^[A-Za-z0-9_.-]+$/;

/**
 * Template Method base for sandbox creation strategies. Subclasses choose
 * the image and define post-start configuration; the base owns container
 * lifecycle, exec, and file I/O.
 */
export abstract class DockerSandboxStrategy {
  protected context!: StrategyContext;
  protected engine: ContainerEngine;
  protected volumes: DockerSandboxVolume[];
  protected resources: DockerResources;
  protected env: Record<string, string>;
  protected name?: StableContainerName;
  protected command?: readonly string[] | null;
  protected security: DockerSecurity;
  protected network: DockerNetwork;
  protected gpus?: string;
  protected devices: string[];
  protected init: boolean;
  protected labels: Record<string, string>;
  protected sysctls: Record<string, string>;
  protected entrypoint?: string;
  protected workdir: string;
  protected platform?: string;
  protected runtime?: string;
  private createdVolumes = new Set<string>();

  constructor(
    args: DockerCommonOptions = {},
    engine: ContainerEngine = dockerEngine,
  ) {
    this.engine = engine;
    const {
      volumes = [],
      resources = {},
      env = {},
      name,
      command,
      security = {},
      network = {},
      platform,
      runtime,
      gpus,
      devices = [],
      init = false,
      labels = {},
      sysctls = {},
      entrypoint,
      workdir = '/workspace',
    } = args;
    for (const key of Object.keys(env)) {
      if (key.length === 0 || key.includes('=')) {
        throw this.engine.errors.generic(
          `Invalid environment variable key: "${key}"`,
        );
      }
    }
    if (name !== undefined && !CONTAINER_NAME_PATTERN.test(name)) {
      throw this.engine.errors.generic(
        `Invalid container name: "${name}". Use only letters, numbers, underscore, period, or hyphen. The "sandbox-" prefix is added automatically.`,
      );
    }
    this.volumes = volumes;
    this.resources = resources;
    this.env = env;
    this.name = name;
    this.command = command;
    this.security = security;
    this.network = network;
    this.gpus = gpus;
    this.devices = devices;
    this.init = init;
    this.labels = labels;
    this.sysctls = sysctls;
    this.entrypoint = entrypoint;
    this.workdir = workdir;
    this.platform = platform;
    this.runtime = runtime;
  }

  async create(): Promise<DisposableSandbox> {
    const image = await this.getImage();
    let acquired: { containerId: string; attached: boolean } | undefined;

    try {
      acquired = await this.acquireContainer(image);
      this.context = { containerId: acquired.containerId, image };
      if (!acquired.attached) {
        await this.ensureWorkspace();
        await this.configure();
      }
    } catch (error) {
      if (acquired && !acquired.attached) {
        await this.stopContainer(acquired.containerId);
      }
      await this.cleanupCreatedVolumesAfterFailure(error);
      throw error;
    }

    return this.createSandboxMethods();
  }

  private namedContainerId(): string {
    return `sandbox-${this.name}`;
  }

  protected defaultContainerId(): string {
    return `sandbox-${crypto.randomUUID().slice(0, 8)}`;
  }

  protected async acquireContainer(
    image: string,
  ): Promise<{ containerId: string; attached: boolean }> {
    if (!this.name) {
      const containerId = this.defaultContainerId();
      await this.prepareVolumes();
      await this.startContainer(image, containerId);
      return { containerId, attached: false };
    }

    const containerId = this.namedContainerId();
    const probe = await this.inspectContainer(containerId);
    if (probe === 'running') {
      return { containerId, attached: true };
    }
    if (probe === 'stopped') {
      await this.startStoppedContainer(containerId, image);
      return { containerId, attached: true };
    }

    await this.prepareVolumes();
    try {
      await this.startContainer(image, containerId);
      return { containerId, attached: false };
    } catch (error) {
      if (
        error instanceof ContainerSandboxError &&
        this.isNameConflictError(error.message)
      ) {
        await this.cleanupCreatedVolumes();
        const raced = await this.inspectContainer(containerId);
        if (raced === 'running') {
          return { containerId, attached: true };
        }
        if (raced === 'stopped') {
          await this.startStoppedContainer(containerId, image);
          return { containerId, attached: true };
        }
      }
      throw error;
    }
  }

  private async startStoppedContainer(
    containerId: string,
    image: string,
  ): Promise<void> {
    try {
      await spawn(this.engine.cli, ['start', containerId]);
    } catch (error) {
      const message = this.getDockerErrorMessage(error);
      if (this.isDockerUnavailableError(message)) {
        throw this.engine.errors.serviceNotAvailable();
      }
      throw this.engine.errors.creation(message, image, error as Error);
    }
  }

  protected async inspectContainer(
    containerId: string,
  ): Promise<'running' | 'stopped' | 'absent'> {
    try {
      const result = await spawn(
        this.engine.cli,
        this.engine.inspectArgs(containerId),
      );
      return this.engine.parseStatus(result.stdout.trim());
    } catch (error) {
      const message = this.getDockerErrorMessage(error);
      if (this.isDockerUnavailableError(message)) {
        throw this.engine.errors.serviceNotAvailable();
      }
      if (this.isMissingContainerError(message)) {
        return 'absent';
      }
      throw this.engine.errors.generic(
        `Failed to inspect container "${containerId}": ${message}`,
      );
    }
  }

  private isMissingContainerError(message: string): boolean {
    return this.engine.isMissingContainer(message);
  }

  private isNameConflictError(message: string): boolean {
    return this.engine.isNameConflict(message);
  }

  protected async prepareVolumes(): Promise<void> {
    this.validateVolumes();

    for (const volume of this.volumes) {
      if (volume.type !== 'volume') {
        continue;
      }

      const lifecycle = volume.lifecycle ?? 'external';
      if (lifecycle === 'external') {
        await this.inspectVolume(volume.name);
        continue;
      }

      const exists = await this.volumeExists(volume.name);
      if (exists) {
        throw this.engine.errors.volumeCreate(
          volume.name,
          'managed volume already exists',
        );
      }

      await this.createVolume(volume);
      if (volume.removeOnDispose !== false) {
        this.createdVolumes.add(volume.name);
      }
    }
  }

  protected validateVolumes(): void {
    const containerPaths = new Set<string>();

    for (const volume of this.volumes) {
      const source = volume.type === 'bind' ? volume.hostPath : volume.name;

      if (!volume.containerPath.startsWith('/')) {
        throw this.engine.errors.volumePath(
          source,
          volume.containerPath,
          'containerPath must be absolute',
        );
      }
      this.validateMountValue('containerPath', volume.containerPath, volume);

      if (containerPaths.has(volume.containerPath)) {
        throw this.engine.errors.volumePath(
          source,
          volume.containerPath,
          'containerPath must be unique',
        );
      }
      containerPaths.add(volume.containerPath);

      if (volume.type === 'bind') {
        this.validateMountValue('hostPath', volume.hostPath, volume);
        if (!existsSync(volume.hostPath)) {
          throw this.engine.errors.volumePath(
            volume.hostPath,
            volume.containerPath,
            'hostPath does not exist on host',
          );
        }
        continue;
      }

      if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(volume.name)) {
        throw this.engine.errors.volumePath(
          volume.name,
          volume.containerPath,
          'volume name must start with an alphanumeric character and contain only letters, numbers, underscore, period, or hyphen',
        );
      }
      if (volume.subPath) {
        this.validateMountValue('subPath', volume.subPath, volume);
      }

      if ((volume.lifecycle ?? 'external') === 'external') {
        if (volume.driver || volume.driverOptions) {
          throw this.engine.errors.volumePath(
            volume.name,
            volume.containerPath,
            'driver and driverOptions require lifecycle "managed"',
          );
        }
      }
    }
  }

  private validateMountValue(
    field: 'hostPath' | 'containerPath' | 'subPath',
    value: string,
    volume: DockerSandboxVolume,
  ): void {
    if (!value.includes(',')) {
      return;
    }
    const source = volume.type === 'bind' ? volume.hostPath : volume.name;
    throw this.engine.errors.volumePath(
      source,
      volume.containerPath,
      `${field} must not contain commas`,
    );
  }

  protected buildDockerArgs(image: string, containerId: string): string[] {
    return dockerEngine.runArgs({
      image,
      containerId,
      workdir: this.workdir,
      resources: this.resources,
      security: this.security,
      network: this.network,
      env: this.env,
      volumes: this.volumes,
      command: this.command,
      platform: this.platform,
      runtime: this.runtime,
      gpus: this.gpus,
      devices: this.devices,
      init: this.init,
      labels: this.labels,
      sysctls: this.sysctls,
      entrypoint: this.entrypoint,
    });
  }

  protected buildVolumeMountArg(volume: DockerSandboxVolume): string {
    return this.engine.mountArg(volume);
  }

  private async inspectVolume(name: string): Promise<void> {
    try {
      await spawn(this.engine.cli, ['volume', 'inspect', name]);
    } catch (error) {
      const reason = this.getDockerErrorMessage(error);
      if (this.isDockerUnavailableError(reason)) {
        throw this.engine.errors.serviceNotAvailable();
      }
      throw this.engine.errors.volumeInspect(name, reason);
    }
  }

  private async volumeExists(name: string): Promise<boolean> {
    try {
      await this.inspectVolume(name);
      return true;
    } catch (error) {
      if (
        error instanceof ContainerSandboxError &&
        this.engine.isMissingVolume(error.message)
      ) {
        return false;
      }
      throw error;
    }
  }

  private async createVolume(volume: DockerNamedVolume): Promise<void> {
    const args = this.engine.volumeCreateArgs(volume);

    try {
      await spawn(this.engine.cli, args);
    } catch (error) {
      const reason = this.getDockerErrorMessage(error);
      if (this.isDockerUnavailableError(reason)) {
        throw this.engine.errors.serviceNotAvailable();
      }
      throw this.engine.errors.volumeCreate(volume.name, reason);
    }
  }

  private async cleanupCreatedVolumes(): Promise<void> {
    const volumes = [...this.createdVolumes].reverse();
    for (const volume of volumes) {
      try {
        await spawn(this.engine.cli, ['volume', 'rm', volume]);
        this.createdVolumes.delete(volume);
      } catch (error) {
        const reason = this.getDockerErrorMessage(error);
        if (this.isDockerUnavailableError(reason)) {
          throw this.engine.errors.serviceNotAvailable();
        }
        throw this.engine.errors.volumeRemove(volume, reason);
      }
    }
  }

  private async cleanupCreatedVolumesAfterFailure(
    originalError: unknown,
  ): Promise<void> {
    try {
      await this.cleanupCreatedVolumes();
    } catch (cleanupError) {
      if (originalError instanceof Error) {
        const original = originalError as Error & { suppressed?: unknown[] };
        original.suppressed = [...(original.suppressed ?? []), cleanupError];
      }
    }
  }

  private getDockerErrorMessage(error: unknown): string {
    return this.engine.errorMessage(error);
  }

  private isDockerUnavailableError(message: string): boolean {
    return this.engine.isServiceDown(message);
  }

  protected async startContainer(
    image: string,
    containerId: string,
  ): Promise<void> {
    const args = this.buildDockerArgs(image, containerId);

    try {
      await spawn(this.engine.cli, args);
    } catch (error) {
      const err = error as Error & { stderr?: string };
      if (
        err.message?.includes('Cannot connect') ||
        err.message?.includes('docker daemon') ||
        err.stderr?.includes('Cannot connect')
      ) {
        throw this.engine.errors.serviceNotAvailable();
      }
      throw this.engine.errors.creation(
        this.getDockerErrorMessage(err),
        image,
        err,
      );
    }
  }

  protected async stopContainer(containerId: string): Promise<void> {
    try {
      await spawn(this.engine.cli, ['stop', containerId]);
    } catch {
      // already stopped
    }
  }

  protected async exec(
    command: string,
    options?: ExecuteCommandOptions,
  ): Promise<CommandResult> {
    try {
      const result = await spawn(
        this.engine.cli,
        this.engine.execArgs(this.context.containerId, command),
        { signal: options?.signal },
      );
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: 0,
      };
    } catch (error) {
      const err = error as Error & {
        stdout?: string;
        stderr?: string;
        exitCode?: number;
      };
      return {
        stdout: err.stdout || '',
        stderr: err.stderr || err.message || '',
        exitCode: err.exitCode ?? 1,
      };
    }
  }

  protected spawnProcess(
    command: string,
    options?: SpawnOptions,
  ): SandboxProcess {
    const child = childSpawn(
      this.engine.cli,
      this.engine.execArgs(this.context.containerId, command, options),
    );
    return toSandboxProcess(child, options?.signal);
  }

  protected createSandboxMethods(): DisposableSandbox {
    const { containerId } = this.context;

    const sandbox: DisposableSandbox = {
      executeCommand: async (command, options) => this.exec(command, options),
      spawn: (command, options) => this.spawnProcess(command, options),

      readFile: async (path: string): Promise<string> => {
        const result = await sandbox.executeCommand(base64ReadCommand(path));
        if (result.exitCode !== 0) {
          throw new Error(`Failed to read file "${path}": ${result.stderr}`);
        }
        return Buffer.from(result.stdout, 'base64').toString('utf-8');
      },

      writeFiles: async (
        files: Array<{ path: string; content: string | Buffer }>,
      ): Promise<void> => {
        for (const file of files) {
          const dir = file.path.substring(0, file.path.lastIndexOf('/'));
          if (dir) {
            await sandbox.executeCommand(`mkdir -p ${shellQuote(dir)}`);
          }

          for (const command of base64WriteCommands(file.path, file.content)) {
            const result = await sandbox.executeCommand(command);
            if (result.exitCode !== 0) {
              throw new Error(
                `Failed to write file "${file.path}": ${result.stderr}`,
              );
            }
          }
        }
      },

      dispose: async (): Promise<void> => {
        await this.stopContainer(containerId);
        await this.cleanupCreatedVolumes();
      },

      [Symbol.asyncDispose](this: DisposableSandbox): Promise<void> {
        return this.dispose();
      },
    };

    return sandbox;
  }

  protected abstract getImage(): Promise<string>;
  protected abstract configure(): Promise<void>;

  /** Hook: backends whose exec requires a pre-existing workdir override this. */
  protected async ensureWorkspace(): Promise<void> {}
}

function validateEnvKey(key: string): void {
  if (key.length === 0 || key.includes('=')) {
    throw new DockerSandboxError(`Invalid environment variable key: "${key}"`);
  }
}

function buildDockerExecFlags(options?: SpawnOptions): string[] {
  const flags: string[] = [];
  if (options?.cwd) {
    flags.push('-w', options.cwd);
  }
  if (options?.env) {
    for (const [key, value] of Object.entries(options.env)) {
      validateEnvKey(key);
      flags.push('-e', `${key}=${value}`);
    }
  }
  return flags;
}

export interface RuntimeStrategyArgs extends DockerCommonOptions {
  image?: string;
  installers?: Installer[];
}

/**
 * Starts a vanilla image and runs the supplied installers in order.
 *
 * @example
 * ```ts
 * new RuntimeStrategy({
 *   image: 'alpine:latest',
 *   installers: [
 *     pkg(['curl', 'jq']),
 *     urlBinary({ name: 'presenterm', url: {...} }),
 *     npm('prettier', { ensureRuntime: true }),
 *   ],
 * });
 * ```
 */
export class RuntimeStrategy extends DockerSandboxStrategy {
  private image: string;
  private installers: Installer[];

  constructor(args: RuntimeStrategyArgs = {}) {
    super(args);
    this.image = args.image ?? 'alpine:latest';
    this.installers = args.installers ?? [];
  }

  protected async getImage(): Promise<string> {
    return this.image;
  }

  protected async configure(): Promise<void> {
    const ctx = createInstallerContext(this.context.containerId, this.image);
    for (const installer of this.installers) {
      await installer.install(ctx);
    }
  }
}

export interface DockerfileStrategyArgs extends DockerCommonOptions {
  dockerfile: string;
  context?: string;
  showBuildLogs?: boolean;
}

/**
 * Builds a custom image from a Dockerfile (with content-hash caching).
 * Runs no post-start configuration — the Dockerfile defines the image.
 */
export class DockerfileStrategy extends DockerSandboxStrategy {
  private imageTag: string;
  private dockerfile: string;
  private dockerContext: string;
  private showBuildLogs: boolean;

  constructor(args: DockerfileStrategyArgs) {
    super(args);
    this.dockerfile = args.dockerfile;
    this.dockerContext = args.context ?? '.';
    this.showBuildLogs = args.showBuildLogs ?? false;
    this.imageTag = this.computeImageTag();
  }

  private computeImageTag(): string {
    const content = this.isInlineDockerfile()
      ? this.dockerfile
      : readFileSync(this.dockerfile, 'utf-8');
    // Fold the platform into the cache key so a native build and an emulated
    // cross-arch build of the same Dockerfile don't collide on one tag.
    const hash = createHash('sha256')
      .update(content)
      .update(this.platform ?? '')
      .digest('hex')
      .slice(0, 12);
    return `sandbox-${hash}`;
  }

  private isInlineDockerfile(): boolean {
    return this.dockerfile.includes('\n');
  }

  protected async getImage(): Promise<string> {
    const exists = await this.imageExists();
    if (!exists) {
      await this.buildImage();
    }
    return this.imageTag;
  }

  protected async configure(): Promise<void> {
    // Dockerfile already configured the image.
  }

  private async imageExists(): Promise<boolean> {
    try {
      await spawn('docker', ['image', 'inspect', this.imageTag]);
      return true;
    } catch {
      return false;
    }
  }

  private async buildImage(): Promise<void> {
    const inline = this.isInlineDockerfile();
    const args = [
      'build',
      ...(this.platform ? ['--platform', this.platform] : []),
      '-t',
      this.imageTag,
      '-f',
      inline ? '-' : this.dockerfile,
      this.dockerContext,
    ];
    await this.runDockerBuild(args, inline ? this.dockerfile : undefined);
  }

  /**
   * Runs `docker build`. An inline Dockerfile is piped to `docker build -f -`
   * over stdin (no shell, no quoting). With `showBuildLogs`, build output
   * streams live to the parent terminal; otherwise it is buffered so the
   * failure stderr can be surfaced in a {@link DockerfileBuildError}.
   */
  private runDockerBuild(args: string[], stdin?: string): Promise<void> {
    const streamed = this.showBuildLogs;
    const stdio: StdioOptions = [
      stdin === undefined ? 'inherit' : 'pipe',
      streamed ? 'inherit' : 'ignore',
      streamed ? 'inherit' : 'pipe',
    ];

    return new Promise((resolve, reject) => {
      const child = childSpawn('docker', args, { stdio });

      let stderr = '';
      child.stderr?.on('data', (chunk) => {
        stderr += chunk;
      });

      child.once('error', (error) =>
        reject(new DockerfileBuildError(error.message)),
      );
      child.once('exit', (code) => {
        if (code === 0) {
          resolve();
          return;
        }
        reject(
          new DockerfileBuildError(
            streamed
              ? `docker build exited with code ${code} (see build output above)`
              : stderr || `docker build exited with code ${code}`,
          ),
        );
      });

      if (stdin !== undefined && child.stdin) {
        child.stdin.on('error', () => {});
        child.stdin.end(stdin);
      }
    });
  }
}

export interface ComposeStrategyArgs {
  compose: string;
  service: string;
  resources?: DockerResources;
}

/**
 * Manages multi-container environments via `docker compose`.
 * Commands run inside the named service; `dispose()` brings the whole stack down.
 */
export class ComposeStrategy extends DockerSandboxStrategy {
  private projectName: string;
  private composeFile: string;
  private service: string;

  constructor(args: ComposeStrategyArgs) {
    super({ resources: args.resources });
    this.composeFile = args.compose;
    this.service = args.service;
    this.projectName = this.computeProjectName();
  }

  private computeProjectName(): string {
    const content = readFileSync(this.composeFile, 'utf-8');
    const hash = createHash('sha256').update(content).digest('hex').slice(0, 8);
    return `sandbox-${hash}`;
  }

  protected async getImage(): Promise<string> {
    return '';
  }

  protected override async startContainer(
    _image: string,
    _containerId: string,
  ): Promise<void> {
    try {
      await spawn('docker', [
        'compose',
        '-f',
        this.composeFile,
        '-p',
        this.projectName,
        'up',
        '-d',
      ]);
    } catch (error) {
      const err = error as Error & { stderr?: string };
      if (err.stderr?.includes('Cannot connect')) {
        throw this.engine.errors.serviceNotAvailable();
      }
      throw new ComposeStartError(this.composeFile, err.stderr || err.message);
    }
  }

  protected override defaultContainerId(): string {
    return this.projectName;
  }

  protected async configure(): Promise<void> {
    // Compose file is the source of truth.
  }

  protected override async exec(
    command: string,
    options?: ExecuteCommandOptions,
  ): Promise<CommandResult> {
    try {
      const result = await spawn(
        'docker',
        [
          'compose',
          '-f',
          this.composeFile,
          '-p',
          this.projectName,
          'exec',
          '-T',
          this.service,
          'sh',
          '-c',
          command,
        ],
        { signal: options?.signal },
      );
      return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
    } catch (error) {
      const err = error as Error & {
        stdout?: string;
        stderr?: string;
        exitCode?: number;
      };
      return {
        stdout: err.stdout || '',
        stderr: err.stderr || err.message || '',
        exitCode: err.exitCode ?? 1,
      };
    }
  }

  protected override spawnProcess(
    command: string,
    options?: SpawnOptions,
  ): SandboxProcess {
    const child = childSpawn('docker', [
      'compose',
      '-f',
      this.composeFile,
      '-p',
      this.projectName,
      'exec',
      '-T',
      ...buildDockerExecFlags(options),
      this.service,
      'sh',
      '-c',
      command,
    ]);
    return toSandboxProcess(child, options?.signal);
  }

  protected override async stopContainer(_containerId: string): Promise<void> {
    try {
      await spawn('docker', [
        'compose',
        '-f',
        this.composeFile,
        '-p',
        this.projectName,
        'down',
      ]);
    } catch {
      // ignore cleanup errors
    }
  }
}

/**
 * Create a Docker-backed sandbox.
 *
 * @example Runtime with installers
 * ```ts
 * import { createDockerSandbox, pkg, urlBinary, npm } from '@deepagents/context';
 *
 * const sandbox = await createDockerSandbox({
 *   image: 'alpine:latest',
 *   installers: [
 *     pkg(['curl', 'jq']),
 *     urlBinary({ name: 'presenterm', url: {...} }),
 *     npm('prettier', { ensureRuntime: true }),
 *   ],
 * });
 * ```
 *
 * @example Dockerfile
 * ```ts
 * const sandbox = await createDockerSandbox({
 *   dockerfile: `
 *     FROM alpine:latest
 *     RUN apk add --no-cache curl jq
 *   `,
 * });
 * ```
 *
 * @example Compose
 * ```ts
 * const sandbox = await createDockerSandbox({
 *   compose: './docker-compose.yml',
 *   service: 'app',
 * });
 * ```
 */
export async function createDockerSandbox(
  options: DockerSandboxOptions = {},
): Promise<DisposableSandbox> {
  let strategy: DockerSandboxStrategy;

  if (isComposeOptions(options)) {
    strategy = new ComposeStrategy({
      compose: options.compose,
      service: options.service,
      resources: options.resources,
    });
  } else if (isDockerfileOptions(options)) {
    strategy = new DockerfileStrategy(options);
  } else {
    strategy = new RuntimeStrategy(options);
  }

  return strategy.create();
}

/**
 * Run a function with a Docker sandbox; the container is disposed on
 * completion (success or thrown).
 */
export async function useSandbox<T>(
  options: DockerSandboxOptions,
  fn: (sandbox: DisposableSandbox) => Promise<T>,
): Promise<T> {
  const sandbox = await createDockerSandbox(options);
  try {
    return await fn(sandbox);
  } finally {
    await sandbox.dispose();
  }
}
