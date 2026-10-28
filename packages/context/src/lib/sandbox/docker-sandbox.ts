import {
  BindSourceNotFoundError,
  ConnectionFailedError,
  type Container,
  ContainerNotFoundError,
  type ContainerProcess,
  Docker,
  DockerError,
  type EngineApi,
  ImageNotFoundError,
  NameConflictError,
  NotAFileError,
  VolumeInUseError,
} from '@zukhruf/docker';
import spawn, { SubprocessError } from 'nano-spawn';
import { type StdioOptions, spawn as childSpawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import type {
  CommonSandboxOptions,
  ContainerEngine,
  ContainerErrorFactory,
  EngineContainer,
  ImageBuildSpec,
  RunResult,
  SandboxNamedVolume,
  SandboxResources,
  SandboxVolume,
} from './container-engine.ts';
import {
  type AcquiredContainer,
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
  type InstallerContext,
  createInstallerContext,
} from './installers/installer.ts';
import { shellQuote } from './shell-quote.ts';
import type {
  CommandResult,
  DisposableSandbox,
  ExecuteCommandOptions,
  ExitInfo,
  SandboxProcess,
  SpawnOptions,
} from './types.ts';

export type { CommandResult as ExecResult, Sandbox } from './types.ts';
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
  /** Container execution timeout in milliseconds; excludes Docker/SSH connection setup. */
  commandTimeout?: number;
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
  /** `--label` metadata on the container and any managed volumes it creates. */
  labels?: Record<string, string>;
  /** `--sysctl` — kernel parameters, emitted as `key=value` per entry. */
  sysctls?: Record<string, string>;
  /** `--entrypoint` — override the image `ENTRYPOINT`. */
  entrypoint?: string;
}

export interface RuntimeSandboxOptions extends DockerCommonOptions {
  /** Docker image to use (default: `'bash:5.3-alpine3.24'`). */
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
  /** Container execution timeout in milliseconds; excludes Docker/SSH connection setup. */
  commandTimeout?: number;
}

export type DockerSandboxOptions =
  RuntimeSandboxOptions | DockerfileSandboxOptions | ComposeSandboxOptions;

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

/** Container units `docker run` takes for sizes: a number with an optional binary unit. */
const SIZE_UNITS: Record<string, number> = {
  '': 1,
  k: 1024,
  m: 1024 ** 2,
  g: 1024 ** 3,
  t: 1024 ** 4,
  p: 1024 ** 5,
};

/** Bytes of a `docker run` size such as `'1g'`, `'512m'` or `'1073741824b'`. */
function sizeInBytes(flag: string, value: string): number {
  const match = /^(\d+(?:\.\d+)?)\s*([kmgtp]?)(?:i?b)?$/i.exec(value);
  if (!match) {
    throw new DockerSandboxError(`Invalid ${flag} size: "${value}"`);
  }
  return Math.floor(Number(match[1]) * SIZE_UNITS[match[2].toLowerCase()]);
}

/** A `--ulimit` entry such as `'nofile=1024:2048'` or `'nproc=64'`. */
function ulimit(value: string): EngineApi.Ulimit {
  const match = /^([a-z]+)=(-?\d+)(?::(-?\d+))?$/.exec(value);
  if (!match) {
    throw new DockerSandboxError(`Invalid ulimit: "${value}"`);
  }
  const soft = Number(match[2]);
  return {
    Name: match[1],
    Soft: soft,
    Hard: match[3] === undefined ? soft : Number(match[3]),
  };
}

/** A `--device` entry: `host[:container[:permissions]]`. */
function device(value: string): EngineApi.DeviceMapping {
  const [host, container = host, permissions = 'rwm'] = value.split(':');
  return {
    PathOnHost: host,
    PathInContainer: container,
    CgroupPermissions: permissions,
  };
}

/** The `--gpus` request: `'all'`, a count, or `'device=0,1'`. */
function gpuRequest(value: string): EngineApi.DeviceRequest {
  if (value === 'all') return { Count: -1, Capabilities: [['gpu']] };
  if (/^\d+$/.test(value)) {
    return { Count: Number(value), Capabilities: [['gpu']] };
  }
  const devices = /^device=(.+)$/.exec(value);
  if (devices) {
    return { DeviceIDs: devices[1].split(','), Capabilities: [['gpu']] };
  }
  throw new DockerSandboxError(`Invalid gpus value: "${value}"`);
}

