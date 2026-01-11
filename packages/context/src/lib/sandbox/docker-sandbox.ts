import { type CommandResult, type Sandbox } from 'bash-tool';
import spawn from 'nano-spawn';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

// Re-export types from bash-tool for convenience
export type { CommandResult as ExecResult, Sandbox } from 'bash-tool';

// ─────────────────────────────────────────────────────────────────────────────
// Error Classes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Base error for all Docker sandbox operations.
 */
export class DockerSandboxError extends Error {
  readonly containerId?: string;

  constructor(message: string, containerId?: string) {
    super(message);
    this.name = 'DockerSandboxError';
    this.containerId = containerId;
  }
}

/**
 * Thrown when Docker daemon is not available.
 */
export class DockerNotAvailableError extends DockerSandboxError {
  constructor() {
    super('Docker is not available. Ensure Docker daemon is running.');
    this.name = 'DockerNotAvailableError';
  }
}

/**
 * Thrown when container creation fails.
 */
export class ContainerCreationError extends DockerSandboxError {
  readonly image: string;
  override cause?: Error;

  constructor(message: string, image: string, cause?: Error) {
    super(`Failed to create container from image "${image}": ${message}`);
    this.name = 'ContainerCreationError';
    this.image = image;
    this.cause = cause;
  }
}

/**
 * Thrown when package installation fails.
 */
export class PackageInstallError extends DockerSandboxError {
  readonly packages: string[];
  readonly image: string;
  readonly packageManager: 'apk' | 'apt-get';
  readonly stderr: string;

  constructor(
    packages: string[],
    image: string,
    packageManager: 'apk' | 'apt-get',
    stderr: string,
    containerId?: string,
  ) {
    super(
      `Package installation failed for [${packages.join(', ')}] ` +
        `using ${packageManager} on ${image}: ${stderr}`,
      containerId,
    );
    this.name = 'PackageInstallError';
    this.packages = packages;
    this.image = image;
    this.packageManager = packageManager;
    this.stderr = stderr;
  }
}

/**
 * Thrown when a binary installation from URL fails.
 */
export class BinaryInstallError extends DockerSandboxError {
  readonly binaryName: string;
  readonly url: string;
  readonly reason: string;

  constructor(
    binaryName: string,
    url: string,
    reason: string,
    containerId?: string,
  ) {
    super(
      `Failed to install binary "${binaryName}" from ${url}: ${reason}`,
      containerId,
    );
    this.name = 'BinaryInstallError';
    this.binaryName = binaryName;
    this.url = url;
    this.reason = reason;
  }
}

/**
 * Thrown when a mount path doesn't exist on the host.
 */
export class MountPathError extends DockerSandboxError {
  readonly hostPath: string;
  readonly containerPath: string;

  constructor(hostPath: string, containerPath: string) {
    super(
      `Mount path does not exist on host: "${hostPath}" -> "${containerPath}"`,
    );
    this.name = 'MountPathError';
    this.hostPath = hostPath;
    this.containerPath = containerPath;
  }
}

/**
 * Thrown when Dockerfile build fails.
 */
export class DockerfileBuildError extends DockerSandboxError {
  readonly stderr: string;

  constructor(stderr: string) {
    super(`Dockerfile build failed: ${stderr}`);
    this.name = 'DockerfileBuildError';
    this.stderr = stderr;
  }
}

/**
 * Thrown when docker compose up fails.
 */
export class ComposeStartError extends DockerSandboxError {
  readonly composeFile: string;
  readonly stderr: string;

