import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

import type {
  CommonSandboxOptions,
  ContainerEngine,
  ContainerErrorFactory,
  EngineContainer,
  SandboxVolume,
} from './container-engine.ts';
import { type Installer } from './installers/installer.ts';
import { readFileContent } from './read-file.ts';
import type { DisposableSandbox } from './types.ts';

const CONTAINER_NAME_PATTERN = /^[A-Za-z0-9_.-]+$/;

/** A container the strategy runs in, and whether an earlier caller created it. */
export interface AcquiredContainer {
  container: EngineContainer;
  attached: boolean;
}

/**
 * Checks the caller's env keys and container name. It needs no engine, so a
 * factory runs it before it connects: a bad input is the caller's error even
 * when the engine is down.
 */
export function validateSandboxOptions(
  opts: CommonSandboxOptions,
  errors: ContainerErrorFactory,
): void {
  for (const key of Object.keys(opts.env ?? {})) {
    if (key.length === 0 || key.includes('=')) {
      throw errors.generic(`Invalid environment variable key: "${key}"`);
    }
  }
  if (opts.name !== undefined && !CONTAINER_NAME_PATTERN.test(opts.name)) {
    throw errors.generic(
      `Invalid container name: "${opts.name}". Use only letters, numbers, underscore, period, or hyphen. The "sandbox-" prefix is added automatically.`,
    );
  }
}

/** Records a cleanup failure on the error that started the cleanup. */
function suppress(originalError: unknown, cleanupError: unknown): void {
  if (!(originalError instanceof Error)) return;
  const suppressed: unknown[] =
    'suppressed' in originalError && Array.isArray(originalError.suppressed)
      ? originalError.suppressed
      : [];
  Object.assign(originalError, { suppressed: [...suppressed, cleanupError] });
}

/**
 * Template Method base for sandbox creation strategies, shared across engines.
 * Subclasses choose the image and define post-start configuration; the base owns
 * the container lifecycle (find or create, volumes, disposal) and delegates
 * every engine operation to the injected {@link ContainerEngine}. Typed to
 * {@link CommonSandboxOptions} so the skeleton can never read an engine-only
 * knob.
 */
export abstract class ContainerSandboxStrategy<
  TOpts extends CommonSandboxOptions = CommonSandboxOptions,