/** A `--publish` entry: `[ip:][hostPort:]containerPort[/protocol]`. */
function publishedPort(value: string): {
  port: string;
  binding: EngineApi.PortBinding;
} {
  const [address, protocol = 'tcp'] = value.split('/');
  const parts = address.split(':');
  const containerPort = parts.pop();
  const hostPort = parts.pop() ?? '';
  const hostIp = parts.join(':');
  if (!containerPort || !/^\d+$/.test(containerPort)) {
    throw new DockerSandboxError(`Invalid publish value: "${value}"`);
  }
  return {
    port: `${containerPort}/${protocol}`,
    binding: { HostIp: hostIp, HostPort: hostPort },
  };
}

/**
 * A `--security-opt` entry as the engine takes it. The CLI reads a seccomp
 * profile from this machine and sends its JSON; the engine cannot read a path
 * on the client.
 */
function securityOption(entry: string): string {
  const match = /^seccomp[=:](.+)$/.exec(entry);
  if (!match || match[1] === 'unconfined') return entry;
  return `seccomp=${JSON.stringify(JSON.parse(readFileSync(match[1], 'utf-8')))}`;
}

function mount(volume: SandboxVolume): EngineApi.Mount {
  const ReadOnly = volume.readOnly !== false;
  if (volume.type === 'bind') {
    return {
      Type: 'bind',
      Source: volume.hostPath,
      Target: volume.containerPath,
      ReadOnly,
    };
  }
  return {
    Type: 'volume',
    Source: volume.name,
    Target: volume.containerPath,
    ReadOnly,
    ...(volume.subPath || volume.noCopy
      ? {
          VolumeOptions: {
            ...(volume.subPath ? { Subpath: volume.subPath } : {}),
            ...(volume.noCopy ? { NoCopy: true } : {}),
          },
        }
      : {}),
  };
}

/**
 * The body of `POST /containers/create` for a long-running sandbox container:
 * what `docker run -d --rm` sends for the same options.
 */
function containerCreateRequest(
  image: string,
  opts: DockerCommonOptions,
  workdir: string,
): EngineApi.ContainerCreateRequest {
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
  const published = (network.publish ?? []).map(publishedPort);

  return {
    Image: image,
    WorkingDir: workdir,
    Env: Object.entries(opts.env ?? {}).map(
      ([key, value]) => `${key}=${value}`,
    ),
    Labels: opts.labels ?? {},
    ...(opts.command === undefined
      ? { Cmd: ['tail', '-f', '/dev/null'] }
      : opts.command === null || opts.command.length === 0
        ? {}
        : { Cmd: [...opts.command] }),
    ...(opts.entrypoint === undefined ? {} : { Entrypoint: [opts.entrypoint] }),
    ...(security.user ? { User: security.user } : {}),
    ...(network.hostname ? { Hostname: network.hostname } : {}),
    ExposedPorts: Object.fromEntries(published.map(({ port }) => [port, {}])),
    HostConfig: {
      AutoRemove: true,
      Memory: sizeInBytes('memory', memory),
      NanoCpus: Math.round(cpus * 1e9),
      ...(memorySwap
        ? {
            MemorySwap:
              memorySwap === '-1' ? -1 : sizeInBytes('memorySwap', memorySwap),
          }
        : {}),
      ...(shmSize ? { ShmSize: sizeInBytes('shmSize', shmSize) } : {}),
      ...(pidsLimit === undefined ? {} : { PidsLimit: pidsLimit }),
      Ulimits: ulimits.map(ulimit),
      ...(cpusetCpus ? { CpusetCpus: cpusetCpus } : {}),
      ...(cpuShares === undefined ? {} : { CpuShares: cpuShares }),
      ...(opts.runtime ? { Runtime: opts.runtime } : {}),
      CapDrop: security.capDrop ?? [],
      CapAdd: security.capAdd ?? [],
      ReadonlyRootfs: security.readOnly === true,
      Tmpfs: Object.fromEntries(
        (security.tmpfs ?? []).map((entry) => {
          const separator = entry.indexOf(':');
          return separator < 0
            ? [entry, '']
            : [entry.slice(0, separator), entry.slice(separator + 1)];
        }),
      ),
      SecurityOpt: (security.securityOpt ?? []).map(securityOption),
      ...(network.mode ? { NetworkMode: network.mode } : {}),
      PortBindings: published.reduce<Record<string, EngineApi.PortBinding[]>>(
        (bindings, { port, binding }) => ({
          ...bindings,
          [port]: [...(bindings[port] ?? []), binding],
        }),
        {},
      ),
      Dns: network.dns ?? [],
      ExtraHosts: network.addHost ?? [],
      ...(opts.gpus ? { DeviceRequests: [gpuRequest(opts.gpus)] } : {}),
      Devices: (opts.devices ?? []).map(device),
      ...(opts.init ? { Init: true } : {}),
      Sysctls: opts.sysctls ?? {},
      Mounts: (opts.volumes ?? []).map(mount),
    },
  };
}

