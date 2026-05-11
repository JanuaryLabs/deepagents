import { type CommandResult } from 'bash-tool';
import spawn from 'nano-spawn';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

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
import type { DisposableSandbox } from './types.ts';

export type { CommandResult as ExecResult, Sandbox } from 'bash-tool';
export {
  ComposeStartError,
  ContainerCreationError,
  DockerNotAvailableError,
  DockerSandboxError,
  DockerfileBuildError,
  type InstallErrorOptions,
  type InstallSource,
  InstallError,
  MissingRuntimeError,
  PackageInstallError,
  VolumeCreateError,
  VolumeInspectError,
  VolumePathError,
  VolumeRemoveError,
} from './docker-sandbox-errors.ts';

export interface DockerBindVolume {
  type: 'bind';
  hostPath: string;
  containerPath: string;
  /** Default: `true`. */
  readOnly?: boolean;
}

export interface DockerNamedVolume {
  type: 'volume';
  name: string;
  containerPath: string;
  /** Default: `true`. */
  readOnly?: boolean;
  /** Default: `'external'`. */
  lifecycle?: 'external' | 'managed';
  /** Docker volume driver used when `lifecycle` is `'managed'`. */
  driver?: string;
  /** Docker volume driver options used when `lifecycle` is `'managed'`. */
  driverOptions?: Record<string, string>;
  subPath?: string;
  noCopy?: boolean;
  /** Default: `true` for managed volumes created by this sandbox. */
  removeOnDispose?: boolean;
}

export type DockerSandboxVolume = DockerBindVolume | DockerNamedVolume;

export interface DockerResources {
  /** e.g. `'1g'`, `'512m'`. */
  memory?: string;
  /** Number of CPUs. */
  cpus?: number;
}

export interface RuntimeSandboxOptions {
  /** Docker image to use (default: `'alpine:latest'`). */
  image?: string;
  /**
   * Ordered list of installers run after the container starts. Use
   * `pkg([...])`, `urlBinary({...})`, `npm(...)`, `pip(...)`,
   * `githubRelease({...})`, or any custom `Installer` subclass.
   */
  installers?: Installer[];
  volumes?: DockerSandboxVolume[];
  resources?: DockerResources;
  env?: Record<string, string>;
}

export interface DockerfileSandboxOptions {
  /** Inline Dockerfile content (contains `\n`) or a path. */
  dockerfile: string;
  /** Build context directory (default: `'.'`). */
  context?: string;
  volumes?: DockerSandboxVolume[];
  resources?: DockerResources;
  env?: Record<string, string>;
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

interface StrategyContext {
  containerId: string;
  image: string;
}

export interface DockerSandboxStrategyArgs {
  volumes?: DockerSandboxVolume[];
  resources?: DockerResources;
  env?: Record<string, string>;
}

/**
 * Template Method base for sandbox creation strategies. Subclasses choose
 * the image and define post-start configuration; the base owns container
 * lifecycle, exec, and file I/O.
 */
export abstract class DockerSandboxStrategy {
  protected context!: StrategyContext;
  protected volumes: DockerSandboxVolume[];
  protected resources: DockerResources;
  protected env: Record<string, string>;
  private createdVolumes = new Set<string>();

  constructor(args: DockerSandboxStrategyArgs = {}) {
    const { volumes = [], resources = {}, env = {} } = args;
    for (const key of Object.keys(env)) {
      if (key.length === 0 || key.includes('=')) {
        throw new DockerSandboxError(
          `Invalid environment variable key: "${key}"`,
        );
      }
    }
    this.volumes = volumes;
    this.resources = resources;
    this.env = env;
  }