> {
  protected engine: ContainerEngine<TOpts>;
  protected opts: TOpts;
  protected volumes: SandboxVolume[];
  protected name?: string;
  protected workdir: string;
  private createdVolumes = new Set<string>();

  constructor(opts: TOpts, engine: ContainerEngine<TOpts>) {
    this.opts = opts;
    this.engine = engine;
    validateSandboxOptions(opts, engine.errors);
    const { volumes = [], name, workdir = '/workspace' } = opts;
    this.volumes = volumes;
    this.name = name;
    this.workdir = workdir;
  }

  /**
   * Creates the sandbox. On failure, everything it made is released and the
   * engine is disposed.
   */
  async create(): Promise<DisposableSandbox> {
    let acquired: AcquiredContainer | undefined;

    try {
      const image = await this.getImage();
      acquired = await this.acquireContainer(image);
      if (!acquired.attached) {
        await this.engine.ensureWorkdir(acquired.container, this.workdir);
        await this.configure(acquired.container, image);
      }
      await this.assertBashAvailable(acquired.container);
    } catch (error) {
      if (acquired && !acquired.attached) {
        await this.release(acquired.container).catch((stopError: unknown) =>
          suppress(error, stopError),
        );
      }
      await this.cleanupCreatedVolumes().catch((cleanupError: unknown) =>
        suppress(error, cleanupError),
      );
      await this.engine.dispose();
      throw error;
    }

    const sandbox = this.createSandboxMethods(acquired.container);
    if (this.opts.readiness) {
      try {
        await this.opts.readiness(sandbox);
      } catch (error) {
        await sandbox.dispose().catch(() => {});
        throw error;
      }
    }
    return sandbox;
  }

  protected containerName(): string {
    return this.name
      ? `sandbox-${this.name}`
      : `sandbox-${randomUUID().slice(0, 8)}`;
  }

  protected async acquireContainer(image: string): Promise<AcquiredContainer> {
    const name = this.containerName();
    if (this.name) {
      const container = await this.engine.attach(name, image);
      if (container) return { container, attached: true };
    }

    await this.prepareVolumes();
    const result = await this.engine.run(image, name, this.opts, this.workdir);
    if (result.created) {
      return { container: result.container, attached: false };
    }

    // Another caller created this name between our attach and run. Attach to
    // it when it is usable; `attach` fails loud on an unexpected state, so we
    // never attach to a broken one.
    await this.cleanupCreatedVolumes();
    if (this.name) {
      const raced = await this.waitForRacedContainer(name, image);
      if (raced) return raced;
    }
    throw this.engine.errors.generic(
      `Container name "${name}" is already in use`,
    );
  }

  private async waitForRacedContainer(
    name: string,
    image: string,
  ): Promise<AcquiredContainer | undefined> {
    const timeoutAt = Date.now() + 1_000;

    while (true) {
      const container = await this.engine.attach(name, image);
      if (container) return { container, attached: true };
      if (Date.now() >= timeoutAt) return undefined;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  protected async prepareVolumes(): Promise<void> {
    this.validateVolumes();

    for (const volume of this.volumes) {
      if (volume.type !== 'volume') {
        continue;
      }

      const lifecycle = volume.lifecycle ?? 'external';
      const exists = await this.engine.volumeExists(volume.name);
      if (lifecycle === 'external') {
        if (!exists) {
          throw this.engine.errors.volumeInspect(
            volume.name,
            'volume does not exist',
          );
        }
        continue;
      }

      if (exists) {
        throw this.engine.errors.volumeCreate(
          volume.name,
          'managed volume already exists',
        );
      }

      await this.engine.createVolume(volume, this.opts);
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
        if (this.engine.bindMountsOnClient && !existsSync(volume.hostPath)) {
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
    volume: SandboxVolume,
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

  private async cleanupCreatedVolumes(): Promise<void> {
    const volumes = [...this.createdVolumes].reverse();
    for (const volume of volumes) {
      await this.engine.removeVolume(volume);
      this.createdVolumes.delete(volume);
    }
  }

  /** Ends the sandbox's hold on its container: stops it, by default. */
  protected release(container: EngineContainer): Promise<void> {
    return container.stop();
  }

  private async assertBashAvailable(container: EngineContainer): Promise<void> {
    const result = await container.executeCommand(':');
    if (result.exitCode === 0) return;
    const detail = result.stderr.trim() || result.stdout.trim();
    throw this.engine.errors.generic(
      `Bash is required to execute sandbox commands but could not be started${detail ? `: ${detail}` : '.'}`,
      container.name,
    );
  }

  protected createSandboxMethods(
    container: EngineContainer,
  ): DisposableSandbox {
    let disposal: Promise<void> | undefined;
    const dispose = async (): Promise<void> => {
      try {
        await this.release(container);
        await this.cleanupCreatedVolumes();
      } finally {
        await this.engine.dispose();
      }
    };

    return {
      executeCommand: (command, options) =>
        container.executeCommand(command, options),
      spawn: (command, options) => container.spawn(command, options),
      readFile: async (path, options) =>
        readFileContent(await container.readFile(path), options),
      exists: (path) => container.exists(path),
      writeFiles: (files) => container.writeFiles(files),
      dispose: () => (disposal ??= dispose()),
      [Symbol.asyncDispose](this: DisposableSandbox): Promise<void> {
        return this.dispose();
      },
    };
  }

  protected abstract getImage(): Promise<string>;
  protected abstract configure(
    container: EngineContainer,
    image: string,
  ): Promise<void>;
}

/**
 * Starts a vanilla image and runs the supplied installers in order. Shared by
 * both engines — the post-start installer context comes from the engine's
 * container, so the same class drives Docker and Apple `container` installs.
 */
export class RuntimeStrategy<
  TOpts extends CommonSandboxOptions = CommonSandboxOptions,
> extends ContainerSandboxStrategy<TOpts> {
  private image: string;
  private installers: Installer[];

  constructor(
    opts: TOpts,
    engine: ContainerEngine<TOpts>,
    mode: { image: string; installers: Installer[] },
  ) {
    super(opts, engine);
    this.image = mode.image;
    this.installers = mode.installers;
  }

  protected async getImage(): Promise<string> {
    return this.image;
  }

  protected async configure(
    container: EngineContainer,
    image: string,
  ): Promise<void> {
    const ctx = container.installerContext(image);
    for (const installer of this.installers) {
      await installer.install(ctx);
    }
  }
}

/**
 * Builds a custom image from a Dockerfile (content-hash caching), delegating the
 * build invocation to `engine.buildImage`. Shared by both engines — the tag
 * computation and existence check are common; only the build dialect differs.
 * Runs no post-start configuration — the Dockerfile defines the image.
 */
export class ContainerfileStrategy<
  TOpts extends CommonSandboxOptions = CommonSandboxOptions,
> extends ContainerSandboxStrategy<TOpts> {
  private dockerfile: string;
  private dockerContext: string;
  private showBuildLogs: boolean;
  private identity?: string;

  constructor(
    opts: TOpts,
    engine: ContainerEngine<TOpts>,
    mode: {
      dockerfile: string;
      context: string;
      showBuildLogs: boolean;
      identity?: string;
    },
  ) {
    super(opts, engine);
    this.dockerfile = mode.dockerfile;
    this.dockerContext = mode.context;
    this.showBuildLogs = mode.showBuildLogs;
    this.identity = mode.identity;
  }

  protected async getImage(): Promise<string> {
    const content = this.dockerfile.includes('\n')
      ? this.dockerfile
      : readFileSync(this.dockerfile, 'utf-8');
    // Fold the platform/arch identity into the cache key so a native build and
    // an emulated cross-arch build of the same Dockerfile don't collide.
    const tag = `sandbox-${createHash('sha256')
      .update(content)
      .update(this.identity ?? '')
      .digest('hex')
      .slice(0, 12)}`;
    if (!(await this.engine.imageExists(tag))) {
      await this.engine.buildImage({
        tag,
        dockerfile: this.dockerfile,
        context: this.dockerContext,
        showBuildLogs: this.showBuildLogs,
        identity: this.identity,
      });
    }
    return tag;
  }

  protected async configure(): Promise<void> {}
}
