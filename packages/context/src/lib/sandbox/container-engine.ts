import type { ContainerSandboxError } from './container-sandbox-errors.ts';
import type { InstallerContext } from './installers/installer.ts';
import type {
  CommandResult,
  ExecuteCommandOptions,
  SandboxProcess,
  SandboxReadinessOptions,
  SpawnOptions,
} from './types.ts';

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

/** Resource limits common to every engine. Engines extend with their own knobs. */
export interface SandboxResources {
  /** `--memory` — e.g. `'1g'`, `'1024M'`. */
  memory?: string;
  /** `--cpus` — number of CPUs. */
  cpus?: number;
}

/**
 * The options the shared skeleton is allowed to read. Each engine extends this
 * with its own dialect knobs (Docker's security/network/…; Apple's `arch`),
 * which only its own engine methods see — the skeleton is typed to this common
 * subset and physically cannot read them.
 */
export interface CommonSandboxOptions extends SandboxReadinessOptions {
  volumes?: SandboxVolume[];
  resources?: SandboxResources;
  env?: Record<string, string>;
  /**
   * Stable identity suffix. When provided, the container is named
   * `sandbox-<name>` instead of a randomized `sandbox-<8hex>`. If a container
   * with that name already exists, the sandbox attaches to it (installers,
   * volume preparation, and env are skipped); if it exists but is stopped, it is
   * started first; otherwise it is created fresh. Must match `/^[A-Za-z0-9_.-]+$/`.
   *
   * Warning: `dispose()` stops (and `--rm` removes) the container regardless of
   * whether it was created or attached to. If two callers in the same process
   * share a name, the first `dispose()` destroys the container the other is
   * still using.
   */
  name?: string;
  /**
   * Args appended after the image at run time.
   * - `undefined` (default): `['tail', '-f', '/dev/null']` keep-alive so a bare
   *   image stays up for installers and `executeCommand`.
   * - `[]` or `null`: nothing is appended; the image's own `CMD`/`ENTRYPOINT`
   *   runs as declared.
   * - A non-empty array: appended verbatim, overriding the image `CMD`.
   */
  command?: readonly string[] | null;
  /** Working directory inside the container (default `'/workspace'`). */
  workdir?: string;
}

/**
 * One running container of an engine. The sandbox methods delegate here, so
 * each engine owns how commands and files reach its containers.
 */
export interface EngineContainer {
  /** The container name: `sandbox-<name>` or `sandbox-<8hex>`. */
  readonly name: string;
  executeCommand(
    command: string,
    options?: ExecuteCommandOptions,
  ): Promise<CommandResult>;
  spawn(command: string, options?: SpawnOptions): Promise<SandboxProcess>;
  /** The bytes of the file at `path`. */
  readFile(path: string): Promise<Uint8Array>;
  writeFiles(
    files: Array<{ path: string; content: string | Buffer }>,
  ): Promise<void>;
  exists(path: string): Promise<boolean>;
  /**
   * The installer context that drives the post-start installer phase
   * (`pkg`/`npm`/`pip`/…) in this container.
   */
  installerContext(image: string): InstallerContext;
  /** Stops the container; the engine removes it. Resolves when it is already gone. */
  stop(): Promise<void>;
}

/** The result of {@link ContainerEngine.run}: `created: false` when another caller has the name. */
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
   * The container named `name`, started when it is stopped, or `undefined`
   * when there is none. `image` names the requested image in a start error.
   */
  attach(name: string, image: string): Promise<EngineContainer | undefined>;
  /**
   * Creates and starts a long-running, auto-removed container. A named
   * container whose name another caller holds gives `{ created: false }`.
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
