import {
  createBashTool,
  type CreateBashToolOptions,
  type BashToolkit,
} from 'bash-tool';

import {
  createDockerSandbox,
  isComposeOptions,
  isDockerfileOptions,
  type BinaryInstall,
  type DockerMount,
  type DockerResources,
  type DockerSandbox,
  type DockerSandboxOptions,
} from './docker-sandbox.ts';

/**
 * Base options shared by RuntimeContainerToolOptions and DockerfileContainerToolOptions.
 */
interface BaseContainerToolOptions
  extends Omit<CreateBashToolOptions, 'sandbox' | 'uploadDirectory'> {
  /** Directories to mount from host into the container */
  mounts?: DockerMount[];
  /** Resource limits for the container */
  resources?: DockerResources;
}

/**
 * Options for container tool using RuntimeStrategy.
 * Installs packages/binaries at container runtime.
 */
export interface RuntimeContainerToolOptions extends BaseContainerToolOptions {
  /** Docker image to use (default: 'alpine:latest') */
  image?: string;
  /** Packages to install in the container via package manager (apk/apt) */
  packages?: string[];
  /** Binaries to install from URLs (for tools not in package managers) */
  binaries?: BinaryInstall[];
}

/**
 * Options for container tool using DockerfileStrategy.
 * Builds custom image from Dockerfile (with caching).
 */
export interface DockerfileContainerToolOptions extends BaseContainerToolOptions {
  /** Dockerfile content (if contains newlines) or path to Dockerfile */
  dockerfile: string;
  /** Build context directory (default: '.') */
  context?: string;
}

/**
 * Options for container tool using ComposeStrategy.
 * Manages multi-container environments via Docker Compose.
 */
export interface ComposeContainerToolOptions
  extends Omit<CreateBashToolOptions, 'sandbox' | 'uploadDirectory'> {
  /** Path to docker-compose.yml file */
  compose: string;
  /** Service name to execute commands in (required) */
  service: string;
  /** Resource limits for the container */
  resources?: DockerResources;
  // Note: mounts must be defined in compose file, not here
}

/**
 * Union type for container tool options.
 * - RuntimeContainerToolOptions: Runtime package/binary installation
 * - DockerfileContainerToolOptions: Pre-built images from Dockerfile
 * - ComposeContainerToolOptions: Multi-container environments via Docker Compose
 */
export type ContainerToolOptions =
  | RuntimeContainerToolOptions
  | DockerfileContainerToolOptions
  | ComposeContainerToolOptions;

/**
 * Result of creating a container tool.
 * Extends BashToolkit but with DockerSandbox (which has dispose()) instead of base Sandbox.
 */
export type ContainerToolResult = Omit<BashToolkit, 'sandbox'> & {
  sandbox: DockerSandbox;
};

/**
 * Creates a bash tool that runs in a Docker container.
 *
 * This is a high-level wrapper that combines `createDockerSandbox()` and
 * `createBashTool()` into a single call. It provides a convenient way to
 * get a bash tool that executes real binaries in an isolated container.
 *
 * Supports three strategies:
 * - **RuntimeStrategy**: Uses existing image, installs packages/binaries at runtime
 * - **DockerfileStrategy**: Builds custom image from Dockerfile (with caching)
 * - **ComposeStrategy**: Multi-container environments via Docker Compose
 *
 * @example RuntimeStrategy (default)
 * ```typescript
 * const { bash, tools, sandbox } = await createContainerTool({
 *   packages: ['curl', 'jq'],
 *   mounts: [{
 *     hostPath: process.cwd(),
 *     containerPath: '/workspace',
 *     readOnly: false,
 *   }],
 * });
 *
 * // Use with AI SDK
 * const response = await generateText({
 *   model: yourModel,
 *   tools,
 *   prompt: 'Fetch the weather data and parse it with jq',
 * });
 *
 * // Clean up when done
 * await sandbox.dispose();
 * ```
 *
 * @example DockerfileStrategy
 * ```typescript
 * const { bash, tools, sandbox } = await createContainerTool({
 *   dockerfile: `
 *     FROM python:3.11-slim
 *     RUN pip install pandas numpy
 *   `,
 *   context: '.',
 *   mounts: [{
 *     hostPath: process.cwd(),
 *     containerPath: '/workspace',
 *   }],
 * });
 * ```
 *
 * @example ComposeStrategy
 * ```typescript
 * const { bash, tools, sandbox } = await createContainerTool({
 *   compose: './docker-compose.yml',
 *   service: 'app',
 * });
 * // Commands run in the 'app' service, can reach other services by name
 * await sandbox.dispose();  // Stops ALL services
 * ```
 *
 * @example With hooks for logging
 * ```typescript
 * const { bash, sandbox } = await createContainerTool({
 *   packages: ['python3'],
 *   onBeforeBashCall: ({ command }) => {
 *     console.log('Running:', command);
 *   },
 *   onAfterBashCall: ({ command, result }) => {
 *     console.log(`Exit code: ${result.exitCode}`);
 *   },
 * });
 * ```
 */
export async function createContainerTool(
  options: ContainerToolOptions = {},
): Promise<ContainerToolResult> {
  // Extract sandbox options from bash tool options
  let sandboxOptions: DockerSandboxOptions;
  let bashOptions: Omit<CreateBashToolOptions, 'sandbox' | 'uploadDirectory'>;

  if (isComposeOptions(options)) {
    const { compose, service, resources, ...rest } = options;
    sandboxOptions = { compose, service, resources };
    bashOptions = rest;
  } else if (isDockerfileOptions(options)) {
    const { dockerfile, context, mounts, resources, ...rest } = options;
    sandboxOptions = { dockerfile, context, mounts, resources };
    bashOptions = rest;
  } else {
    const { image, packages, binaries, mounts, resources, ...rest } = options;
    sandboxOptions = { image, packages, binaries, mounts, resources };
    bashOptions = rest;
  }

  // Create the Docker sandbox
  const sandbox = await createDockerSandbox(sandboxOptions);

  // Create the bash tool with our Docker sandbox
  const toolkit = await createBashTool({
    ...bashOptions,
    sandbox,
  });

  return {
    bash: toolkit.bash,
    tools: toolkit.tools,
    sandbox,
  };
}