/**
 * Runs `docker build`. An inline Dockerfile is piped to `docker build -f -` over
 * stdin (no shell, no quoting). With `showBuildLogs`, output streams live to the
 * parent terminal; otherwise it is buffered so the failure stderr can be
 * surfaced in a {@link DockerfileBuildError}. `env` sends the CLI to the
 * engine of the sandbox.
 */
function runDockerBuild(
  args: string[],
  stdin: string | undefined,
  showBuildLogs: boolean,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const stdio: StdioOptions = [
    stdin === undefined ? 'inherit' : 'pipe',
    showBuildLogs ? 'inherit' : 'ignore',
    showBuildLogs ? 'inherit' : 'pipe',
  ];

  return new Promise((resolve, reject) => {
    const child = childSpawn('docker', args, { stdio, env });

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

/** Maps an unreachable engine to {@link DockerNotAvailableError}. */
function unavailable(error: unknown): never {
  if (error instanceof ConnectionFailedError) {
    throw new DockerNotAvailableError();
  }
  throw error;
}

/** Docker Desktop reports bind sources as VM paths and resolves macOS's root symlinks. */
function isBindSource(reported: string, hostPath: string): boolean {
  const canonical = hostPath.replace(/^\/(tmp|var|etc)(?=\/|$)/, '/private/$1');
  return [hostPath, `/host_mnt${hostPath}`, `/host_mnt${canonical}`].includes(
    reported,
  );
}

const dockerErrors: ContainerErrorFactory = {
  generic: (message, containerId) =>
    new DockerSandboxError(message, containerId),
  volumePath: (source, containerPath, reason) =>
    new VolumePathError(source, containerPath, reason),
  volumeInspect: (name, reason) => new VolumeInspectError(name, reason),
  volumeCreate: (name, reason) => new VolumeCreateError(name, reason),
};
/** The CLI dropped one final newline; the sandbox contract keeps dropping it. */
function withoutFinalNewline(text: string): string {
  return text.replace(/\r?\n$/, '');
}

/**
 * The output of a container process as two streams and an exit. The chunks
 * queue until their stream is read, so a reader of one stream never blocks the
 * other.
 */
function sandboxProcess(process: ContainerProcess): SandboxProcess {
  const queue = { highWaterMark: Number.POSITIVE_INFINITY };
  const stdout = new TransformStream<Uint8Array, Uint8Array>(
    undefined,
    undefined,
    queue,
  );
  const stderr = new TransformStream<Uint8Array, Uint8Array>(
    undefined,
    undefined,
    queue,
  );
  const writers = {
    stdout: stdout.writable.getWriter(),
    stderr: stderr.writable.getWriter(),
  };

  const exit = (async (): Promise<ExitInfo> => {
    try {
      for await (const { stream, data } of process) {
        await writers[stream].write(data);
      }
    } catch (error) {
      await Promise.all([
        writers.stdout.abort(error),
        writers.stderr.abort(error),
      ]);
      throw error;
    }
    await Promise.all([writers.stdout.close(), writers.stderr.close()]);
    const code = await process.exitCode;
    return { code, signal: null, success: code === 0 };
  })();

  return { stdout: stdout.readable, stderr: stderr.readable, exit };
}

/**
 * Wraps `command` so the sandbox can stop it: the container has no request
 * that stops an exec, so the wrapper writes the command's process group to
 * `controlPath` for a later exec to kill, and enforces `commandTimeout` itself.
 */
function managedDockerCommand(
  command: string,
  controlPath: string,
  commandTimeout?: number,
): string {
  return [
    'set -m',
    `control=${shellQuote(controlPath)}`,
    ': > "$control" || exit 1',
    'timer=',
    'trap \'if [ -n "$timer" ]; then kill -TERM "$timer" 2>/dev/null || :; wait "$timer" 2>/dev/null || :; fi; rm -f "$control" "$control.timeout"\' EXIT',
    `bash -lc ${shellQuote(command)} &`,
    'pid=$!',
    'printf \'%s\\n\' "$pid" > "$control"',
    ...(commandTimeout
      ? [
          // Keep the deadline on the engine host: SSH setup/round trips must not
          // let the command run past its execution budget.
          '(',
          `sleep ${commandTimeout / 1000} &`,
          'alarm=$!',
          'trap \'kill "$alarm" 2>/dev/null || :; wait "$alarm" 2>/dev/null || :; exit 0\' TERM',
          'wait "$alarm" || exit',
          'if kill -0 -- "-$pid" 2>/dev/null; then : > "$control.timeout"; kill -KILL -- "-$pid" 2>/dev/null || :; fi',
          ') &',
          'timer=$!',
        ]
      : []),
    'wait "$pid"',
    'status=$?',
    '[ ! -e "$control.timeout" ] || exit 124',
    'exit "$status"',
  ].join('\n');
}

/** Symbolic links a path may pass through before a read gives up, as Linux's ELOOP limit. */
const MAX_SYMLINK_HOPS = 40;

/** The kernel filesystems, which the archive requests cannot reach. */
const KERNEL_FILESYSTEMS = ['/proc', '/sys', '/dev'];

/** Where the files of a container are, for the archive requests. */
interface FileLayout {
  /** Relative sandbox paths resolve here, as they did in an exec's shell. */
  workdir: string;
  /** Paths only an exec reaches: tmpfs mounts and the kernel filesystems. */
  execOnly: string[];
  /** The numeric `uid[:gid]` of the container user, so its written files are its own. */
  owner: { uid?: number; gid?: number };
}

/** The layout of a container from its configuration, as created or inspected. */
function fileLayout(
  config: EngineApi.ContainerConfig | undefined,
  hostConfig: EngineApi.HostConfig | undefined,
): FileLayout {
  const user = /^(\d+)(?::(\d+))?$/.exec(config?.User ?? '');
  return {
    workdir: config?.WorkingDir || '/',
    execOnly: [...KERNEL_FILESYSTEMS, ...Object.keys(hostConfig?.Tmpfs ?? {})],
    owner: user
      ? {
          uid: Number(user[1]),
          ...(user[2] === undefined ? {} : { gid: Number(user[2]) }),
        }
      : {},
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A sandbox container on the Docker engine. */
class DockerContainer implements EngineContainer {
  readonly name: string;
  readonly #container: Container;
  readonly #layout: FileLayout;
  readonly #commandTimeout: number | undefined;

  constructor(
    name: string,
    container: Container,
    layout: FileLayout,
    commandTimeout: number | undefined,
  ) {
    this.name = name;
    this.#container = container;
    this.#layout = layout;
    this.#commandTimeout = commandTimeout;
  }

  /** `command` under `bash -lc`, with the spawn options' directory and environment. */
  #bash(command: string, options: SpawnOptions = {}): EngineApi.ExecConfig {
    const env = Object.entries(options.env ?? {}).map(([key, value]) => {
      if (key.length === 0 || key.includes('=')) {
        throw new DockerSandboxError(
          `Invalid environment variable key: "${key}"`,
        );
      }
      return `${key}=${value}`;
    });
    return {
      Cmd: ['bash', '-lc', command],
      Env: env,
      ...(options.cwd ? { WorkingDir: options.cwd } : {}),
    };
  }

  async #exec(config: EngineApi.ExecConfig): Promise<CommandResult> {
    try {
      const { stdout, stderr, exitCode } = await this.#container.exec(config);
      return {
        stdout: withoutFinalNewline(stdout),
        stderr: withoutFinalNewline(stderr),
        exitCode,
      };
    } catch (error) {
      if (!(error instanceof DockerError)) throw error;
      // As with `docker exec`: a command the engine cannot run is a failed
      // command, not a thrown error.
      return { stdout: '', stderr: error.message, exitCode: 1 };
    }
  }

  async executeCommand(
    command: string,
    options: ExecuteCommandOptions = {},
  ): Promise<CommandResult> {
    if (!this.#commandTimeout && options.signal === undefined) {
      return this.#exec(this.#bash(command));
    }

    const process = await this.spawn(command, { signal: options.signal });
    const [stdout, stderr, info] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exit,
    ]);
    const result = {
      stdout: withoutFinalNewline(stdout),
      stderr: withoutFinalNewline(stderr),
    };
    if (info.signal === 'SIGKILL') {
      return {
        ...result,
        stderr: result.stderr || 'Command aborted',
        exitCode: 1,
      };
    }
    return { ...result, exitCode: info.code ?? 1 };
  }

  async spawn(
    command: string,
    options: SpawnOptions = {},
  ): Promise<SandboxProcess> {
    if (!this.#commandTimeout && options.signal === undefined) {
      return sandboxProcess(
        await this.#container.spawn(this.#bash(command, options)),
      );
    }

    const controlPath = `/dev/shm/deepagents-exec-${randomUUID()}.pid`;
    const execution = sandboxProcess(
      await this.#container.spawn(
        this.#bash(
          managedDockerCommand(command, controlPath, this.#commandTimeout),
          options,
        ),
      ),
    );
    let termination: Promise<boolean> | undefined;
    const onAbort = () => {
      termination ??= this.#terminate(controlPath, execution.exit);
      // Observe transport failures immediately; the exit promise still reports
      // the original rejection once the command's transport finishes.
      void termination.catch(() => {});
    };
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener('abort', onAbort, { once: true });

    return {
      stdout: execution.stdout,
      stderr: execution.stderr,
      exit: execution.exit
        .then(async (info) => {
          const activeTermination = termination;
          if (!activeTermination || !(await activeTermination)) {
            return info;
          }
          return { code: null, signal: 'SIGKILL' as const, success: false };
        })
        .finally(() => {
          options.signal?.removeEventListener('abort', onAbort);
        }),
    };
  }

  /** The PID that the managed command wrote, or `undefined` once it exited. */
  async #managedPid(
    controlPath: string,
    exit: Promise<unknown>,
  ): Promise<number | undefined> {
    const exited = exit.then(
      () => true,
      () => true,
    );
    const readPid = `if IFS= read -r pid < ${shellQuote(controlPath)}; then printf '%s' "$pid"; fi`;

    while (true) {
      const { stdout } = await this.#container.exec(this.#bash(readPid));
      if (stdout) return Number(stdout);
      if (await Promise.race([exited, delay(10).then(() => false)])) {
        return undefined;
      }
    }
  }

  /** Kills the managed command's process group; `true` when it was still running. */
  async #terminate(
    controlPath: string,
    exit: Promise<unknown>,
  ): Promise<boolean> {
    const pid = await this.#managedPid(controlPath, exit);
    if (pid === undefined) return false;

    const { stdout } = await this.#container.exec(
      this.#bash(
        [
          `pid=${pid}`,
          `IFS= read -r control_pid < ${shellQuote(controlPath)} || exit 0`,
          '[ "$control_pid" = "$pid" ] || exit 0',
          'kill -KILL -- "-$pid" 2>/dev/null || exit 0',
          'group_alive() {',
          '  local stat rest state pgrp',
          '  for stat_path in /proc/[0-9]*/stat; do',
          '    IFS= read -r stat < "$stat_path" || continue',
          '    rest=${stat##*) }',
          '    read -r state _ pgrp _ <<< "$rest"',
          '    if [ "$pgrp" = "$pid" ] && [ "$state" != Z ]; then return 0; fi',
          '  done',
          '  return 1',
          '}',
          'while group_alive; do sleep 0.01; done',
          'printf terminated',
        ].join('\n'),
      ),
    );
    return stdout === 'terminated';
  }

  #resolve(path: string): string {
    return posix.resolve(this.#layout.workdir, path);
  }

  /** The archive requests cannot reach a tmpfs mount or a kernel filesystem. */
  #isExecOnly(path: string): boolean {
    return this.#layout.execOnly.some(
      (root) => path === root || path.startsWith(`${root}/`),
    );
  }

  async readFile(path: string): Promise<Uint8Array> {
    const target = this.#resolve(path);
    try {
      return this.#isExecOnly(target)
        ? await this.#readByExec(target)
        : await this.#readArchive(target);
    } catch (error) {
      throw new Error(`Failed to read file "${path}": ${messageOf(error)}`, {
        cause: error,
      });
    }
  }

  /** Follows symbolic links, as reading through the container's shell does. */
  async #readArchive(path: string): Promise<Uint8Array> {
    let target = path;
    for (let hops = 0; ; hops++) {
      try {
        return await this.#container.readFile(target);
      } catch (error) {
        if (
          !(error instanceof NotAFileError && error.kind === 'symlink') ||
          hops === MAX_SYMLINK_HOPS
        ) {
          throw error;
        }
        const stat = await this.#container.stat(target);
        if (!stat) throw error;
        target = posix.resolve(posix.dirname(target), stat.linkTarget);
      }
    }
  }

  async #readByExec(path: string): Promise<Uint8Array> {
    const process = await this.#container.spawn({ Cmd: ['cat', '--', path] });
    const stdout: Uint8Array[] = [];
    const stderr: Uint8Array[] = [];
    for await (const { stream, data } of process) {
      (stream === 'stdout' ? stdout : stderr).push(data);
    }
    if ((await process.exitCode) !== 0) {
      throw new Error(Buffer.concat(stderr).toString('utf-8').trim());
    }
    return Buffer.concat(stdout);
  }

  async writeFiles(
    files: Array<{ path: string; content: string | Buffer }>,
  ): Promise<void> {
    const resolved = files.map(({ path, content }) => ({
      path: this.#resolve(path),
      content,
    }));
    const byArchive = resolved.filter(({ path }) => !this.#isExecOnly(path));
    if (byArchive.length > 0) {
      try {
        await this.#container.writeFiles(
          byArchive.map(({ path, content }) => ({
            path,
            data: content,
            ...this.#layout.owner,
          })),
        );
      } catch (error) {
        throw new Error(
          `Failed to write file "${byArchive.map(({ path }) => path).join('", "')}": ${messageOf(error)}`,
          { cause: error },
        );
      }
    }

    for (const { path, content } of resolved.filter(({ path }) =>
      this.#isExecOnly(path),
    )) {
      const result = await this.#container.exec(
        {
          Cmd: [
            'sh',
            '-c',
            'mkdir -p "$(dirname "$1")" && cat > "$1"',
            'sh',
            path,
          ],
        },
        { stdin: content },
      );
      if (result.exitCode !== 0) {
        throw new Error(`Failed to write file "${path}": ${result.stderr}`);
      }
    }
  }

  async exists(path: string): Promise<boolean> {
    let target = this.#resolve(path);
    if (this.#isExecOnly(target)) {
      const { exitCode } = await this.#container.exec({
        Cmd: ['test', '-e', target],
      });
      return exitCode === 0;
    }
    for (let hops = 0; hops <= MAX_SYMLINK_HOPS; hops++) {
      const stat = await this.#container.stat(target);
      if (!stat) return false;
      if (stat.linkTarget === '') return true;
      target = posix.resolve(posix.dirname(target), stat.linkTarget);
    }
    // A symbolic link loop, which `test -e` also reports as missing.
    return false;
  }

  installerContext(image: string): InstallerContext {
    return createInstallerContext(
      {
        // Installers run with `sh -c`, before the sandbox knows Bash exists.
        exec: (command) => this.#exec({ Cmd: ['sh', '-c', command] }),
        SandboxError: DockerSandboxError,
      },
      this.name,
      image,
    );
  }

  async start(image: string): Promise<void> {
    try {
      await this.#container.start();
    } catch (error) {
      if (error instanceof ConnectionFailedError) {
        throw new DockerNotAvailableError();
      }
      throw new ContainerCreationError(
        error instanceof Error ? error.message : String(error),
        image,
        error instanceof Error ? error : undefined,
      );
    }
  }

  async stop(): Promise<void> {
    try {
      await this.#container.stop();
    } catch (error) {
      // The container is gone: AutoRemove removed it, or another handle of a
      // named sandbox stopped it first.
      if (error instanceof ContainerNotFoundError) return;
      throw error;
    }
  }
}

