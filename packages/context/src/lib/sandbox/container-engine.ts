import type { Experimental_SandboxFileStat } from '@ai-sdk/provider-utils';

import type { ContainerSandboxError } from './container-sandbox-errors.ts';
import type { InstallerContext } from './installers/installer.ts';
import type { CommandResult, SandboxReadinessOptions } from './types.ts';

/** The errors the shared skeleton raises itself; each engine gives its own classes. */
export interface ContainerErrorFactory {
  generic(message: string, containerId?: string): ContainerSandboxError;
  volumePath(
    source: string,
    containerPath: string,
    reason: string,
  ): ContainerSandboxError;
  volumeInspect(name: string, reason: string): ContainerSandboxError;
  volumeCreate(name: string, reason: string): ContainerSandboxError;
}

/** Resolved build request handed to {@link ContainerEngine.buildImage}. */
export interface ImageBuildSpec {
  /** Precomputed content-hash image tag the engine must build. */
  tag: string;
  /** Inline Dockerfile content (contains `\n`) or a path to one. */
  dockerfile: string;
  /** Build context directory. */
  context: string;
  /** Stream build output to the parent stdio instead of buffering it. */
  showBuildLogs: boolean;
  /**
   * Platform (Docker `--platform`) / arch (Apple `--arch`). Already folded into
   * `tag` by the strategy; the engine re-reads it for the build flag.
   */
  identity?: string;
}

export interface SandboxBindVolume {
  type: 'bind';
  hostPath: string;
  containerPath: string;
  /** Default: `true`. */
  readOnly?: boolean;
}

/**
 * A named volume mount. The superset shape across engines — `driver`/
 * `driverOptions`/`subPath`/`noCopy` are read only by engines that support them
 * (Docker); engines without a pluggable driver model (Apple) ignore them.
 */
export interface SandboxNamedVolume {
  type: 'volume';
  name: string;
  containerPath: string;
  /** Default: `true`. */
  readOnly?: boolean;
  /** Default: `'external'`. */
  lifecycle?: 'external' | 'managed';
  /** Volume driver used when `lifecycle` is `'managed'` (Docker `--driver`). */
  driver?: string;
  /** Volume driver options used when `lifecycle` is `'managed'`. */
  driverOptions?: Record<string, string>;
  subPath?: string;
  noCopy?: boolean;
  /** Default: `true` for managed volumes created by this sandbox. */
  removeOnDispose?: boolean;
}

export type SandboxVolume = SandboxBindVolume | SandboxNamedVolume;

/** A named volume that exists before the sandbox. The framework never creates or removes it. */
export interface SandboxExternalVolume {
  type: 'volume';
  lifecycle?: 'external';
  name: string;
  containerPath: string;
  /** Default: `true`. */
  readOnly?: boolean;
  subPath?: string;
  noCopy?: boolean;
}

/** What a chat sandbox mounts: its durable files live in volumes the host provides. */
export type ChatSandboxVolume = SandboxBindVolume | SandboxExternalVolume;

/**
 * The options the shared skeleton is allowed to read. Each engine extends this
 * with its own dialect knobs (Docker's `container` create body; Apple's `arch`),
 * which only its own engine methods see — the skeleton is typed to this common
 * subset and physically cannot read them.
 */
export interface CommonSandboxOptions extends SandboxReadinessOptions {
  volumes?: SandboxVolume[];
  env?: Record<string, string>;
  /**
   * Args appended after the image at run time.
   * - `undefined` (default): `['tail', '-f', '/dev/null']` keep-alive so a bare
   *   image stays up for installers and commands.
   * - `[]` or `null`: nothing is appended; the image's own `CMD`/`ENTRYPOINT`
   *   runs as declared.
   * - A non-empty array: appended verbatim, overriding the image `CMD`.
   */
  command?: readonly string[] | null;
  /** Working directory inside the container (default `'/workspace'`). */
  workdir?: string;
}

/** Where and with what environment a process runs in the container. */
export interface EngineProcessOptions {
  /** An absolute path. Default: the {@link EngineContainer.workdir}. */
  workingDirectory?: string;
  env?: Record<string, string>;
}

export interface EngineExecOptions extends EngineProcessOptions {
  signal?: AbortSignal;
  /** Bytes for standard input, which then ends. */
  stdin?: Uint8Array;
}

export interface EngineSpawnOptions extends EngineProcessOptions {
  stdin?: boolean;
}

/** A process in a container, while it runs. */
export interface EngineProcess {
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  /** Present when the process was spawned with `stdin`. */
  readonly stdin?: WritableStream<Uint8Array>;
  /** Resolves when the output has ended. */
  readonly exitCode: Promise<number>;
}

/**
 * One running container of an engine. The session of the sandbox is built on
 * this, so each engine owns how commands and files reach its containers.
 */
