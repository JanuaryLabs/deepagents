import { type CommandResult } from 'bash-tool';
import spawn, { type SubprocessError } from 'nano-spawn';
import { spawn as childSpawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

import {
  base64ReadCommand,
  base64WriteCommands,
  toSandboxProcess,
} from './cli-process.ts';
import type {
  CommonSandboxOptions,
  ContainerEngine,
  SandboxNamedVolume,
  SandboxVolume,
} from './container-engine.ts';
import { ContainerSandboxError } from './container-sandbox-errors.ts';
import { type Installer } from './installers/installer.ts';
import { shellQuote } from './shell-quote.ts';
import type {
  DisposableSandbox,
  ExecuteCommandOptions,
  SandboxProcess,
  SpawnOptions,
} from './types.ts';

interface StrategyContext {
  containerId: string;
  image: string;
}

const CONTAINER_NAME_PATTERN = /^[A-Za-z0-9_.-]+$/;

/**
 * Template Method base for sandbox creation strategies, shared across engines.
 * Subclasses choose the image and define post-start configuration; the base owns
 * container lifecycle, exec, and file I/O, delegating every CLI dialect to the
 * injected {@link ContainerEngine}. Typed to {@link CommonSandboxOptions} so the
 * skeleton can never read an engine-only knob.
 */
export abstract class ContainerSandboxStrategy<
  TOpts extends CommonSandboxOptions = CommonSandboxOptions,
> {
  protected context!: StrategyContext;
  protected engine: ContainerEngine<TOpts>;
  protected opts: TOpts;
  protected volumes: SandboxVolume[];
  protected name?: string;
  protected workdir: string;
  private createdVolumes = new Set<string>();

  constructor(opts: TOpts, engine: ContainerEngine<TOpts>) {
    this.opts = opts;
    this.engine = engine;
    const { volumes = [], env = {}, name, workdir = '/workspace' } = opts;
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
    this.name = name;
    this.workdir = workdir;
  }

  async create(): Promise<DisposableSandbox> {
    const image = await this.getImage();
    let acquired: { containerId: string; attached: boolean } | undefined;

    try {
      acquired = await this.acquireContainer(image);
      this.context = { containerId: acquired.containerId, image };
      if (!acquired.attached) {
        await this.engine.ensureWorkdir(this.context.containerId, this.workdir);
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
      // A name collision means another caller created this named container
      // between our inspect and run (a TOCTOU). Reprobe and attach if it is a
      // usable container. `inspectContainer` fails loud on an unexpected state
      // (a half-built container left by a runtime race throws rather than
      // parsing as running), so we never attach to a broken one.
      if (this.engine.isNameConflict(this.engine.errorMessage(error))) {
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
      const message = this.engineErrorMessage(error);
      if (this.isServiceDown(message)) {
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
      const message = this.engineErrorMessage(error);
      if (this.isServiceDown(message)) {
        throw this.engine.errors.serviceNotAvailable();
      }
      if (this.engine.isMissingContainer(message)) {
        return 'absent';
      }
      throw this.engine.errors.generic(
        `Failed to inspect container "${containerId}": ${message}`,
      );
    }
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

  protected buildRunArgs(image: string, containerId: string): string[] {
    return this.engine.runArgs(image, containerId, this.opts, this.workdir);
  }

  private async inspectVolume(name: string): Promise<void> {
    try {
      await spawn(this.engine.cli, ['volume', 'inspect', name]);
    } catch (error) {
      const reason = this.engineErrorMessage(error);
      if (this.isServiceDown(reason)) {
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

  private async createVolume(volume: SandboxNamedVolume): Promise<void> {
    const args = this.engine.volumeCreateArgs(volume);

    try {
      await spawn(this.engine.cli, args);
    } catch (error) {
      const reason = this.engineErrorMessage(error);
      if (this.isServiceDown(reason)) {
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
        const reason = this.engineErrorMessage(error);
        if (this.isServiceDown(reason)) {
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

  private engineErrorMessage(error: unknown): string {
    return this.engine.errorMessage(error);
  }

  private isServiceDown(message: string): boolean {
    return this.engine.isServiceDown(message);
  }

  protected async startContainer(
    image: string,
    containerId: string,
  ): Promise<void> {
    const args = this.buildRunArgs(image, containerId);

    try {
      await spawn(this.engine.cli, args);
    } catch (error) {
      const message = this.engineErrorMessage(error);
      if (this.isServiceDown(message)) {
        throw this.engine.errors.serviceNotAvailable();
      }
      throw this.engine.errors.creation(message, image, error as Error);
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
      const err = error as SubprocessError;
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
}

/**
 * Starts a vanilla image and runs the supplied installers in order. Shared by
 * both engines — the post-start installer context comes from
 * `engine.createInstallerContext`, so the same class drives `docker exec` and
 * `container exec`.
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

  protected async configure(): Promise<void> {
    const ctx = this.engine.createInstallerContext(
      this.context.containerId,
      this.image,
    );
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