/**
 * The Docker engine, reached through the Engine API of `@zukhruf/docker`. It
 * selects the engine that the Docker CLI selects (`DOCKER_HOST`,
 * `DOCKER_CONTEXT`, the current context), so a remote SSH context works as it
 * does for the CLI. Image builds and Compose stay on the CLI, sent to the same
 * engine through `docker.cliEnvironment`.
 */
export class DockerEngine implements ContainerEngine<DockerCommonOptions> {
  readonly bindMountsOnClient = false;
  readonly defaultImage = 'bash:5.3-alpine3.24';
  readonly errors = dockerErrors;
  readonly docker: Docker;
  /** The environment of a docker CLI process that targets this engine. */
  readonly cliEnv: NodeJS.ProcessEnv;
  readonly #commandTimeout: number | undefined;

  private constructor(docker: Docker, commandTimeout: number | undefined) {
    this.docker = docker;
    this.cliEnv = { ...process.env, ...docker.cliEnvironment };
    this.#commandTimeout = commandTimeout;
  }

  /**
   * Connects to the engine that the Docker CLI selects from `process.env`.
   * `commandTimeout` bounds each command of the sandbox's containers.
   */
  static async connect(
    commandTimeout: number | undefined,
  ): Promise<DockerEngine> {
    const docker = await Docker.connect({ environment: process.env }).catch(
      unavailable,
    );
    return new DockerEngine(docker, commandTimeout);
  }

