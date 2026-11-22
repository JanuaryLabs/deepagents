import type { Experimental_SandboxFileStat } from '@ai-sdk/provider-utils';
import {
  BindSourceNotFoundError,
  ConnectionFailedError,
  type Container,
  ContainerNotFoundError,
  type ContainerProcess,
  type Containers,
  type Created,
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
import pMemoize from 'p-memoize';

import type {
  ChatContainerEngine,
  ChatEngineContainer,
  ChatSandboxVolume,
  CommonSandboxOptions,
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
  chatContainerSandbox,
  readFileOverExec,
  statOverExec,
  validateEnv,
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
import {
  chatSandboxLabels,
  chatSandboxName,
  createByteReadable,
} from './session.ts';
import {
  type ChatSandbox,
  type CommandResult,
  type DisposableSandbox,
  type SandboxContext,
  SandboxNotFoundError,
  type StoppableSandboxEnvironment,
} from './types.ts';

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

/** How long a container lives: removed when it stops, or kept for its chat. */
type ContainerLifetime =
  { kind: 'one-off' } | { kind: 'chat'; labels: Record<string, string> };

/** The body of `POST /containers/create` for a sandbox container. */
function containerCreateRequest(
  image: string,
  opts: DockerCommonOptions,
  workdir: string,
  lifetime: ContainerLifetime,
): EngineApi.ContainerCreateRequest {
  const { HostConfig, ...config } = opts.container ?? {};
  return {
    ...config,
    ...(lifetime.kind === 'chat'
      ? { Labels: { ...config.Labels, ...lifetime.labels } }
      : {}),
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
      // A chat container lives for days: tini as PID 1 reaps the processes
      // that killed commands leave behind, and passes `docker stop` on.
      ...(lifetime.kind === 'chat'
        ? { AutoRemove: false, Init: true }
        : { AutoRemove: true }),
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

/** The output of a container process as two streams and an exit. */
function engineProcess(process: ContainerProcess): EngineProcess {
  const streams = {
    stdout: createByteReadable(),
    stderr: createByteReadable(),
  };

  const exitCode = (async (): Promise<number> => {
    try {
      for await (const { stream, data } of process) {
        streams[stream].enqueue(data);
      }
    } catch (error) {
      streams.stdout.error(error);
      streams.stderr.error(error);
      throw error;
    }
    streams.stdout.close();
    streams.stderr.close();
    return process.exitCode;
  })();

  return {
    stdout: streams.stdout.stream,
    stderr: streams.stderr.stream,
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

  /** A removed container is a sandbox that no longer exists, whichever request finds it. */
  #notFound(error: unknown): unknown {
    return error instanceof ContainerNotFoundError
      ? new SandboxNotFoundError(this.name, { cause: error })
      : error;
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
      if (error instanceof ContainerNotFoundError) {
        throw this.#notFound(error);
      }
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
    try {
      return engineProcess(
        await this.#container.spawn(this.#config(argv, options), {
          stdin: options.stdin,
        }),
      );
    } catch (error) {
      throw this.#notFound(error);
    }
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

  async #isLinkOrUnstatable(
    path: string,
    signal: AbortSignal | undefined,
  ): Promise<boolean> {
    try {
      const stat = await this.#container.stat(path, { signal });
      return stat !== undefined && stat.linkTarget !== '';
    } catch (error) {
      if (isUnexplainedFailure(error)) return true;
      throw this.#notFound(error);
    }
  }

  async readFile(
    path: string,
    signal: AbortSignal | undefined,
  ): Promise<Uint8Array | null> {
    try {
      return await this.#readFile(path, signal);
    } catch (error) {
      throw this.#notFound(error);
    }
  }

  async #readFile(
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
      if (followed) {
        return { type: fileType(followed.stat.mode), size: followed.stat.size };
      }
      // The engine's stat answers a missing container as a missing path.
      await this.#container.inspect({ signal });
      return null;
    } catch (error) {
      if (isUnexplainedFailure(error)) {
        return statOverExec(this, target, signal);
      }
      throw this.#notFound(error);
    }
  }

  async writeFile(
    path: string,
    content: Uint8Array,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const target = this.#resolve(path);
    // Predicting check, not EAFP: the archive PUT silently replaces a symbolic
    // link, while shell redirection writes through it.
    if (
      this.#isExecOnly(target) ||
      (await this.#isLinkOrUnstatable(target, signal))
    ) {
      return writeFileOverExec(this, target, content, signal);
    }
    try {
      await this.#container.writeFiles([{ path: target, data: content }], {
        signal,
        copyUIDGID: true,
      });
    } catch (error) {
      if (error instanceof ContainerNotFoundError) throw this.#notFound(error);
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
        const { Error: failure } = await this.#container.wait({
          condition: 'removed',
        });
        if (failure?.Message) {
          throw new DockerSandboxError(
            `Failed to remove container "${this.name}": ${failure.Message}`,
            this.name,
          );
        }
      }
    } catch (error) {
      // The container is gone: AutoRemove removed it, or something outside the
      // sandbox removed it first.
      if (error instanceof ContainerNotFoundError) return;
      throw error;
    }
  }
}

