import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

import type {
  ChatContainerEngine,
  ChatEngineContainer,
  CommonSandboxOptions,
  ContainerEngine,
  EngineContainer,
  SandboxVolume,
} from './container-engine.ts';
import { containerSession, validateEnv } from './container-session.ts';
import { type Installer } from './installers/installer.ts';
import { guardSession } from './session.ts';
import { type DisposableSandbox, SandboxNotFoundError } from './types.ts';

/** Records a cleanup failure on the error that started the cleanup. */
function suppress(originalError: unknown, cleanupError: unknown): void {
  if (!Error.isError(originalError)) return;
  const suppressed: unknown[] =
    'suppressed' in originalError && Array.isArray(originalError.suppressed)
      ? originalError.suppressed
      : [];
  Object.assign(originalError, { suppressed: [...suppressed, cleanupError] });
}

/**
 * Template Method base for sandbox creation strategies, shared across engines.
 * Subclasses choose the image and define post-start configuration; the base owns
 * the container lifecycle (create, volumes, disposal) and delegates every
 * engine operation to the injected {@link ContainerEngine}. Typed to
 * {@link CommonSandboxOptions} so the skeleton can never read an engine-only
 * knob.
 */
export abstract class ContainerSandboxStrategy<
  TOpts extends CommonSandboxOptions = CommonSandboxOptions,
  TEngine extends ContainerEngine<TOpts> = ContainerEngine<TOpts>,
> {
  protected engine: TEngine;
  protected opts: TOpts;
  protected volumes: SandboxVolume[];
  protected workdir: string;
  private createdVolumes = new Set<string>();

  constructor(opts: TOpts, engine: TEngine) {
    this.opts = opts;
    this.engine = engine;
    validateEnv(opts.env, engine.errors);
    const { volumes = [], workdir = '/workspace' } = opts;
    this.volumes = volumes;
    this.workdir = workdir;
  }

  /**
   * Creates a one-off sandbox in a container of its own, which nothing else
   * reaches. On failure, everything it made is released and the engine is
   * disposed.
   */
  async create(): Promise<DisposableSandbox> {
    let container: EngineContainer | undefined;

    try {
      const image = await this.getImage();
      container = await this.acquireContainer(image);
      await this.engine.ensureWorkdir(container, this.workdir);
      await this.configure(container, image);
      await this.assertBashAvailable(container);
    } catch (error) {
      if (container) {
        await this.release(container).catch((stopError: unknown) =>
          suppress(error, stopError),
        );
      }
      await this.cleanupCreatedVolumes().catch((cleanupError: unknown) =>
        suppress(error, cleanupError),
      );
      await this.engine.dispose();
      throw error;
    }

    const sandbox = this.createSandboxMethods(container);
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

  /**
   * The running chat container `name`: unpaused or started when it exists,
   * created with `labels` and configured when it does not. A create that
   * another caller won takes the winner's container. A container this call
   * created and could not configure is removed. The engine stays open.
   */
  async openChat(
    this: ContainerSandboxStrategy<TOpts, ChatContainerEngine<TOpts>>,
    name: string,
    labels: Record<string, string>,
  ): Promise<ChatEngineContainer> {
    const found = await this.engine.find(name);
    if (found) {
      try {
        await found.resume();
        return found;
      } catch (error) {
        if (!(error instanceof SandboxNotFoundError)) throw error;
      }
    }

    const image = await this.getImage();
    await this.prepareVolumes();
    const { created, container } = await this.engine.createChat(
      image,
      name,
      this.opts,
      this.workdir,
      labels,
    );
    if (!created) {
      await container.resume();
      return container;
    }
    try {
      await this.engine.ensureWorkdir(container, this.workdir);
      await this.configure(container, image);
      await this.assertBashAvailable(container);
    } catch (error) {
      await container
        .remove()
        .catch((removeError: unknown) => suppress(error, removeError));
      throw error;
    }
    return container;
  }

  /** Runs the one-off's container under a generated name. */
  protected async acquireContainer(image: string): Promise<EngineContainer> {
    const name = `sandbox-${randomUUID().slice(0, 8)}`;
    await this.prepareVolumes();
    const result = await this.engine.run(image, name, this.opts, this.workdir);
    if (result.created) return result.container;
    await this.cleanupCreatedVolumes();
    throw this.engine.errors.generic(
      `Container name "${name}" is already in use`,
    );
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

  /** Ends a container that this sandbox created: stops it, by default. */
  protected release(container: EngineContainer): Promise<void> {
    return container.stop();
  }

  private async assertBashAvailable(container: EngineContainer): Promise<void> {
    const result = await container.exec(['bash', '-lc', ':']);
    if (result.exitCode === 0) return;
    const detail = result.stderr.trim() || result.stdout.trim();
    throw this.engine.errors.generic(
      `Bash is required to execute sandbox commands but could not be started${detail ? `: ${detail}` : '.'}`,
      container.name,
    );
  }

  /**
   * The one-off's session and its `dispose`, which runs once. Once `dispose`
   * is called, every operation rejects with an Error that names the sandbox,
   * never with `SandboxNotFoundError`: using a disposed sandbox is a bug in
   * its owner, not a sandbox that is gone. Before that, the container's
   * `assertCurrent` runs before every operation, for an engine that has one.
   */
  protected createSandboxMethods(
    container: EngineContainer,
  ): DisposableSandbox {
    const { session, release } = guardSession(
      containerSession(container, this.engine.errors),
      {
        release: async () => {
          try {
            await this.release(container);
            await this.cleanupCreatedVolumes();
          } finally {
            await this.engine.dispose();
          }
        },
        releasedMessage: `The sandbox "${container.name}" is disposed.`,
        assertCurrent: () => container.assertCurrent?.(),
      },
    );
    return Object.assign(session, {
      dispose: release,
      [Symbol.asyncDispose]: release,
    });
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
  TEngine extends ContainerEngine<TOpts> = ContainerEngine<TOpts>,
> extends ContainerSandboxStrategy<TOpts, TEngine> {
  private image: string;
  private installers: Installer[];

  constructor(
    opts: TOpts,
    engine: TEngine,
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
  TEngine extends ContainerEngine<TOpts> = ContainerEngine<TOpts>,
> extends ContainerSandboxStrategy<TOpts, TEngine> {
  private dockerfile: string;
  private dockerContext: string;
  private showBuildLogs: boolean;
  private identity?: string;

  constructor(
    opts: TOpts,
    engine: TEngine,
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
