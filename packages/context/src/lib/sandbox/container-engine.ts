import type { ContainerSandboxError } from './container-sandbox-errors.ts';
import type { InstallerContext } from './installers/installer.ts';

export interface ContainerErrorFactory {
  serviceNotAvailable(): ContainerSandboxError;
  creation(
    message: string,
    image: string,
    cause?: Error,
  ): ContainerSandboxError;
  generic(message: string, containerId?: string): ContainerSandboxError;
  volumePath(
    source: string,
    containerPath: string,
    reason: string,
  ): ContainerSandboxError;
  volumeInspect(name: string, reason: string): ContainerSandboxError;
  volumeCreate(name: string, reason: string): ContainerSandboxError;
  volumeRemove(name: string, reason: string): ContainerSandboxError;
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
export interface CommonSandboxOptions {
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
 * The CLI dialect seam. Captures everything that differs between container
 * runtimes (binary, run/exec arg flags, status parsing, error-string detection,
 * workdir bootstrap, image build) so one shared strategy can orchestrate any
 * engine. Generic over `TOpts` so each engine reads its own dialect-specific run
 * knobs off the resolved options while the skeleton only ever supplies the
 * common subset. Implemented by `dockerEngine` (docker-sandbox.ts) and
 * `appleEngine` (apple-container-sandbox.ts).
 */
export interface ContainerEngine<
  TOpts extends CommonSandboxOptions = CommonSandboxOptions,
> {
  readonly cli: string;
  /**
   * Build the `<cli> run` argv from resolved options. The shared skeleton
   * supplies `image`, `containerId`, and `workdir`; every other flag is the
   * engine's own dialect read off `opts`.
   */
  runArgs(
    image: string,
    containerId: string,
    opts: TOpts,
    workdir: string,
  ): string[];
  execArgs(
    containerId: string,
    command: string,
    options?: { cwd?: string; env?: Record<string, string> },
  ): string[];
  inspectArgs(containerId: string): string[];
  mountArg(volume: SandboxVolume): string;
  parseStatus(status: string): 'running' | 'stopped' | 'absent';
  volumeCreateArgs(volume: SandboxNamedVolume): string[];
  errorMessage(error: unknown): string;
  isServiceDown(message: string): boolean;
  isMissingContainer(message: string): boolean;
  isMissingVolume(message: string): boolean;
  isNameConflict(message: string): boolean;
  /**
   * Ensure `workdir` exists before any `exec` runs in it. Docker's `run -w`
   * auto-creates the workdir (no-op here); Apple's per-exec `--cwd` fails on a
   * missing dir, so its engine bootstraps it with `mkdir -p`.
   */
  ensureWorkdir(containerId: string, workdir: string): Promise<void>;
  /** Image used when no `image` option is given. */
  readonly defaultImage: string;
  /**
   * Build the installer context that drives this engine's post-start installer
   * phase (`pkg`/`npm`/`pip`/…) over the engine's own `exec`.
   */
  createInstallerContext(containerId: string, image: string): InstallerContext;
  /** Whether image `tag` already exists locally (so the build can be skipped). */
  imageExists(tag: string): Promise<boolean>;
  /** Build the image described by `spec`. The engine owns the build dialect. */
  buildImage(spec: ImageBuildSpec): Promise<void>;
  readonly errors: ContainerErrorFactory;
}