/** The container of a chat, which the engine keeps when it stops. */
class DockerChatContainer
  extends DockerContainer
  implements ChatEngineContainer
{
  readonly #container: Container;
  readonly #containers: Containers;

  constructor(
    name: string,
    container: Container,
    layout: FileLayout,
    commandTimeout: number | undefined,
    containers: Containers,
  ) {
    super(name, container, layout, commandTimeout, false);
    this.#container = container;
    this.#containers = containers;
  }

  /** Inspects by name, so a container that now has the name is not this one. */
  async resume(): Promise<void> {
    const info = await this.#containers.inspect(this.name).catch(unavailable);
    const state = info?.State?.Status;
    if (
      info?.Id !== this.#container.id ||
      state === 'removing' ||
      state === 'dead'
    ) {
      throw new SandboxNotFoundError(this.name);
    }
    try {
      if (state === 'paused') await this.#container.unpause();
      else if (state === 'created' || state === 'exited') {
        await this.#container.start();
      }
    } catch (error) {
      if (error instanceof ContainerNotFoundError) {
        throw new SandboxNotFoundError(this.name, { cause: error });
      }
      unavailable(error);
    }
  }

  async remove(): Promise<void> {
    await this.#container.remove({ force: true, v: true }).catch(unavailable);
  }
}

/**
 * The Docker engine, reached through the Engine API of `@zukhruf/docker`. It
 * selects the engine that the Docker CLI selects (`DOCKER_HOST`,
 * `DOCKER_CONTEXT`, the current context), so a remote SSH context works as it
 * does for the CLI. Image builds and Compose stay on the CLI, sent to the same
 * engine through `docker.cliEnvironment`.
 */
export class DockerEngine implements ChatContainerEngine<DockerCommonOptions> {
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

