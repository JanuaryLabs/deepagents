import { ContainerSandboxError } from './container-sandbox-errors.ts';

export class AppleContainerSandboxError extends ContainerSandboxError {
  constructor(message: string, containerId?: string) {
    super(message, containerId);
    this.name = 'AppleContainerSandboxError';
  }
}

/**
 * Raised when the `container` apiserver is not running. Unlike Docker's
 * always-on daemon, Apple's service is started on demand with
 * `container system start` (and needs a guest kernel configured via
 * `container system kernel set --recommended`).
 */
export class ContainerServiceNotRunningError extends AppleContainerSandboxError {
  constructor() {
    super(
      'Apple container service is not running. Start it with `container system start` ' +
        '(first run also needs `container system kernel set --recommended`).',
    );
    this.name = 'ContainerServiceNotRunningError';
  }
}

export class AppleContainerCreationError extends AppleContainerSandboxError {
  readonly image: string;
  override cause?: Error;

  constructor(message: string, image: string, cause?: Error) {
    super(`Failed to create container from image "${image}": ${message}`);
    this.name = 'AppleContainerCreationError';
    this.image = image;
    this.cause = cause;
  }
}

export class AppleContainerImageBuildError extends AppleContainerSandboxError {
  readonly stderr: string;

  constructor(stderr: string) {
    super(`Container image build failed: ${stderr}`);
    this.name = 'AppleContainerImageBuildError';
    this.stderr = stderr;
  }
}

export class AppleContainerVolumePathError extends AppleContainerSandboxError {
  readonly source: string;
  readonly containerPath: string;
  readonly reason: string;

  constructor(source: string, containerPath: string, reason: string) {
    super(
      `Invalid container volume path "${source}" -> "${containerPath}": ${reason}`,
    );
    this.name = 'AppleContainerVolumePathError';
    this.source = source;
    this.containerPath = containerPath;
    this.reason = reason;
  }
}

export class AppleContainerVolumeInspectError extends AppleContainerSandboxError {
  readonly volume: string;
  readonly reason: string;

  constructor(volume: string, reason: string) {
    super(`Failed to inspect container volume "${volume}": ${reason}`);
    this.name = 'AppleContainerVolumeInspectError';
    this.volume = volume;
    this.reason = reason;
  }
}

export class AppleContainerVolumeCreateError extends AppleContainerSandboxError {
  readonly volume: string;
  readonly reason: string;

  constructor(volume: string, reason: string) {
    super(`Failed to create container volume "${volume}": ${reason}`);
    this.name = 'AppleContainerVolumeCreateError';
    this.volume = volume;
    this.reason = reason;
  }
}

export class AppleContainerVolumeRemoveError extends AppleContainerSandboxError {
  readonly volume: string;
  readonly reason: string;

  constructor(volume: string, reason: string) {
    super(`Failed to remove container volume "${volume}": ${reason}`);
    this.name = 'AppleContainerVolumeRemoveError';
    this.volume = volume;
    this.reason = reason;
  }
}