export interface EngineContainer {
  /** The container name: a one-off's generated `sandbox-<8hex>`, or a chat's. */
  readonly name: string;
  /** Where commands start and what a relative path of a file call resolves against. */
  readonly workdir: string;
  /** Milliseconds that bound each command of the session. */
  readonly commandTimeout?: number;
  /**
   * Runs `argv` to its end. A command the engine cannot run is a failed command
   * in the result, as it is for the engine's own CLI, not a rejection.
   */
  exec(argv: string[], options?: EngineExecOptions): Promise<CommandResult>;
  /** Starts `argv` and streams its output. */
  spawn(argv: string[], options: EngineSpawnOptions): Promise<EngineProcess>;
  /** The bytes of the file at `path`, or `null` when nothing is there. */
  readFile(
    path: string,
    signal: AbortSignal | undefined,
  ): Promise<Uint8Array | null>;
  /** Creates the parent directories. Rejects when `path` is a directory. */
  writeFile(
    path: string,
    content: Uint8Array,
    signal: AbortSignal | undefined,
  ): Promise<void>;
  /** Follows symbolic links, and gives `null` when nothing is at `path`. */
  stat(
    path: string,
    signal: AbortSignal | undefined,
  ): Promise<Experimental_SandboxFileStat | null>;
  /**
   * The installer context that drives the post-start installer phase
   * (`pkg`/`npm`/`pip`/…) in this container.
   */
  installerContext(image: string): InstallerContext;
  /**
   * Rejects with `SandboxNotFoundError` when it is gone, or when another
   * container now has its name; runs before every operation of its sandbox.
   * An engine whose calls reach the container itself, not its name, rejects
   * so on its own and gives none.
   */
  assertCurrent?(): Promise<void>;
  /** Stops the container, and resolves when the engine removed it or it is already gone. */
  stop(): Promise<void>;
}

/** The result of {@link ContainerEngine.run}: `created: false` when another container has the name. */
export type RunResult =
  { created: true; container: EngineContainer } | { created: false };

/**
 * The engine seam. Captures everything that differs between container
 * runtimes (how a container is found, started and stopped, how volumes and
 * images are handled, how commands and files reach it) so one shared strategy
 * can orchestrate any engine. Generic over `TOpts` so each engine reads its own
 * dialect-specific run knobs off the resolved options while the skeleton only
 * ever supplies the common subset. Implemented by `DockerEngine`
 * (docker-sandbox.ts, Engine API) and `appleEngine`
 * (apple-container-sandbox.ts, `container` CLI).
 */
export interface ContainerEngine<
  TOpts extends CommonSandboxOptions = CommonSandboxOptions,
> {
  /** Docker validates bind sources on the daemon host; Apple uses this host. */
  readonly bindMountsOnClient: boolean;
  /** Image used when no `image` option is given. */
  readonly defaultImage: string;
  readonly errors: ContainerErrorFactory;
  /**
   * Creates and starts a long-running, auto-removed container named `name`.
   * A name that another container holds gives `{ created: false }`.
   */
  run(
    image: string,
    name: string,
    opts: TOpts,
    workdir: string,
  ): Promise<RunResult>;
  volumeExists(name: string): Promise<boolean>;
  createVolume(volume: SandboxNamedVolume, opts: TOpts): Promise<void>;
  removeVolume(name: string): Promise<void>;
  /**
   * Ensure `workdir` exists before any `exec` runs in it. Docker creates the
   * workdir at the create (no-op here); Apple's per-exec `--cwd` fails on a
   * missing dir, so its engine bootstraps it with `mkdir -p`.
   */
  ensureWorkdir(container: EngineContainer, workdir: string): Promise<void>;
  /** Whether image `tag` already exists locally (so the build can be skipped). */
  imageExists(tag: string): Promise<boolean>;
  /** Build the image described by `spec`. The engine owns the build dialect. */
  buildImage(spec: ImageBuildSpec): Promise<void>;
  /** Releases what the engine holds, such as its connection. */
  dispose(): Promise<void>;
}

/** The container of a chat, which the engine keeps when it stops. */
export interface ChatEngineContainer extends EngineContainer {
  /**
   * Makes this container run: starts it when it is stopped, unpauses it when
   * it is paused. Rejects with `SandboxNotFoundError` when it is gone, or when
   * another container now has its name. Never creates one.
   */
  resume(): Promise<void>;
  /** Removes it, running or not, with its anonymous volumes. Resolves when it is gone. */
  remove(): Promise<void>;
}

/** An engine that runs the containers of chats beside one-off containers. */
export interface ChatContainerEngine<
  TOpts extends CommonSandboxOptions = CommonSandboxOptions,
> extends ContainerEngine<TOpts> {
  /** The container named `name`, as it is; `undefined` when there is none. */
  find(name: string): Promise<ChatEngineContainer | undefined>;
  /**
   * Creates and starts the chat container `name`, kept when it stops and
   * marked with `labels`. `created: false` gives the container that another
   * caller made under the name, which may not run yet.
   */
  createChat(
    image: string,
    name: string,
    opts: TOpts,
    workdir: string,
    labels: Record<string, string>,
  ): Promise<{ created: boolean; container: ChatEngineContainer }>;
}