  #chatContainer(
    name: string,
    container: Container,
    info: EngineApi.ContainerInspectResponse,
  ): DockerChatContainer {
    return new DockerChatContainer(
      name,
      container,
      fileLayout(info.Config, info.HostConfig),
      this.#commandTimeout,
      this.docker.containers,
    );
  }

  async find(name: string): Promise<DockerChatContainer | undefined> {
    const found = await this.docker.containers.find(name).catch(unavailable);
    if (!found) return undefined;
    const info = await found.inspect().catch((error: unknown) => {
      if (error instanceof ContainerNotFoundError) return undefined;
      unavailable(error);
    });
    return info && this.#chatContainer(name, found, info);
  }

  async createChat(
    image: string,
    name: string,
    opts: DockerCommonOptions,
    workdir: string,
    labels: Record<string, string>,
  ): Promise<{ created: boolean; container: DockerChatContainer }> {
    const result = await this.#createOrGet(image, name, opts, workdir, {
      kind: 'chat',
      labels,
    });
    try {
      return {
        created: result.created,
        container: this.#chatContainer(
          name,
          result.container,
          await result.container.inspect(),
        ),
      };
    } catch (error) {
      if (result.created) await result.container[Symbol.asyncDispose]();
      unavailable(error);
    }
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
    const result = await this.#createOrGet(image, name, opts, workdir, {
      kind: 'one-off',
    });
    if (!result.created) return { created: false };
    const started = result.container;
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

  /**
   * Creates and starts the container, or gives the one that another caller
   * has under the name, as it is.
   */
  async #createOrGet(
    image: string,
    name: string,
    opts: DockerCommonOptions,
    workdir: string,
    lifetime: ContainerLifetime,
  ): Promise<Created<'container', OwnedContainer, Container>> {
    try {
      const body = containerCreateRequest(image, opts, workdir, lifetime);
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
      if (!result.created) return result;
      try {
        await result.container.start();
      } catch (error) {
        await result.container[Symbol.asyncDispose]();
        throw error;
      }
      return result;
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
 * The create body that a chat container passes through. The environment also
 * owns `HostConfig.Init`, and `Labels` get the chat's labels, which win.
 */
export type DockerChatContainerConfig = Omit<
  DockerContainerConfig,
  'HostConfig'
> & {
  HostConfig?: Omit<NonNullable<DockerContainerConfig['HostConfig']>, 'Init'>;
};

/** What a chat environment takes beside a backend's options. */
interface DockerChatOptions {
  /**
   * With a chat's id, names that chat's container. Two environments with the
   * same namespace on one engine reach the same containers; give each app or
   * deployment its own.
   */
  namespace: string;
  /**
   * The volumes of a chat's container, given when `open` creates it. Its
   * durable files belong here: the rest is lost when the container is deleted.
   */
  volumes?: (chat: SandboxContext) => ChatSandboxVolume[];
  container?: DockerChatContainerConfig;
}

type ChatEnvironmentBase<T extends DockerCommonOptions> = Omit<
  T,
  'volumes' | 'name' | 'container'
> &
  DockerChatOptions;

/**
 * The options of a {@link DockerSandboxEnvironment}: an image, or a Dockerfile
 * that builds one. A chat container has no installers: a second worker could
 * attach to it before they finish, so what it needs belongs in its image.
 */
export type DockerSandboxEnvironmentOptions =
  | (ChatEnvironmentBase<Omit<RuntimeSandboxOptions, 'installers'>> & {
      dockerfile?: never;
    })
  | (ChatEnvironmentBase<DockerfileSandboxOptions> & { image?: never });

/**
 * Chat containers on the Docker engine that `environment` selects
 * (`DOCKER_HOST`, a context, `ssh://`). A chat's container is named from the
 * namespace and the chat's id, and carries the labels
 * `deepagents.sandbox.namespace` and `deepagents.sandbox.chat`. It has no
 * AutoRemove, so `stop` (`docker stop`) keeps it and its files, and the next
 * `open` or `resume` starts it; `delete` is `docker rm -f`. Its PID 1 is the
 * engine's init, which reaps what killed commands leave behind. The open
 * handles share one engine client, which the first `open` connects and the
 * last `close` closes.
 */
export class DockerSandboxEnvironment implements StoppableSandboxEnvironment {
  readonly #options: DockerSandboxEnvironmentOptions;
  /** The connected engine, while something holds it; concurrent connects share one. */
  readonly #connected = new Map<undefined, DockerEngine>();
  readonly #connect = pMemoize(
    () =>
      DockerEngine.connect(
        this.#options.environment ?? process.env,
        this.#options.commandTimeout,
      ),
    { cache: this.#connected },
  );
  #holders = 0;

  constructor(options: DockerSandboxEnvironmentOptions) {
    validateEnv(options.env, dockerErrors);
    this.#options = options;
  }

  async #acquire(): Promise<DockerEngine> {
    this.#holders++;
    try {
      return await this.#connect();
    } catch (error) {
      this.#holders--;
      throw error;
    }
  }

  /** The last holder closes the engine, and the next acquire connects again. */
  async #release(): Promise<void> {
    if (--this.#holders > 0) return;
    const engines = [...this.#connected.values()];
    this.#connected.clear();
    for (const engine of engines) await engine.dispose();
  }

  async #withEngine<T>(fn: (engine: DockerEngine) => Promise<T>): Promise<T> {
    const engine = await this.#acquire();
    try {
      return await fn(engine);
    } finally {
      await this.#release();
    }
  }

  #strategy(
    engine: DockerEngine,
    chat: SandboxContext,
  ): ContainerSandboxStrategy<DockerCommonOptions, DockerEngine> {
    const { volumes, ...options } = this.#options;
    const opts = { ...options, volumes: volumes?.(chat) ?? [] };
    if (options.dockerfile !== undefined) {
      return new ContainerfileStrategy(opts, engine, {
        dockerfile: options.dockerfile,
        context: options.context ?? '.',
        showBuildLogs: options.showBuildLogs ?? false,
        identity: options.platform,
      });
    }
    return new RuntimeStrategy(opts, engine, {
      image: options.image ?? engine.defaultImage,
      installers: [],
    });
  }

  async open(chat: SandboxContext): Promise<ChatSandbox> {
    const engine = await this.#acquire();
    let container: ChatEngineContainer;
    try {
      container = await this.#strategy(engine, chat).openChat(
        chatSandboxName(this.#options.namespace, chat),
        chatSandboxLabels(this.#options.namespace, chat),
      );
    } catch (error) {
      await this.#release();
      throw error;
    }
    const sandbox = chatContainerSandbox(
      container,
      dockerErrors,
      chat.chatId,
      () => this.#release(),
    );
    if (this.#options.readiness) {
      try {
        await this.#options.readiness(sandbox);
      } catch (error) {
        await sandbox.close().catch(() => {});
        throw error;
      }
    }
    return sandbox;
  }

  /** `docker stop` with the engine's grace, which the init cuts short. */
  async stop(chat: SandboxContext): Promise<void> {
    await this.#withEngine(async (engine) => {
      const found = await engine.docker.containers
        .find(chatSandboxName(this.#options.namespace, chat))
        .catch(unavailable);
      await found?.stop().catch((error: unknown) => {
        if (error instanceof ContainerNotFoundError) return;
        unavailable(error);
      });
    });
  }

  /** `docker rm -f` with the container's anonymous volumes; named volumes stay. */
  async delete(chat: SandboxContext): Promise<void> {
    await this.#withEngine(async (engine) => {
      const found = await engine.find(
        chatSandboxName(this.#options.namespace, chat),
      );
      await found?.remove();
    });
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
