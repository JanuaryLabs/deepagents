import { type CommandResult } from 'bash-tool';
import spawn, { type SubprocessError } from 'nano-spawn';
import { type StdioOptions, spawn as childSpawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { toSandboxProcess } from './cli-process.ts';
import type {
  CommonSandboxOptions,
  ContainerEngine,
  ImageBuildSpec,
  SandboxNamedVolume,
  SandboxResources,
  SandboxVolume,
} from './container-engine.ts';
import {
  ContainerSandboxStrategy,
  ContainerfileStrategy,
  RuntimeStrategy,
} from './container-sandbox.ts';
import {
  ComposeStartError,
  ContainerCreationError,
  DockerNotAvailableError,
  DockerSandboxError,
  DockerfileBuildError,
  VolumeCreateError,
  VolumeInspectError,
  VolumePathError,
  VolumeRemoveError,
} from './docker-sandbox-errors.ts';
import {
  type Installer,
  createInstallerContext,
} from './installers/installer.ts';
import type {
  DisposableSandbox,
  ExecuteCommandOptions,
  SandboxProcess,
  SpawnOptions,
} from './types.ts';

export type { CommandResult as ExecResult, Sandbox } from 'bash-tool';
export type {
  SandboxBindVolume as DockerBindVolume,
  SandboxNamedVolume as DockerNamedVolume,
  SandboxVolume as DockerSandboxVolume,
} from './container-engine.ts';
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

export interface DockerResources extends SandboxResources {
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
 * Run-configuration for the Docker engine. Extends the common options the shared
 * skeleton reads with Docker-only `docker run` knobs that only `dockerEngine`
 * sees.
 */
export interface DockerCommonOptions extends CommonSandboxOptions {
  volumes?: SandboxVolume[];
  resources?: DockerResources;
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

function dockerMountArg(volume: SandboxVolume): string {
  const readOnly = volume.readOnly !== false;
  const parts =
    volume.type === 'bind'
      ? ['type=bind', `src=${volume.hostPath}`, `dst=${volume.containerPath}`]
      : [
          'type=volume',
          `src=${volume.name}`,
          `dst=${volume.containerPath}`,
          ...(volume.subPath ? [`volume-subpath=${volume.subPath}`] : []),
          ...(volume.noCopy ? ['volume-nocopy'] : []),
        ];

  if (readOnly) {
    parts.push('readonly');
  }

  return parts.join(',');
}

/**
 * Runs `docker build`. An inline Dockerfile is piped to `docker build -f -` over
 * stdin (no shell, no quoting). With `showBuildLogs`, output streams live to the
 * parent terminal; otherwise it is buffered so the failure stderr can be
 * surfaced in a {@link DockerfileBuildError}.
 */
function runDockerBuild(
  args: string[],
  stdin: string | undefined,
  showBuildLogs: boolean,
): Promise<void> {
  const stdio: StdioOptions = [
    stdin === undefined ? 'inherit' : 'pipe',
    showBuildLogs ? 'inherit' : 'ignore',
    showBuildLogs ? 'inherit' : 'pipe',
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
          showBuildLogs
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

export const dockerEngine: ContainerEngine<DockerCommonOptions> = {
  cli: 'docker',

  runArgs(
    image: string,
    containerId: string,
    opts: DockerCommonOptions,
    workdir: string,
  ): string[] {
    const {
      memory = '1g',
      cpus = 2,
      memorySwap,
      shmSize,
      pidsLimit,
      ulimits = [],
      cpusetCpus,
      cpuShares,
    } = opts.resources ?? {};
    const security = opts.security ?? {};
    const network = opts.network ?? {};

    const args: string[] = [
      'run',
      '-d',
      '--rm',
      '--name',
      containerId,
      '--memory',
      memory,
      '--cpus',
      String(cpus),
      '-w',
      workdir,
    ];

    if (memorySwap) {
      args.push('--memory-swap', memorySwap);
    }
    if (shmSize) {
      args.push('--shm-size', shmSize);
    }
    if (pidsLimit !== undefined) {
      args.push('--pids-limit', String(pidsLimit));
    }
    for (const ulimit of ulimits) {
      args.push('--ulimit', ulimit);
    }
    if (cpusetCpus) {
      args.push('--cpuset-cpus', cpusetCpus);
    }
    if (cpuShares !== undefined) {
      args.push('--cpu-shares', String(cpuShares));
    }

    if (opts.platform) {
      args.push('--platform', opts.platform);
    }
    if (opts.runtime) {
      args.push('--runtime', opts.runtime);
    }

    for (const cap of security.capDrop ?? []) {
      args.push('--cap-drop', cap);
    }
    for (const cap of security.capAdd ?? []) {
      args.push('--cap-add', cap);
    }
    if (security.readOnly) {
      args.push('--read-only');
    }
    if (security.user) {
      args.push('--user', security.user);
    }
    for (const mount of security.tmpfs ?? []) {
      args.push('--tmpfs', mount);
    }
    for (const opt of security.securityOpt ?? []) {
      args.push('--security-opt', opt);
    }

    if (network.mode) {
      args.push('--network', network.mode);
    }
    for (const port of network.publish ?? []) {
      args.push('--publish', port);
    }
    for (const server of network.dns ?? []) {
      args.push('--dns', server);
    }
    for (const host of network.addHost ?? []) {
      args.push('--add-host', host);
    }
    if (network.hostname) {
      args.push('--hostname', network.hostname);
    }

    if (opts.gpus) {
      args.push('--gpus', opts.gpus);
    }
    for (const device of opts.devices ?? []) {
      args.push('--device', device);
    }
    if (opts.init) {
      args.push('--init');
    }
    for (const [key, value] of Object.entries(opts.labels ?? {})) {
      args.push('--label', `${key}=${value}`);
    }
    for (const [key, value] of Object.entries(opts.sysctls ?? {})) {
      args.push('--sysctl', `${key}=${value}`);
    }
    if (opts.entrypoint) {
      args.push('--entrypoint', opts.entrypoint);
    }

    for (const [key, value] of Object.entries(opts.env ?? {})) {
      args.push('-e', `${key}=${value}`);
    }

    for (const volume of opts.volumes ?? []) {
      args.push('--mount', dockerMountArg(volume));
    }

    args.push(image);
    if (opts.command === undefined) {
      args.push('tail', '-f', '/dev/null');
    } else if (opts.command !== null) {
      args.push(...opts.command);
    }

    return args;
  },

  execArgs(
    containerId: string,
    command: string,
    options?: { cwd?: string; env?: Record<string, string> },
  ): string[] {
    const flags: string[] = [];
    if (options?.cwd) {
      flags.push('-w', options.cwd);
    }
    if (options?.env) {
      for (const [key, value] of Object.entries(options.env)) {
        if (key.length === 0 || key.includes('=')) {
          throw new DockerSandboxError(
            `Invalid environment variable key: "${key}"`,
          );
        }
        flags.push('-e', `${key}=${value}`);
      }
    }
    return ['exec', ...flags, containerId, 'sh', '-c', command];
  },

  inspectArgs(containerId: string): string[] {
    return [
      'container',
      'inspect',
      '--format',
      '{{.State.Status}}',
      containerId,
    ];
  },

  mountArg: dockerMountArg,

  parseStatus(status: string): 'running' | 'stopped' | 'absent' {
    return status === 'running' ? 'running' : 'stopped';
  },

  volumeCreateArgs(volume: SandboxNamedVolume): string[] {
    const args = ['volume', 'create'];
    if (volume.driver) {
      args.push('--driver', volume.driver);
    }
    for (const [key, value] of Object.entries(volume.driverOptions ?? {})) {
      args.push('--opt', `${key}=${value}`);
    }
    args.push(volume.name);
    return args;
  },

  errorMessage(error: unknown): string {
    const err = error as SubprocessError;
    return err.stderr || err.stdout || err.message || String(error);
  },

  isServiceDown(message: string): boolean {
    return (
      message.includes('Cannot connect') || message.includes('docker daemon')
    );
  },

  isMissingContainer(message: string): boolean {
    return message.toLowerCase().includes('no such container');
  },

  isMissingVolume(message: string): boolean {
    return message.toLowerCase().includes('no such volume');
  },

  isNameConflict(message: string): boolean {
    return message.toLowerCase().includes('is already in use by container');
  },

  async ensureWorkdir(): Promise<void> {},

  defaultImage: 'alpine:latest',

  createInstallerContext,

  async imageExists(tag: string): Promise<boolean> {
    try {
      await spawn('docker', ['image', 'inspect', tag]);
      return true;
    } catch {
      return false;
    }
  },

  async buildImage(spec: ImageBuildSpec): Promise<void> {
    const inline = spec.dockerfile.includes('\n');
    const args = [
      'build',
      ...(spec.identity ? ['--platform', spec.identity] : []),
      '-t',
      spec.tag,
      '-f',
      inline ? '-' : spec.dockerfile,
      spec.context,
    ];
    await runDockerBuild(
      args,
      inline ? spec.dockerfile : undefined,
      spec.showBuildLogs,
    );
  },

  errors: {
    serviceNotAvailable: () => new DockerNotAvailableError(),
    creation: (message, image, cause) =>
      new ContainerCreationError(message, image, cause),
    generic: (message, containerId) =>
      new DockerSandboxError(message, containerId),
    volumePath: (source, containerPath, reason) =>
      new VolumePathError(source, containerPath, reason),
    volumeInspect: (name, reason) => new VolumeInspectError(name, reason),
    volumeCreate: (name, reason) => new VolumeCreateError(name, reason),
    volumeRemove: (name, reason) => new VolumeRemoveError(name, reason),
  },
};

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

export interface ComposeStrategyArgs {
  compose: string;
  service: string;
  resources?: DockerResources;
}

/**
 * Manages multi-container environments via `docker compose`. Docker-only — not
 * part of the engine bridge. Commands run inside the named service; `dispose()`
 * brings the whole stack down.
 */
export class ComposeStrategy extends ContainerSandboxStrategy {
  private projectName: string;
  private composeFile: string;
  private service: string;

  constructor(args: ComposeStrategyArgs) {
    super({ resources: args.resources }, dockerEngine);
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
      const err = error as SubprocessError;
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
      const err = error as SubprocessError;
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
  if (isComposeOptions(options)) {
    return new ComposeStrategy({
      compose: options.compose,
      service: options.service,
      resources: options.resources,
    }).create();
  }
  if (isDockerfileOptions(options)) {
    return new ContainerfileStrategy(options, dockerEngine, {
      dockerfile: options.dockerfile,
      context: options.context ?? '.',
      showBuildLogs: options.showBuildLogs ?? false,
      identity: options.platform,
    }).create();
  }
  return new RuntimeStrategy(options, dockerEngine, {
    image: options.image ?? dockerEngine.defaultImage,
    installers: options.installers ?? [],
  }).create();
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