  constructor(composeFile: string, stderr: string) {
    super(`Docker Compose failed to start: ${stderr}`);
    this.name = 'ComposeStartError';
    this.composeFile = composeFile;
    this.stderr = stderr;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Interfaces
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Configuration for mounting a host directory into the container.
 */
export interface DockerMount {
  /** Absolute path on the host machine */
  hostPath: string;
  /** Path inside the container */
  containerPath: string;
  /** Whether the mount is read-only (default: true) */
  readOnly?: boolean;
}

/**
 * Resource limits for the container.
 */
export interface DockerResources {
  /** Memory limit (e.g., '1g', '512m') */
  memory?: string;
  /** CPU limit (number of CPUs) */
  cpus?: number;
}

/**
 * Architecture-specific URL mapping for binary downloads.
 * Maps container architecture (from `uname -m`) to download URLs.
 */
export interface ArchitectureUrls {
  /** URL for x86_64 architecture (amd64) */
  x86_64?: string;
  /** URL for ARM64 architecture (aarch64) */
  aarch64?: string;
  /** URL for ARMv7 architecture */
  armv7l?: string;
}

/**
 * Configuration for installing a binary from a URL.
 *
 * Binaries are downloaded, extracted (if tar.gz), and installed to /usr/local/bin.
 */
export interface BinaryInstall {
  /** Name of the binary (used for the final executable name) */
  name: string;
  /**
   * URL or architecture-specific URLs.
   * - If a string, used for all architectures
   * - If ArchitectureUrls, selects based on container architecture
   */
  url: string | ArchitectureUrls;
  /**
   * Optional: The binary filename inside the archive if different from `name`.
   * Useful when the archive contains versioned binaries like "presenterm-0.15.1".
   */
  binaryPath?: string;
}

/**
 * Options for RuntimeStrategy - installs packages/binaries at container runtime.
 */
export interface RuntimeSandboxOptions {
  /** Docker image to use (default: 'alpine:latest') */
  image?: string;
  /** Packages to install in the container via package manager (apk/apt) */
  packages?: string[];
  /** Binaries to install from URLs (for tools not in package managers) */
  binaries?: BinaryInstall[];
  /** Directories to mount from host */
  mounts?: DockerMount[];
  /** Resource limits */
  resources?: DockerResources;
}

/**
 * Options for DockerfileStrategy - builds custom image from Dockerfile.
 */
export interface DockerfileSandboxOptions {
  /** Dockerfile content (if contains newlines) or path to Dockerfile */
  dockerfile: string;
  /** Build context directory (default: '.') */
  context?: string;
  /** Directories to mount from host */
  mounts?: DockerMount[];
  /** Resource limits */
  resources?: DockerResources;
}

/**
 * Options for ComposeStrategy - manages multi-container environments.
 */
export interface ComposeSandboxOptions {
  /** Path to docker-compose.yml file */
  compose: string;
  /** Service name to execute commands in (required) */
  service: string;
  /** Resource limits (applied to target service only) */
  resources?: DockerResources;
  // Note: mounts must be defined in compose file, not here
}

/**
 * Union type for Docker sandbox options.
 * - RuntimeSandboxOptions: Runtime package/binary installation
 * - DockerfileSandboxOptions: Pre-built images from Dockerfile
 * - ComposeSandboxOptions: Multi-container environments via Docker Compose
 */
export type DockerSandboxOptions =
  | RuntimeSandboxOptions
  | DockerfileSandboxOptions
  | ComposeSandboxOptions;

/**
 * Extended sandbox interface with disposal method.
 */
export interface DockerSandbox extends Sandbox {
  /** Stop and remove the container */
  dispose(): Promise<void>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Detects if the image is Debian-based (uses apt-get) or Alpine-based (uses apk).
 */
function isDebianBased(image: string): boolean {
  const debianPatterns = ['debian', 'ubuntu', 'node', 'python'];
  return debianPatterns.some((pattern) =>
    image.toLowerCase().includes(pattern),
  );
}

/**
 * Type guard to determine if options are for DockerfileStrategy.
 */
export function isDockerfileOptions(
  opts: DockerSandboxOptions,
): opts is DockerfileSandboxOptions {
  return 'dockerfile' in opts;
}

/**
 * Type guard to determine if options are for ComposeStrategy.
 */
export function isComposeOptions(
  opts: DockerSandboxOptions,
): opts is ComposeSandboxOptions {
  return 'compose' in opts;
}

// ─────────────────────────────────────────────────────────────────────────────
// Strategy Pattern - Base Class
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Internal context shared across strategy methods.
 */
interface StrategyContext {
  containerId: string;
  image: string;
}

/**
 * Abstract base class for Docker sandbox creation strategies.
 *
 * Uses the Template Method pattern to define the skeleton of the sandbox
 * creation algorithm, deferring specific steps to subclasses.
 *
 * @example Extending the strategy
 * ```typescript
 * class CustomStrategy extends DockerSandboxStrategy {
 *   protected async getImage(): Promise<string> {
 *     // Custom image resolution logic
 *     return 'my-custom-image:latest';
 *   }
 *
 *   protected async configure(): Promise<void> {
 *     // Custom configuration after container starts
 *   }
 * }
 * ```
 */
export abstract class DockerSandboxStrategy {
  protected context!: StrategyContext;
  protected mounts: DockerMount[];
  protected resources: DockerResources;

  constructor(mounts: DockerMount[] = [], resources: DockerResources = {}) {
    this.mounts = mounts;
    this.resources = resources;
  }

  /**
   * Template method - defines the algorithm skeleton for creating a sandbox.
   *
   * Steps:
   * 1. Validate mount paths exist on host
   * 2. Get/build the Docker image (strategy-specific)
   * 3. Start the container
   * 4. Configure the container (strategy-specific)
   * 5. Create and return sandbox methods
   */
  async create(): Promise<DockerSandbox> {
    this.validateMounts();
    const image = await this.getImage();
    const containerId = await this.startContainer(image);
    this.context = { containerId, image };

    try {
      await this.configure();
    } catch (error) {
      // Clean up container if configuration fails
      await this.stopContainer(containerId);
      throw error;
    }

    return this.createSandboxMethods();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Common implementations (shared by all strategies)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Validates that all mount paths exist on the host filesystem.
   */
  protected validateMounts(): void {
    for (const mount of this.mounts) {
      if (!existsSync(mount.hostPath)) {
        throw new MountPathError(mount.hostPath, mount.containerPath);
      }
    }
  }

  /**
   * Builds the docker run command arguments.
   */
  protected buildDockerArgs(image: string, containerId: string): string[] {
    const { memory = '1g', cpus = 2 } = this.resources;

    const args: string[] = [
      'run',
      '-d', // Detached mode
      '--rm', // Remove container when stopped
      '--name',
      containerId,
      `--memory=${memory}`,
      `--cpus=${cpus}`,
      '-w',
      '/workspace', // Set working directory
    ];

    // Add mounts
    for (const mount of this.mounts) {
      const mode = mount.readOnly !== false ? 'ro' : 'rw';
      args.push('-v', `${mount.hostPath}:${mount.containerPath}:${mode}`);
    }

    // Add image and command to keep container alive
    args.push(image, 'tail', '-f', '/dev/null');

    return args;
  }

  /**
   * Starts a Docker container with the given image.
   */
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

  /**
   * Stops a Docker container.
   */
  protected async stopContainer(containerId: string): Promise<void> {
    try {
      await spawn('docker', ['stop', containerId]);
    } catch {
      // Container may already be stopped, ignore errors
    }
  }

  /**
   * Executes a command in the container.
   */
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

  /**
   * Creates the DockerSandbox interface with all methods.
   */
  protected createSandboxMethods(): DockerSandbox {
    const { containerId } = this.context;

    const sandbox: DockerSandbox = {
      executeCommand: async (command: string): Promise<CommandResult> => {
        return this.exec(command);
      },

      readFile: async (path: string): Promise<string> => {
        // Use base64 encoding to preserve exact content (including trailing newlines)
        // nano-spawn strips trailing newlines from stdout, so we encode/decode
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
          // Create parent directories
          const dir = file.path.substring(0, file.path.lastIndexOf('/'));
          if (dir) {
            await sandbox.executeCommand(`mkdir -p "${dir}"`);
          }

          // Use base64 encoding for binary-safe file writes
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

  // ─────────────────────────────────────────────────────────────────────────
  // Strategy-specific hooks (to be implemented by subclasses)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Returns the Docker image to use for the container.
   * For RuntimeStrategy: returns the image name directly.
   * For DockerfileStrategy: builds the image and returns the tag.
   */
  protected abstract getImage(): Promise<string>;

  /**
   * Configures the container after it starts.
   * For RuntimeStrategy: installs packages and binaries.
   * For DockerfileStrategy: no-op (Dockerfile already configured).
   */
  protected abstract configure(): Promise<void>;
}

// ─────────────────────────────────────────────────────────────────────────────
// RuntimeStrategy - Installs packages/binaries at container runtime
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Strategy that uses an existing Docker image and installs packages/binaries
 * at container runtime.
 *
 * This is the "configure-on-demand" approach - starts a vanilla image and
 * customizes it by executing installation commands.
 *
 * @example
 * ```typescript
 * const strategy = new RuntimeStrategy(
 *   'alpine:latest',
 *   ['curl', 'jq'],
 *   [{ name: 'presenterm', url: {...} }],
 * );
 * const sandbox = await strategy.create();
 * ```
 */
export class RuntimeStrategy extends DockerSandboxStrategy {
  private image: string;
  private packages: string[];
  private binaries: BinaryInstall[];

  constructor(
    image = 'alpine:latest',
    packages: string[] = [],
    binaries: BinaryInstall[] = [],
    mounts?: DockerMount[],
    resources?: DockerResources,
  ) {
    super(mounts, resources);
    this.image = image;
    this.packages = packages;
    this.binaries = binaries;
  }

  protected async getImage(): Promise<string> {
    return this.image;
  }

  protected async configure(): Promise<void> {
    await this.installPackages();
    await this.installBinaries();
  }

  /**
   * Installs packages using the appropriate package manager (apk/apt-get).
   */
  private async installPackages(): Promise<void> {
    if (this.packages.length === 0) return;

    const useApt = isDebianBased(this.image);
    const installCmd = useApt
      ? `apt-get update && apt-get install -y ${this.packages.join(' ')}`
      : `apk add --no-cache ${this.packages.join(' ')}`;

    try {
      await spawn('docker', [
        'exec',
        this.context.containerId,
        'sh',
        '-c',
        installCmd,
      ]);
    } catch (error) {
      const err = error as Error & { stderr?: string };
      throw new PackageInstallError(
        this.packages,
        this.image,
        useApt ? 'apt-get' : 'apk',
        err.stderr || err.message,
        this.context.containerId,
      );
    }
  }

  /**
   * Installs binaries from URLs.
   */
  private async installBinaries(): Promise<void> {
    if (this.binaries.length === 0) return;

    // Ensure curl is available for downloading
    await this.ensureCurl();

    // Detect container architecture
    const arch = await this.detectArchitecture();

    // Install each binary
    for (const binary of this.binaries) {
      await this.installBinary(binary, arch);
    }
  }

  /**
   * Ensures curl is installed in the container.
   */
  private async ensureCurl(): Promise<void> {
    const checkResult = await spawn('docker', [
      'exec',
      this.context.containerId,
      'which',
      'curl',
    ]).catch(() => null);

    if (checkResult) return; // curl already installed

    const useApt = isDebianBased(this.image);
    const curlInstallCmd = useApt
      ? 'apt-get update && apt-get install -y curl'
      : 'apk add --no-cache curl';

    try {
      await spawn('docker', [
        'exec',
        this.context.containerId,
        'sh',
        '-c',
        curlInstallCmd,
      ]);
    } catch (error) {
      const err = error as Error & { stderr?: string };
      throw new BinaryInstallError(
        'curl',
        'package-manager',
        `Required for binary downloads: ${err.stderr || err.message}`,
        this.context.containerId,
      );
    }
  }

  /**
   * Detects the container's CPU architecture.
   */
  private async detectArchitecture(): Promise<string> {
    try {
      const result = await spawn('docker', [
        'exec',
        this.context.containerId,
        'uname',
        '-m',
      ]);
      return result.stdout.trim();
    } catch (error) {
      const err = error as Error & { stderr?: string };
      throw new DockerSandboxError(
        `Failed to detect container architecture: ${err.stderr || err.message}`,
        this.context.containerId,
      );
    }
  }

  /**
   * Installs a single binary from URL.
   */
  private async installBinary(
    binary: BinaryInstall,
    arch: string,
  ): Promise<void> {
    // Resolve URL based on architecture
    let url: string;
    if (typeof binary.url === 'string') {
      url = binary.url;
    } else {
      const archUrl = binary.url[arch as keyof ArchitectureUrls];
      if (!archUrl) {
        throw new BinaryInstallError(
          binary.name,
          `arch:${arch}`,
          `No URL provided for architecture "${arch}". Available: ${Object.keys(binary.url).join(', ')}`,
          this.context.containerId,
        );
      }
      url = archUrl;
    }

    // Download and install the binary
    const isTarGz = url.endsWith('.tar.gz') || url.endsWith('.tgz');
    let installCmd: string;

    if (isTarGz) {
      const binaryPathInArchive = binary.binaryPath || binary.name;
      installCmd = `
        set -e
        TMPDIR=$(mktemp -d)
        cd "$TMPDIR"
        curl -fsSL "${url}" -o archive.tar.gz
        tar -xzf archive.tar.gz
        BINARY_FILE=$(find . -name "${binaryPathInArchive}" -o -name "${binary.name}" | head -1)
        if [ -z "$BINARY_FILE" ]; then
          echo "Binary not found in archive. Contents:" >&2
          find . -type f >&2
          exit 1
        fi
        chmod +x "$BINARY_FILE"
        mv "$BINARY_FILE" /usr/local/bin/${binary.name}
        cd /
        rm -rf "$TMPDIR"
      `;
    } else {
      installCmd = `
        curl -fsSL "${url}" -o /usr/local/bin/${binary.name}
        chmod +x /usr/local/bin/${binary.name}
      `;
    }

    try {
      await spawn('docker', [
        'exec',
        this.context.containerId,
        'sh',
        '-c',
        installCmd,
      ]);
    } catch (error) {
      const err = error as Error & { stderr?: string };
      throw new BinaryInstallError(
        binary.name,
        url,
        err.stderr || err.message,
        this.context.containerId,
      );
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DockerfileStrategy - Builds image from Dockerfile
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Strategy that builds a custom Docker image from a Dockerfile.
 *
 * This is the "build-once, run-many" approach - builds the image upfront
 * (with caching) and runs containers from the pre-configured image.
 *
 * Image caching: Uses a deterministic tag based on Dockerfile content hash.
 * If the same Dockerfile is used, the existing image is reused (cache hit).
 *
 * @example Inline Dockerfile
 * ```typescript
 * const strategy = new DockerfileStrategy(`
 *   FROM alpine:latest
 *   RUN apk add --no-cache curl jq
 * `);
 * const sandbox = await strategy.create();
 * ```
 *
 * @example Dockerfile path
 * ```typescript
 * const strategy = new DockerfileStrategy(
 *   './Dockerfile.sandbox',
 *   './docker',  // build context
 * );
 * const sandbox = await strategy.create();
 * ```
 */
export class DockerfileStrategy extends DockerSandboxStrategy {
  private imageTag: string;
  private dockerfile: string;
  private dockerContext: string;

  constructor(
    dockerfile: string,
    dockerContext = '.',
    mounts?: DockerMount[],
    resources?: DockerResources,
  ) {
    super(mounts, resources);
    this.dockerfile = dockerfile;
    this.dockerContext = dockerContext;
    this.imageTag = this.computeImageTag();
  }

  /**
   * Computes a deterministic image tag based on Dockerfile content.
   * Same Dockerfile → same tag → Docker skips rebuild if image exists.
   */
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

  /**
   * Checks if the dockerfile property is inline content or a file path.
   */
  private isInlineDockerfile(): boolean {
    return this.dockerfile.includes('\n');
  }

  protected async getImage(): Promise<string> {
    // Check if image already exists (cache hit)
    const exists = await this.imageExists();
    if (!exists) {
      await this.buildImage();
    }
    return this.imageTag;
  }

  protected async configure(): Promise<void> {
    // No-op - Dockerfile already configured the image
  }

  /**
   * Checks if the image already exists locally.
   */
  private async imageExists(): Promise<boolean> {
    try {
      await spawn('docker', ['image', 'inspect', this.imageTag]);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Builds the Docker image from the Dockerfile.
   */
  private async buildImage(): Promise<void> {
    try {
      if (this.isInlineDockerfile()) {
        // Inline Dockerfile - use heredoc via shell
        const buildCmd = `echo '${this.dockerfile.replace(/'/g, "'\\''")}' | docker build -t ${this.imageTag} -f - ${this.dockerContext}`;
        await spawn('sh', ['-c', buildCmd]);
      } else {
        // Path to Dockerfile
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

// ─────────────────────────────────────────────────────────────────────────────
// ComposeStrategy - Multi-container environments via Docker Compose
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Strategy that manages multi-container environments using Docker Compose.
 *
 * Unlike other strategies that manage a single container, ComposeStrategy
 * orchestrates multiple services as a unit using docker compose commands.
 *
 * @example
 * ```typescript
 * const strategy = new ComposeStrategy(
 *   './docker-compose.yml',
 *   'app',  // Service to execute commands in
 * );
 * const sandbox = await strategy.create();
 *
 * // Commands run in the 'app' service
 * await sandbox.executeCommand('node --version');
 *
 * // Can communicate with other services via service names
 * await sandbox.executeCommand('curl http://api:3000/health');
 *
 * // Stops ALL services
 * await sandbox.dispose();
 * ```
 */
export class ComposeStrategy extends DockerSandboxStrategy {
  private projectName: string;
  private composeFile: string;
  private service: string;

  constructor(
    composeFile: string,
    service: string,
    resources?: DockerResources,
  ) {
    // Pass empty mounts - compose handles its own volumes
    super([], resources);
    this.composeFile = composeFile;
    this.service = service;
    this.projectName = this.computeProjectName();
  }

  /**
   * Deterministic project name based on compose file content for caching.
   * Same compose file → same project name → faster subsequent startups.
   */
  private computeProjectName(): string {
    const content = readFileSync(this.composeFile, 'utf-8');
    const hash = createHash('sha256').update(content).digest('hex').slice(0, 8);
    return `sandbox-${hash}`;
  }

  /**
   * Override: No image to get - compose manages its own images.
   */
  protected async getImage(): Promise<string> {
    return ''; // Not used for compose
  }

  /**
   * Override: Start all services with docker compose up.
   */
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

    // Return project name as the "container ID" for context
    return this.projectName;
  }

  protected async configure(): Promise<void> {
    // No additional configuration - compose file defines everything
  }

  /**
   * Override: Execute commands in the target service.
   */
  protected override async exec(command: string): Promise<CommandResult> {
    try {
      const result = await spawn('docker', [
        'compose',
        '-f',
        this.composeFile,
        '-p',
        this.projectName,
        'exec',
        '-T', // -T disables pseudo-TTY
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

  /**
   * Override: Stop all services with docker compose down.
   */
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
      // Ignore cleanup errors
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory Function
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates a Docker-based sandbox for executing commands in an isolated container.
 *
 * Supports three strategies:
 * - **RuntimeStrategy**: Uses existing image, installs packages/binaries at runtime
 * - **DockerfileStrategy**: Builds custom image from Dockerfile (with caching)
 * - **ComposeStrategy**: Multi-container environments via Docker Compose
 *
 * @example RuntimeStrategy (default)
 * ```typescript
 * const sandbox = await createDockerSandbox({
 *   image: 'alpine:latest',
 *   packages: ['curl', 'jq'],
 *   binaries: [{ name: 'presenterm', url: {...} }],
 * });
 * await sandbox.executeCommand('curl --version');
 * await sandbox.dispose();
 * ```
 *
 * @example DockerfileStrategy
 * ```typescript
 * const sandbox = await createDockerSandbox({
 *   dockerfile: `
 *     FROM alpine:latest
 *     RUN apk add --no-cache curl jq
 *   `,
 *   context: '.',
 * });
 * await sandbox.executeCommand('curl --version');
 * await sandbox.dispose();
 * ```
 *
 * @example ComposeStrategy
 * ```typescript
 * const sandbox = await createDockerSandbox({
 *   compose: './docker-compose.yml',
 *   service: 'app',
 * });
 * // Commands run in the 'app' service
 * await sandbox.executeCommand('node --version');
 * // Can reach other services by name
 * await sandbox.executeCommand('curl http://db:5432');
 * await sandbox.dispose();  // Stops ALL services
 * ```
 */
export async function createDockerSandbox(
  options: DockerSandboxOptions = {},
): Promise<DockerSandbox> {
  let strategy: DockerSandboxStrategy;

  if (isComposeOptions(options)) {
    strategy = new ComposeStrategy(
      options.compose,
      options.service,
      options.resources,
    );
  } else if (isDockerfileOptions(options)) {
    strategy = new DockerfileStrategy(
      options.dockerfile,
      options.context,
      options.mounts,
      options.resources,
    );
  } else {
    strategy = new RuntimeStrategy(
      options.image,
      options.packages,
      options.binaries,
      options.mounts,
      options.resources,
    );
  }

  return strategy.create();
}

/**
 * Execute a function with a Docker sandbox that auto-disposes on completion.
 * Ensures cleanup even if the function throws.
 *
 * @example
 * ```typescript
 * const output = await useSandbox(
 *   { packages: ['curl', 'jq'] },
 *   async (sandbox) => {
 *     const result = await sandbox.executeCommand('curl --version');
 *     return result.stdout;
 *   },
 * );
 * // Container is automatically disposed - no try/finally needed
 * ```
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
