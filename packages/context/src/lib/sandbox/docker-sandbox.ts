import { type CommandResult, type Sandbox } from 'bash-tool';
import spawn from 'nano-spawn';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

import {
  ComposeStartError,
  ContainerCreationError,
  DockerNotAvailableError,
  DockerSandboxError,
  DockerfileBuildError,
  MountPathError,
} from './docker-sandbox-errors.ts';
import {
  type Installer,
  createInstallerContext,
} from './installers/installer.ts';

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
  MountPathError,
  PackageInstallError,
} from './docker-sandbox-errors.ts';

export interface DockerMount {
  hostPath: string;
  containerPath: string;
  /** Default: `true`. */
  readOnly?: boolean;
}

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
  mounts?: DockerMount[];
  resources?: DockerResources;
  env?: Record<string, string>;
}

export interface DockerfileSandboxOptions {
  /** Inline Dockerfile content (contains `\n`) or a path. */
  dockerfile: string;
  /** Build context directory (default: `'.'`). */
  context?: string;
  mounts?: DockerMount[];
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

export interface DockerSandbox extends Sandbox {
  dispose(): Promise<void>;
}

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
  mounts?: DockerMount[];
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
  protected mounts: DockerMount[];
  protected resources: DockerResources;
  protected env: Record<string, string>;

  constructor(args: DockerSandboxStrategyArgs = {}) {
    const { mounts = [], resources = {}, env = {} } = args;
    for (const key of Object.keys(env)) {
      if (key.length === 0 || key.includes('=')) {
        throw new DockerSandboxError(
          `Invalid environment variable key: "${key}"`,
        );
      }
    }
    this.mounts = mounts;
    this.resources = resources;
    this.env = env;
  }

  async create(): Promise<DockerSandbox> {
    this.validateMounts();
    const image = await this.getImage();
    const containerId = await this.startContainer(image);
    this.context = { containerId, image };

    try {
      await this.configure();
    } catch (error) {
      await this.stopContainer(containerId);
      throw error;
    }

    return this.createSandboxMethods();
  }

  protected validateMounts(): void {
    for (const mount of this.mounts) {
      if (!existsSync(mount.hostPath)) {
        throw new MountPathError(mount.hostPath, mount.containerPath);
      }
    }
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

    for (const mount of this.mounts) {
      const mode = mount.readOnly !== false ? 'ro' : 'rw';
      args.push('-v', `${mount.hostPath}:${mount.containerPath}:${mode}`);
    }

    args.push(image, 'tail', '-f', '/dev/null');

    return args;
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

  protected createSandboxMethods(): DockerSandbox {
    const { containerId } = this.context;

    const sandbox: DockerSandbox = {
      executeCommand: async (command: string): Promise<CommandResult> => {
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
    super({ mounts: args.mounts, resources: args.resources, env: args.env });
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
    super({ mounts: args.mounts, resources: args.resources, env: args.env });
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
): Promise<DockerSandbox> {
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
      mounts: options.mounts,
      resources: options.resources,
      env: options.env,
    });
  } else {
    strategy = new RuntimeStrategy({
      image: options.image,
      installers: options.installers,
      mounts: options.mounts,
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
  fn: (sandbox: DockerSandbox) => Promise<T>,
): Promise<T> {
  const sandbox = await createDockerSandbox(options);
  try {
    return await fn(sandbox);
  } finally {
    await sandbox.dispose();
  }
}
