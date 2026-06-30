/**
 * Shared base for every container-sandbox error across engines (Docker, Apple
 * `container`). Catch this to handle any backend's failure uniformly; catch a
 * specific subclass (e.g. {@link DockerSandboxError}) for engine-specific cases.
 */
export class ContainerSandboxError extends Error {
  readonly containerId?: string;

  constructor(message: string, containerId?: string) {
    super(message);
    this.name = 'ContainerSandboxError';
    this.containerId = containerId;
  }
}