  async create(): Promise<DisposableSandbox> {
    const image = await this.getImage();
    let containerId: string | undefined;

    try {
      await this.prepareVolumes();
      containerId = await this.startContainer(image);
      this.context = { containerId, image };
      await this.configure();
    } catch (error) {
      if (containerId) {
        await this.stopContainer(containerId);
      }
      await this.cleanupCreatedVolumesAfterFailure(error);
      throw error;
    }

    return this.createSandboxMethods();
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
        throw new VolumeCreateError(
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
        throw new VolumePathError(
          source,
          volume.containerPath,
          'containerPath must be absolute',
        );
      }
      this.validateMountValue('containerPath', volume.containerPath, volume);

      if (containerPaths.has(volume.containerPath)) {
        throw new VolumePathError(
          source,
          volume.containerPath,
          'containerPath must be unique',
        );
      }
      containerPaths.add(volume.containerPath);

      if (volume.type === 'bind') {
        this.validateMountValue('hostPath', volume.hostPath, volume);
        if (!existsSync(volume.hostPath)) {
          throw new VolumePathError(
            volume.hostPath,
            volume.containerPath,
            'hostPath does not exist on host',
          );
        }
        continue;
      }

      if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(volume.name)) {
        throw new VolumePathError(
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
          throw new VolumePathError(
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
    volume: DockerSandboxVolume,
  ): void {
    if (!value.includes(',')) {
      return;
    }
    const source = volume.type === 'bind' ? volume.hostPath : volume.name;
    throw new VolumePathError(
      source,
      volume.containerPath,
      `${field} must not contain commas`,
    );
  }

  protected buildDockerArgs(image: string, containerId: string): string[] {
    const { memory = '1g', cpus = 2 } = this.resources;

    const args: string[] = [
      'run',
      '-d',
      '--rm',
      '--name',
      containerId,
      `--memory=${memory}`,
      `--cpus=${cpus}`,
      '-w',
      '/workspace',
    ];

    for (const [key, value] of Object.entries(this.env)) {
      args.push('-e', `${key}=${value}`);
    }

    for (const volume of this.volumes) {
      args.push('--mount', this.buildVolumeMountArg(volume));
    }

    args.push(image, 'tail', '-f', '/dev/null');

    return args;
  }

  protected buildVolumeMountArg(volume: DockerSandboxVolume): string {
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

  private async inspectVolume(name: string): Promise<void> {
    try {
      await spawn('docker', ['volume', 'inspect', name]);
    } catch (error) {
      const reason = this.getDockerErrorMessage(error);
      if (this.isDockerUnavailableError(reason)) {
        throw new DockerNotAvailableError();
      }
      throw new VolumeInspectError(name, reason);
    }
  }

  private async volumeExists(name: string): Promise<boolean> {
    try {
      await this.inspectVolume(name);
      return true;
    } catch (error) {
      if (error instanceof VolumeInspectError) {
        if (this.isMissingVolumeInspectError(error.reason)) {
          return false;
        }
        throw error;
      }
      throw error;
    }
  }

  private async createVolume(volume: DockerNamedVolume): Promise<void> {
    const args = ['volume', 'create'];
    if (volume.driver) {
      args.push('--driver', volume.driver);
    }
    for (const [key, value] of Object.entries(volume.driverOptions ?? {})) {
      args.push('--opt', `${key}=${value}`);
    }
    args.push(volume.name);

    try {
      await spawn('docker', args);
    } catch (error) {
      const reason = this.getDockerErrorMessage(error);
      if (this.isDockerUnavailableError(reason)) {
        throw new DockerNotAvailableError();
      }
      throw new VolumeCreateError(volume.name, reason);
    }
  }

  private async cleanupCreatedVolumes(): Promise<void> {
    const volumes = [...this.createdVolumes].reverse();
    for (const volume of volumes) {
      try {
        await spawn('docker', ['volume', 'rm', volume]);
        this.createdVolumes.delete(volume);
      } catch (error) {
        const reason = this.getDockerErrorMessage(error);
        if (this.isDockerUnavailableError(reason)) {
          throw new DockerNotAvailableError();
        }
        throw new VolumeRemoveError(volume, reason);
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

  private getDockerErrorMessage(error: unknown): string {
    const err = error as Error & { stderr?: string; stdout?: string };
    return err.stderr || err.stdout || err.message || String(error);
  }

  private isDockerUnavailableError(message: string): boolean {
    return (
      message.includes('Cannot connect') || message.includes('docker daemon')
    );
  }

  private isMissingVolumeInspectError(message: string): boolean {
    return message.toLowerCase().includes('no such volume');
  }

  protected async startContainer(image: string): Promise<string> {
    const containerId = `sandbox-${crypto.randomUUID().slice(0, 8)}`;
    const args = this.buildDockerArgs(image, containerId);

    try {
      await spawn('docker', args);
    } catch (error) {
      const err = error as Error & { stderr?: string };
      if (
        err.message?.includes('Cannot connect') ||
        err.message?.includes('docker daemon') ||
        err.stderr?.includes('Cannot connect')
      ) {
        throw new DockerNotAvailableError();
      }
      throw new ContainerCreationError(err.message || String(err), image, err);
    }

    return containerId;
  }

  protected async stopContainer(containerId: string): Promise<void> {
    try {
      await spawn('docker', ['stop', containerId]);
    } catch {
      // already stopped
    }
  }

  protected async exec(command: string): Promise<CommandResult> {
    try {
      const result = await spawn('docker', [
        'exec',
        this.context.containerId,
        'sh',
        '-c',
        command,
      ]);
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: 0,
      };
    } catch (error) {
      const err = error as Error & {
        stdout?: string;
        stderr?: string;
        exitCode?: number;
      };
      return {
        stdout: err.stdout || '',
        stderr: err.stderr || err.message || '',
        exitCode: err.exitCode ?? 1,
      };
    }
  }

  protected createSandboxMethods(): DisposableSandbox {
    const { containerId } = this.context;

    const sandbox: DisposableSandbox = {
      executeCommand: async (command: string): Promise<CommandResult> => {
        // Docker exec cancellation is not yet wired; accept and ignore options.
        return this.exec(command);
      },

      readFile: async (path: string): Promise<string> => {
        const result = await sandbox.executeCommand(`base64 "${path}"`);
        if (result.exitCode !== 0) {
          throw new Error(`Failed to read file "${path}": ${result.stderr}`);
        }
        return Buffer.from(result.stdout, 'base64').toString('utf-8');
      },

      writeFiles: async (
        files: Array<{ path: string; content: string }>,
      ): Promise<void> => {
        for (const file of files) {
          const dir = file.path.substring(0, file.path.lastIndexOf('/'));
          if (dir) {
            await sandbox.executeCommand(`mkdir -p "${dir}"`);
          }

          const base64Content = Buffer.from(file.content).toString('base64');
          const result = await sandbox.executeCommand(
            `echo "${base64Content}" | base64 -d > "${file.path}"`,
          );

          if (result.exitCode !== 0) {
            throw new Error(
              `Failed to write file "${file.path}": ${result.stderr}`,
            );
          }
        }
      },

      dispose: async (): Promise<void> => {
        await this.stopContainer(containerId);
        await this.cleanupCreatedVolumes();
      },
    };

    return sandbox;
  }

  protected abstract getImage(): Promise<string>;
  protected abstract configure(): Promise<void>;
}

export interface RuntimeStrategyArgs extends DockerSandboxStrategyArgs {
  image?: string;
  installers?: Installer[];
}

/**
 * Starts a vanilla image and runs the supplied installers in order.
 *
 * @example
 * ```ts
 * new RuntimeStrategy({
 *   image: 'alpine:latest',
 *   installers: [
 *     pkg(['curl', 'jq']),
 *     urlBinary({ name: 'presenterm', url: {...} }),
 *     npm('prettier', { ensureRuntime: true }),
 *   ],
 * });
 * ```
 */
export class RuntimeStrategy extends DockerSandboxStrategy {
  private image: string;
  private installers: Installer[];

  constructor(args: RuntimeStrategyArgs = {}) {
    super({ volumes: args.volumes, resources: args.resources, env: args.env });
    this.image = args.image ?? 'alpine:latest';
    this.installers = args.installers ?? [];
  }

  protected async getImage(): Promise<string> {
    return this.image;
  }

  protected async configure(): Promise<void> {
    const ctx = createInstallerContext(this.context.containerId, this.image);
    for (const installer of this.installers) {
      await installer.install(ctx);
    }
  }
}

export interface DockerfileStrategyArgs extends DockerSandboxStrategyArgs {
  dockerfile: string;
  context?: string;
}

/**
 * Builds a custom image from a Dockerfile (with content-hash caching).
 * Runs no post-start configuration — the Dockerfile defines the image.
 */
export class DockerfileStrategy extends DockerSandboxStrategy {
  private imageTag: string;
  private dockerfile: string;
  private dockerContext: string;

  constructor(args: DockerfileStrategyArgs) {
    super({ volumes: args.volumes, resources: args.resources, env: args.env });
    this.dockerfile = args.dockerfile;
    this.dockerContext = args.context ?? '.';
    this.imageTag = this.computeImageTag();
  }

  private computeImageTag(): string {
    const content = this.isInlineDockerfile()
      ? this.dockerfile
      : readFileSync(this.dockerfile, 'utf-8');
    const hash = createHash('sha256')
      .update(content)
      .digest('hex')
      .slice(0, 12);
    return `sandbox-${hash}`;
  }

  private isInlineDockerfile(): boolean {
    return this.dockerfile.includes('\n');
  }

  protected async getImage(): Promise<string> {
    const exists = await this.imageExists();
    if (!exists) {
      await this.buildImage();
    }
    return this.imageTag;
  }

  protected async configure(): Promise<void> {
    // Dockerfile already configured the image.
  }

  private async imageExists(): Promise<boolean> {
    try {
      await spawn('docker', ['image', 'inspect', this.imageTag]);
      return true;
    } catch {
      return false;
    }
  }

  private async buildImage(): Promise<void> {
    try {
      if (this.isInlineDockerfile()) {
        const buildCmd = `echo '${this.dockerfile.replace(/'/g, "'\\''")}' | docker build -t ${this.imageTag} -f - ${this.dockerContext}`;
        await spawn('sh', ['-c', buildCmd]);
      } else {
        await spawn('docker', [
          'build',
          '-t',
          this.imageTag,
          '-f',
          this.dockerfile,
          this.dockerContext,
        ]);
      }
    } catch (error) {
      const err = error as Error & { stderr?: string };
      throw new DockerfileBuildError(err.stderr || err.message);
    }
  }
}

export interface ComposeStrategyArgs {
  compose: string;
  service: string;
  resources?: DockerResources;
}

/**
 * Manages multi-container environments via `docker compose`.
 * Commands run inside the named service; `dispose()` brings the whole stack down.
 */
export class ComposeStrategy extends DockerSandboxStrategy {
  private projectName: string;
  private composeFile: string;
  private service: string;

  constructor(args: ComposeStrategyArgs) {
    super({ resources: args.resources });
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

  protected override async startContainer(_image: string): Promise<string> {
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
      const err = error as Error & { stderr?: string };
      if (err.stderr?.includes('Cannot connect')) {
        throw new DockerNotAvailableError();
      }
      throw new ComposeStartError(this.composeFile, err.stderr || err.message);
    }

    return this.projectName;
  }

  protected async configure(): Promise<void> {
    // Compose file is the source of truth.
  }

  protected override async exec(command: string): Promise<CommandResult> {
    try {
      const result = await spawn('docker', [
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
      ]);
      return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
    } catch (error) {
      const err = error as Error & {
        stdout?: string;
        stderr?: string;
        exitCode?: number;
      };
      return {
        stdout: err.stdout || '',
        stderr: err.stderr || err.message || '',
        exitCode: err.exitCode ?? 1,
      };
    }
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
  let strategy: DockerSandboxStrategy;

  if (isComposeOptions(options)) {
    strategy = new ComposeStrategy({
      compose: options.compose,
      service: options.service,
      resources: options.resources,
    });
  } else if (isDockerfileOptions(options)) {
    strategy = new DockerfileStrategy({
      dockerfile: options.dockerfile,
      context: options.context,
      volumes: options.volumes,
      resources: options.resources,
      env: options.env,
    });
  } else {
    strategy = new RuntimeStrategy({
      image: options.image,
      installers: options.installers,
      volumes: options.volumes,
      resources: options.resources,
      env: options.env,
    });
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