  /** A sandbox container handle for a container of this engine. */
  container(
    name: string,
    container: Container,
    info: Pick<EngineApi.ContainerInspectResponse, 'Config' | 'HostConfig'>,
  ): DockerContainer {
    return new DockerContainer(
      name,
      container,
      fileLayout(info.Config, info.HostConfig),
      this.#commandTimeout,
    );
  }

  async attach(
    name: string,
    image: string,
  ): Promise<DockerContainer | undefined> {
    const found = await this.docker.containers.find(name).catch(unavailable);
    if (!found) return undefined;
    const info = await found.inspect();
    const container = this.container(name, found, info);
    if (info.State?.Status !== 'running') {
      await container.start(image);
    }
    return container;
  }

  async run(
    image: string,
    name: string,
    opts: DockerCommonOptions,
    workdir: string,
  ): Promise<RunResult> {
    try {
      const body = containerCreateRequest(image, opts, workdir);
      const create = () =>
        this.docker.containers.createOrGet(body, {
          name,
          platform: opts.platform,
        });
      const result = await create().catch(async (error: unknown) => {
        if (!(error instanceof ImageNotFoundError)) throw error;
        await this.docker.images.pull(image, { platform: opts.platform });
        return create();
      });
      if (!result.created) return { created: false };
      try {
        await result.container.start();
      } catch (error) {
        await result.container[Symbol.asyncDispose]();
        throw error;
      }
      return {
        created: true,
        container: this.container(name, result.container, {
          Config: body,
          HostConfig: body.HostConfig,
        }),
      };
    } catch (error) {
      throw this.#runError(error, image, opts.volumes ?? []);
    }
  }

