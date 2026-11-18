import type { Experimental_SandboxFileStat } from '@ai-sdk/provider-utils';
import {
  BindSourceNotFoundError,
  ConnectionFailedError,
  type Container,
  ContainerNotFoundError,
  type ContainerProcess,
  Docker,
  DockerEngineError,
  DockerError,
  type EngineApi,
  type Environment,
  ImageNotFoundError,
  NameConflictError,
  NotAFileError,
  type OwnedContainer,
  PathNotFoundError,
} from '@zukhruf/docker';
import spawn, { SubprocessError } from 'nano-spawn';
import { hash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { posix } from 'node:path';

import type {
  CommonSandboxOptions,
  ContainerEngine,
  ContainerErrorFactory,
  EngineContainer,
  EngineExecOptions,
  EngineProcess,
  EngineProcessOptions,
  EngineSpawnOptions,
  ImageBuildSpec,
  RunResult,
  SandboxBindVolume,
  SandboxNamedVolume,
  SandboxVolume,
} from './container-engine.ts';
import {
  type AcquiredContainer,
  ContainerSandboxStrategy,
  ContainerfileStrategy,
  RuntimeStrategy,
  validateSandboxOptions,
} from './container-sandbox.ts';
import {
  readFileOverExec,
  statOverExec,
  writeFileOverExec,
} from './container-session.ts';
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
import type { CommandResult, DisposableSandbox } from './types.ts';

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

/**
 * The part of the Engine API create body that a Docker sandbox passes through:
 * every field the sandbox does not own. The sandbox sets `Image` from `image`
 * or `dockerfile`, `WorkingDir` from `workdir`, `Env` from `env` and `Cmd`
 * from `command`. `HostConfig.AutoRemove` follows who created the container,
 * and `HostConfig.Mounts` comes from `volumes`. `Labels` also go on the managed
 * volumes that the sandbox creates.
 */
export type DockerContainerConfig = Omit<
  EngineApi.ContainerCreateRequest,
  'Image' | 'WorkingDir' | 'Env' | 'Cmd' | 'HostConfig'
> & {
  HostConfig?: Omit<EngineApi.HostConfig, 'AutoRemove' | 'Mounts'>;
};

/** What the Docker engine reads, beside what the shared skeleton reads. */
export interface DockerCommonOptions extends CommonSandboxOptions {
  /**
   * The environment whose `DOCKER_HOST`, `DOCKER_CONTEXT` and `DOCKER_CONFIG`
   * select the engine, as they do for the Docker CLI. Default: `process.env`.
   */
  environment?: Environment;
  volumes?: SandboxVolume[];
  /** Container execution timeout in milliseconds; excludes Docker/SSH connection setup. */
  commandTimeout?: number;
  /**
   * The platform of the container (e.g. `'linux/amd64'`), emulated when it
   * differs from the engine's. The Dockerfile strategy also builds for it and
   * folds it into the image-build cache key.
   */
  platform?: string;
  /**
   * The create body of the container, as `@zukhruf/docker` takes it: limits,
   * capabilities, user, network, devices, OCI runtime. The sandbox adds no
   * limit of its own, so the engine's defaults apply to what this leaves out.
   */
  container?: DockerContainerConfig;
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
  /**
   * The environment whose `DOCKER_HOST`, `DOCKER_CONTEXT` and `DOCKER_CONFIG`
   * select the engine, as they do for the Docker CLI. Default: `process.env`.
   */
  environment?: Environment;
  compose: string;
  service: string;
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

/** The body of `POST /containers/create` for a sandbox container. */
function containerCreateRequest(
  image: string,
  opts: DockerCommonOptions,
  workdir: string,
): EngineApi.ContainerCreateRequest {
  const { HostConfig, ...config } = opts.container ?? {};
  return {
    ...config,
    Image: image,
    WorkingDir: workdir,
    Env: Object.entries(opts.env ?? {}).map(
      ([key, value]) => `${key}=${value}`,
    ),
    ...(opts.command === undefined
      ? { Cmd: ['tail', '-f', '/dev/null'] }
      : opts.command === null || opts.command.length === 0
        ? {}
        : { Cmd: [...opts.command] }),
    HostConfig: {
      ...HostConfig,
      AutoRemove: true,
      Mounts: (opts.volumes ?? []).map(mount),
    },
  };
}

/** Starts a stopped container of a named sandbox; `image` names the request in an error. */
async function startContainer(
  container: Container,
  image: string,
): Promise<void> {
  try {
    await container.start();
  } catch (error) {
    if (error instanceof ConnectionFailedError) {
      throw new DockerNotAvailableError();
    }
    throw new ContainerCreationError(
      messageOf(error),
      image,
      Error.isError(error) ? error : undefined,
    );
  }
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

/**
 * The output of a container process as two streams and an exit. The chunks
 * queue until their stream is read, so a reader of one stream never blocks the
 * other.
 */
function engineProcess(process: ContainerProcess): EngineProcess {
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

  const exitCode = (async (): Promise<number> => {
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
    return process.exitCode;
  })();

  return {
    stdout: stdout.readable,
    stderr: stderr.readable,
    ...(process.stdin ? { stdin: process.stdin } : {}),
    exitCode,
  };
}

/** The kernel filesystems, which the archive requests cannot reach. */
const KERNEL_FILESYSTEMS = ['/proc', '/sys', '/dev'];

/** Where the files of a container are, for the archive requests. */
interface FileLayout {
  /** Relative sandbox paths resolve here, as they do in an exec's shell. */
  workdir: string;
  /** Paths only an exec reaches: tmpfs mounts and the kernel filesystems. */
  execOnly: string[];
}

/** The layout of a container from its configuration, as created or inspected. */
function fileLayout(
  config: EngineApi.ContainerConfig | undefined,
  hostConfig: EngineApi.HostConfig | undefined,
): FileLayout {
  return {
    workdir: config?.WorkingDir || '/',
    execOnly: [...KERNEL_FILESYSTEMS, ...Object.keys(hostConfig?.Tmpfs ?? {})],
  };
}

function messageOf(error: unknown): string {
  return Error.isError(error) ? error.message : String(error);
}

/**
 * The engine answers 500 for a path under a file and for a symbolic link loop,
 * and an answer to the stat has no body to tell them apart. The shell can.
 */
function isUnexplainedFailure(error: unknown): boolean {
  return error instanceof DockerEngineError && error.status === 500;
}

/** The kind of a path, from the type bits of Go's FileMode in `ContainerPathStat.mode`. */
function fileType(mode: number): Experimental_SandboxFileStat['type'] {
  const DIRECTORY = 0x80000000;
  const LINK_DEVICE_PIPE_SOCKET_IRREGULAR = 0x0f280000;
  if ((mode & DIRECTORY) !== 0) return 'directory';
  return (mode & LINK_DEVICE_PIPE_SOCKET_IRREGULAR) === 0 ? 'file' : 'other';
}

/** A sandbox container on the Docker engine. */
class DockerContainer implements EngineContainer {
  readonly name: string;
  readonly workdir: string;
  readonly commandTimeout: number | undefined;
  readonly #container: Container;
  readonly #execOnly: string[];
  readonly #autoRemove: boolean;

  constructor(
    name: string,
    container: Container,
    layout: FileLayout,
    commandTimeout: number | undefined,
    autoRemove: boolean,
  ) {
    this.name = name;
    this.workdir = layout.workdir;
    this.commandTimeout = commandTimeout;
    this.#container = container;
    this.#execOnly = layout.execOnly;
    this.#autoRemove = autoRemove;
  }

  #config(
    argv: string[],
    { workingDirectory, env = {} }: EngineProcessOptions,
  ): EngineApi.ExecConfig {
    return {
      Cmd: argv,
      Env: Object.entries(env).map(([key, value]) => `${key}=${value}`),
      ...(workingDirectory ? { WorkingDir: workingDirectory } : {}),
    };
  }

  async exec(
    argv: string[],
    options: EngineExecOptions = {},
  ): Promise<CommandResult> {
    try {
      const { stdout, stderr, exitCode } = await this.#container.exec(
        this.#config(argv, options),
        { signal: options.signal, stdin: options.stdin },
      );
      return { stdout, stderr, exitCode };
    } catch (error) {
      if (!(error instanceof DockerError)) throw error;
      // As with `docker exec`: a command the engine cannot run is a failed
      // command, not a thrown error.
      return { stdout: '', stderr: error.message, exitCode: 1 };
    }
  }

  async spawn(
    argv: string[],
    options: EngineSpawnOptions,
  ): Promise<EngineProcess> {
    return engineProcess(
      await this.#container.spawn(this.#config(argv, options), {
        stdin: options.stdin,
      }),
    );
  }

  #resolve(path: string): string {
    return posix.resolve(this.workdir, path);
  }

  /** The archive requests cannot reach a tmpfs mount or a kernel filesystem. */
  #isExecOnly(path: string): boolean {
    return this.#execOnly.some(
      (root) => path === root || path.startsWith(`${root}/`),
    );
  }

  /** The stat after symbolic links, which the engine's stat does not follow. */
  async #followLinks(
    path: string,
    signal: AbortSignal | undefined,
  ): Promise<{ path: string; stat: EngineApi.ContainerPathStat } | undefined> {
    let target = path;
    while (true) {
      const stat = await this.#container.stat(target, { signal });
      if (!stat) return undefined;
      if (stat.linkTarget === '') return { path: target, stat };
      target = posix.resolve(posix.dirname(target), stat.linkTarget);
    }
  }

  async readFile(
    path: string,
    signal: AbortSignal | undefined,
  ): Promise<Uint8Array | null> {
    const target = this.#resolve(path);
    if (this.#isExecOnly(target)) {
      return readFileOverExec(this, target, signal);
    }
    try {
      return await this.#container.readFile(target, { signal });
    } catch (error) {
      if (error instanceof PathNotFoundError) return null;
      if (isUnexplainedFailure(error)) {
        return readFileOverExec(this, target, signal);
      }
      if (!(error instanceof NotAFileError && error.kind === 'symlink')) {
        throw error;
      }
    }
    const followed = await this.#followLinks(target, signal);
    return followed
      ? this.#container.readFile(followed.path, { signal })
      : null;
  }

  async stat(
    path: string,
    signal: AbortSignal | undefined,
  ): Promise<Experimental_SandboxFileStat | null> {
    const target = this.#resolve(path);
    if (this.#isExecOnly(target)) return statOverExec(this, target, signal);
    try {
      const followed = await this.#followLinks(target, signal);
      return followed
        ? { type: fileType(followed.stat.mode), size: followed.stat.size }
        : null;
    } catch (error) {
      if (isUnexplainedFailure(error)) {
        return statOverExec(this, target, signal);
      }
      throw error;
    }
  }

  async writeFile(
    path: string,
    content: Uint8Array,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const target = this.#resolve(path);
    if (this.#isExecOnly(target)) {
      return writeFileOverExec(this, target, content, signal);
    }
    try {
      await this.#container.writeFiles([{ path: target, data: content }], {
        signal,
        copyUIDGID: true,
      });
    } catch (error) {
      throw new Error(`Failed to write file "${path}": ${messageOf(error)}`, {
        cause: error,
      });
    }
  }

  installerContext(image: string): InstallerContext {
    return createInstallerContext(
      {
        // Installers run with `sh -c`, before the sandbox knows Bash exists.
        exec: (command) => this.exec(['sh', '-c', command]),
        SandboxError: DockerSandboxError,
      },
      this.name,
      image,
    );
  }

  async stop(): Promise<void> {
    try {
      await this.#container.stop();
      // Stop returns while the engine still removes an AutoRemove container,
      // which holds its volumes and bind mounts until then.
      if (this.#autoRemove) {
        await this.#container.wait({ condition: 'removed' });
      }
    } catch (error) {
      // The container is gone: AutoRemove removed it, or something outside the
      // sandbox removed it first.
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
   * Connects to the engine that the Docker CLI selects from `environment`.
   * `commandTimeout` bounds each command of the sandbox's containers.
   */
  static async connect(
    environment: Environment,
    commandTimeout: number | undefined,
  ): Promise<DockerEngine> {
    // The sandbox runs real containers, so the waits of the engine client and
    // the time of the files that it writes come from the real clock; no
    // caller has another clock to give.
    const docker = await Docker.connect({
      clock: globalThis,
      environment,
    }).catch(unavailable);
    return new DockerEngine(docker, commandTimeout);
  }

  /** A sandbox container handle for a container of this engine. */
  container(
    name: string,
    container: Container,
    info: EngineApi.ContainerInspectResponse,
  ): DockerContainer {
    return new DockerContainer(
      name,
      container,
      fileLayout(info.Config, info.HostConfig),
      this.#commandTimeout,
      info.HostConfig?.AutoRemove === true,
    );
  }

  async attach(
    name: string,
    image: string,
  ): Promise<DockerContainer | undefined> {
    const found = await this.docker.containers.find(name).catch(unavailable);
    if (!found) return undefined;
    const info = await found.inspect();
    if (info.State?.Status !== 'running') {
      await startContainer(found, image);
    }
    return this.container(name, found, info);
  }

  async run(
    image: string,
    name: string,
    opts: DockerCommonOptions,
    workdir: string,
  ): Promise<RunResult> {
    const started = await this.#createAndStart(image, name, opts, workdir);
    if (!started) return { created: false };
    try {
      return {
        created: true,
        // The image's own USER and WORKDIR are in the inspect, not the body.
        container: this.container(name, started, await started.inspect()),
      };
    } catch (error) {
      await started[Symbol.asyncDispose]();
      throw error;
    }
  }

  /** Creates and starts the container; `undefined` when another caller has the name. */
  async #createAndStart(
    image: string,
    name: string,
    opts: DockerCommonOptions,
    workdir: string,
  ): Promise<OwnedContainer | undefined> {
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
      if (!result.created) return undefined;
      try {
        await result.container.start();
      } catch (error) {
        await result.container[Symbol.asyncDispose]();
        throw error;
      }
      return result.container;
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
        (candidate): candidate is SandboxBindVolume =>
          candidate.type === 'bind' &&
          isBindSource(error.source, candidate.hostPath),
      );
      if (volume) {
        return new VolumePathError(
          volume.hostPath,
          volume.containerPath,
          'hostPath does not exist on host',
        );
      }
    }
    return new ContainerCreationError(
      Error.isError(error) ? error.message : String(error),
      image,
      Error.isError(error) ? error : undefined,
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
        Error.isError(error) ? error.message : String(error),
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
        Labels: opts.container?.Labels,
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
          : Error.isError(error)
            ? error.message
            : String(error),
      );
    }
  }

  async removeVolume(name: string): Promise<void> {
    try {
      await this.docker.volumes.find(name).then((volume) => volume?.remove());
    } catch (error) {
      if (error instanceof ConnectionFailedError) {
        throw new DockerNotAvailableError();
      }
      throw new VolumeRemoveError(name, messageOf(error));
    }
  }

  async ensureWorkdir(): Promise<void> {}

  async imageExists(tag: string): Promise<boolean> {
    return (await this.docker.images.inspect(tag)) !== undefined;
  }

  /** An inline Dockerfile goes to `docker build -f -` on stdin. */
  async buildImage(spec: ImageBuildSpec): Promise<void> {
    const inline = spec.dockerfile.includes('\n');
    try {
      await spawn(
        'docker',
        [
          'build',
          ...(spec.identity ? ['--platform', spec.identity] : []),
          '-t',
          spec.tag,
          '-f',
          inline ? '-' : spec.dockerfile,
          spec.context,
        ],
        {
          stdin: inline ? { string: spec.dockerfile } : 'inherit',
          stdout: spec.showBuildLogs ? 'inherit' : 'ignore',
          stderr: spec.showBuildLogs ? 'inherit' : 'pipe',
          env: this.cliEnv,
        },
      );
    } catch (error) {
      // nano-spawn names a CLI that could not start only in the cause.
      throw new DockerfileBuildError(
        error instanceof SubprocessError
          ? error.stderr || messageOf(error.cause ?? error)
          : messageOf(error),
      );
    }
  }

  dispose(): Promise<void> {
    return this.docker[Symbol.asyncDispose]();
  }
}

export interface ComposeStrategyArgs {
  compose: string;
  service: string;
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
    super({}, engine);
    this.dockerEngine = engine;
    this.composeFile = args.compose;
    this.service = args.service;
    this.projectName = `sandbox-${hash('sha256', readFileSync(this.composeFile, 'utf-8')).slice(0, 8)}`;
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
          (Error.isError(error) ? error.message : String(error)),
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
  if (!isComposeOptions(options)) {
    validateSandboxOptions(options, dockerErrors);
  }
  const engine = await DockerEngine.connect(
    options.environment ?? process.env,
    options.commandTimeout,
  );
  let strategy: ContainerSandboxStrategy<DockerCommonOptions>;
  try {
    if (isComposeOptions(options)) {
      strategy = new ComposeStrategy(
        { compose: options.compose, service: options.service },
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
  await using sandbox = await createDockerSandbox(options);

  return await fn(sandbox);
}
