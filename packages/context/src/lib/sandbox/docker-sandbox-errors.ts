export class DockerSandboxError extends Error {
  readonly containerId?: string;

  constructor(message: string, containerId?: string) {
    super(message);
    this.name = 'DockerSandboxError';
    this.containerId = containerId;
  }
}

export class DockerNotAvailableError extends DockerSandboxError {
  constructor() {
    super('Docker is not available. Ensure Docker daemon is running.');
    this.name = 'DockerNotAvailableError';
  }
}

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
 * Discriminator for `InstallError`. Most values are fetch sources (`'npm'`,
 * `'pypi'`, `'url'`, `'github-release'`); `'bin'` covers the local-filesystem
 * `BinInstaller` which has no remote source.
 */
export type InstallKind = 'url' | 'npm' | 'pypi' | 'github-release' | 'bin';

export interface InstallErrorOptions {
  /** Logical name of the thing being installed (e.g. `'prettier'`, `'presenterm'`). */
  target: string;
  /** Installer kind (registry, URL, local binary, …). */
  source: InstallKind;
  /** Underlying failure message (typically stderr). */
  reason: string;
  /** Resolved URL when applicable (URL binary / GitHub release). */
  url?: string;
  containerId?: string;
}

export class InstallError extends DockerSandboxError {
  readonly target: string;
  readonly source: InstallKind;
  readonly reason: string;
  readonly url?: string;

  constructor(opts: InstallErrorOptions) {
    const where = opts.url ? `${opts.source} (${opts.url})` : opts.source;
    super(
      `Failed to install "${opts.target}" via ${where}: ${opts.reason}`,
      opts.containerId,
    );
    this.name = 'InstallError';
    this.target = opts.target;
    this.source = opts.source;
    this.reason = opts.reason;
    this.url = opts.url;
  }
}

export class MissingRuntimeError extends DockerSandboxError {
  readonly runtime: string;
  readonly required: string[];

  constructor(
    runtime: string,
    required: string[],
    details?: string,
    containerId?: string,
  ) {
    const base = `Required runtime "${runtime}" is not installed (needs: ${required.join(', ')}).`;
    super(details ? `${base} ${details}` : base, containerId);
    this.name = 'MissingRuntimeError';
    this.runtime = runtime;
    this.required = required;
  }
}

export class VolumePathError extends DockerSandboxError {
  readonly source: string;
  readonly containerPath: string;
  readonly reason: string;

  constructor(source: string, containerPath: string, reason: string) {
    super(
      `Invalid Docker volume path "${source}" -> "${containerPath}": ${reason}`,
    );
    this.name = 'VolumePathError';
    this.source = source;
    this.containerPath = containerPath;
    this.reason = reason;
  }
}

export class VolumeInspectError extends DockerSandboxError {
  readonly volume: string;
  readonly reason: string;

  constructor(volume: string, reason: string) {
    super(`Failed to inspect Docker volume "${volume}": ${reason}`);
    this.name = 'VolumeInspectError';
    this.volume = volume;
    this.reason = reason;
  }
}

export class VolumeCreateError extends DockerSandboxError {
  readonly volume: string;
  readonly reason: string;

  constructor(volume: string, reason: string) {
    super(`Failed to create Docker volume "${volume}": ${reason}`);
    this.name = 'VolumeCreateError';
    this.volume = volume;
    this.reason = reason;
  }
}

export class VolumeRemoveError extends DockerSandboxError {
  readonly volume: string;
  readonly reason: string;

  constructor(volume: string, reason: string) {
    super(`Failed to remove Docker volume "${volume}": ${reason}`);
    this.name = 'VolumeRemoveError';
    this.volume = volume;
    this.reason = reason;
  }
}

export class DockerfileBuildError extends DockerSandboxError {
  readonly stderr: string;

  constructor(stderr: string) {
    super(`Dockerfile build failed: ${stderr}`);
    this.name = 'DockerfileBuildError';
    this.stderr = stderr;
  }
}

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