  #runError(error: unknown, image: string, volumes: SandboxVolume[]): Error {
    if (error instanceof ConnectionFailedError) {
      return new DockerNotAvailableError();
    }
    if (error instanceof BindSourceNotFoundError) {
      const volume = volumes.find(
        (candidate) =>
          candidate.type === 'bind' &&
          isBindSource(error.source, candidate.hostPath),
      );
      if (volume) {
        return new VolumePathError(
          error.source,
          volume.containerPath,
          'hostPath does not exist on host',
        );
      }
    }
    return new ContainerCreationError(
      error instanceof Error ? error.message : String(error),
      image,
      error instanceof Error ? error : undefined,
    );
  }

  async volumeExists(name: string): Promise<boolean> {
    try {
      return (await this.docker.volumes.find(name)) !== undefined;
    } catch (error) {
      if (error instanceof ConnectionFailedError) {
        throw new DockerNotAvailableError();
      }
      throw new VolumeInspectError(
        name,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  async createVolume(
    volume: SandboxNamedVolume,
    opts: DockerCommonOptions,
  ): Promise<void> {
    try {
      await this.docker.volumes.create({
        Name: volume.name,
        Labels: opts.labels ?? {},
        ...(volume.driver ? { Driver: volume.driver } : {}),
        DriverOpts: volume.driverOptions ?? {},
      });
    } catch (error) {
      if (error instanceof ConnectionFailedError) {
        throw new DockerNotAvailableError();
      }
      throw new VolumeCreateError(
        volume.name,
        error instanceof NameConflictError
          ? 'managed volume already exists'
          : error instanceof Error
            ? error.message
            : String(error),
      );
    }
  }

  async removeVolume(name: string): Promise<void> {
    // AutoRemove releases the container's volume references after stop
    // returns, so the volume stays in use for a moment.
    const deadline = performance.now() + 30_000;
    while (true) {
      try {
        await this.docker.volumes.find(name).then((volume) => volume?.remove());
        return;
      } catch (error) {
        if (error instanceof VolumeInUseError && performance.now() < deadline) {
          await delay(25);
          continue;
        }
        if (error instanceof ConnectionFailedError) {
          throw new DockerNotAvailableError();
        }
        throw new VolumeRemoveError(
          name,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  }

  async ensureWorkdir(): Promise<void> {}

  async imageExists(tag: string): Promise<boolean> {
    return (await this.docker.images.inspect(tag)) !== undefined;
  }

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
      this.cliEnv,
    );
  }

  dispose(): Promise<void> {
    return this.docker[Symbol.asyncDispose]();
  }
}

export interface ComposeStrategyArgs {
  compose: string;
  service: string;
  resources?: DockerResources;
}

/**
 * Manages multi-container environments via `docker compose`. Docker-only — the
 * stack starts and stops through the Compose CLI, sent to the engine of
 * `engine`; commands and files reach the named service's container through
 * the Engine API. `dispose()` brings the whole stack down.
 */
export class ComposeStrategy extends ContainerSandboxStrategy<DockerCommonOptions> {
  private projectName: string;
  private composeFile: string;
  private service: string;
  private dockerEngine: DockerEngine;

  constructor(args: ComposeStrategyArgs, engine: DockerEngine) {
    super({ resources: args.resources }, engine);
    this.dockerEngine = engine;
    this.composeFile = args.compose;
    this.service = args.service;
    this.projectName = this.computeProjectName();
  }

  private computeProjectName(): string {
    const content = readFileSync(this.composeFile, 'utf-8');
    const hash = createHash('sha256').update(content).digest('hex').slice(0, 8);
    return `sandbox-${hash}`;
  }

  private compose(command: string[]): Promise<unknown> {
    return spawn(
      'docker',
      ['compose', '-f', this.composeFile, '-p', this.projectName, ...command],
      { env: this.dockerEngine.cliEnv },
    );
  }

  protected async getImage(): Promise<string> {
    return '';
  }

  protected override async acquireContainer(): Promise<AcquiredContainer> {
    try {
      await this.compose(['up', '-d']);
    } catch (error) {
      throw new ComposeStartError(
        this.composeFile,
        (error instanceof SubprocessError && error.stderr) ||
          (error instanceof Error ? error.message : String(error)),
      );
    }

    const { containers } = this.dockerEngine.docker;
    const [summary] = await containers.list({
      filters: {
        label: [
          `com.docker.compose.project=${this.projectName}`,
          `com.docker.compose.service=${this.service}`,
        ],
      },
    });
    const container = summary && (await containers.find(summary.Id));
    if (!container) {
      await this.compose(['down']).catch(() => {});
      throw new ComposeStartError(
        this.composeFile,
        `service "${this.service}" has no running container`,
      );
    }
    return {
      container: this.dockerEngine.container(
        this.projectName,
        container,
        await container.inspect(),
      ),
      attached: false,
    };
  }

  protected async configure(): Promise<void> {
    // Compose file is the source of truth.
  }

  protected override async release(): Promise<void> {
    // Cleanup errors are ignored: the stack may already be down.
    await this.compose(['down']).catch(() => {});
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
 *   image: 'bash:5.3-alpine3.24',
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
 *     FROM bash:5.3-alpine3.24
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
  const engine = await DockerEngine.connect(options.commandTimeout);
  let strategy: ContainerSandboxStrategy<DockerCommonOptions>;
  try {
    if (isComposeOptions(options)) {
      strategy = new ComposeStrategy(
        {
          compose: options.compose,
          service: options.service,
          resources: options.resources,
        },
        engine,
      );
    } else if (isDockerfileOptions(options)) {
      strategy = new ContainerfileStrategy(options, engine, {
        dockerfile: options.dockerfile,
        context: options.context ?? '.',
        showBuildLogs: options.showBuildLogs ?? false,
        identity: options.platform,
      });
    } else {
      strategy = new RuntimeStrategy(options, engine, {
        image: options.image ?? engine.defaultImage,
        installers: options.installers ?? [],
      });
    }
  } catch (error) {
    await engine.dispose();
    throw error;
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
