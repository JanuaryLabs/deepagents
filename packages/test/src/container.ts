import spawn from 'nano-spawn';
import { randomUUID } from 'node:crypto';

export interface ContainerConfig {
  image: string;
  name: string;
  env: Record<string, string>;
  internalPort: number;
  tmpfs?: string[];
  ipcHost?: boolean;
  memorySwappiness?: number;
}

export interface Container extends AsyncDisposable {
  containerId: string;
  host: string;
  port: number;
  /**
   * Run a command inside the container via `docker exec`. Resolves with its
   * output; rejects (nano-spawn semantics) on a non-zero exit. Doubles as a
   * readiness probe — it throws until the service answers, e.g.
   * `exec(['redis-cli', 'ping'])`.
   */
  exec: (command: string[]) => Promise<{ stdout: string; stderr: string }>;
  cleanup: () => Promise<void>;
}

/**
 * Check if Docker is available on this machine.
 */
let dockerAvailability: Promise<boolean> | undefined;

/**
 * Whether the Docker daemon is reachable. Memoized for the process — Docker
 * doesn't come and go mid-test-run, and `docker info` costs ~150ms, which the
 * engine helpers would otherwise pay twice per container (pre-check + the check
 * inside {@link startContainer}) and once per test in a per-test suite.
 */
export function isDockerAvailable(): Promise<boolean> {
  return (dockerAvailability ??= probeDockerAvailable());
}

async function probeDockerAvailable(): Promise<boolean> {
  try {
    await spawn('docker', ['info']);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the mapped host port for a container's internal port.
 */
async function getMappedPort(
  containerId: string,
  internalPort: number,
): Promise<number> {
  const result = await spawn('docker', [
    'port',
    containerId,
    String(internalPort),
  ]);

  // Output format: "0.0.0.0:32768" or ":::32768"
  const output = result.stdout.trim();
  const match = output.match(/:(\d+)$/);

  if (!match) {
    throw new Error(
      `Failed to get mapped port for container ${containerId}: ${output}`,
    );
  }

  return parseInt(match[1], 10);
}

/**
 * Create a Docker container for testing.
 *
 * This is a low-level function that handles the common Docker operations.
 * Use the database-specific withPostgresContainer or withSqlServerContainer
 * functions instead.
 *
 * @internal
 */
export async function createContainer(
  config: ContainerConfig,
): Promise<Container> {
  const envArgs = Object.entries(config.env ?? {}).flatMap(([key, value]) => [
    '-e',
    `${key}=${value}`,
  ]);

  const tmpfsArgs = (config.tmpfs ?? []).flatMap((spec) => ['--tmpfs', spec]);
  const ipcArgs = config.ipcHost ? ['--ipc=host'] : [];
  const swapArgs =
    config.memorySwappiness !== undefined
      ? [`--memory-swappiness=${config.memorySwappiness}`]
      : [];

  const runResult = await spawn('docker', [
    'run',
    '-d',
    '--rm',
    '--name',
    config.name,
    ...envArgs,
    ...tmpfsArgs,
    ...ipcArgs,
    ...swapArgs,
    '-P',
    config.image,
  ]);

  const containerId = runResult.stdout.trim();

  if (!containerId) {
    throw new Error(`Failed to start container: ${runResult.stderr}`);
  }

  try {
    const port = await getMappedPort(containerId, config.internalPort);

    const exec = async (command: string[]) => {
      const { stdout, stderr } = await spawn('docker', [
        'exec',
        containerId,
        ...command,
      ]);
      return { stdout, stderr };
    };

    const cleanup = async () => {
      try {
        await spawn('docker', ['stop', containerId]);
      } catch {
        // Container might already be stopped, ignore errors
      }
    };

    return {
      containerId,
      host: 'localhost',
      port,
      exec,
      cleanup,
      [Symbol.asyncDispose]: cleanup,
    };
  } catch (error) {
    // Cleanup on failure
    try {
      await spawn('docker', ['stop', containerId]);
    } catch {
      // Ignore cleanup errors
    }
    throw error;
  }
}

/**
 * Check if Docker is available and optionally log a skip message.
 * Returns true if Docker is available, false otherwise.
 *
 * @internal
 */
export async function checkDockerAvailable(
  testName?: string,
): Promise<boolean> {
  const available = await isDockerAvailable();
  if (!available && testName) {
    console.log(`Skipping ${testName}: Docker not available`);
  }
  return available;
}

export interface StartContainerOptions extends Omit<
  ContainerConfig,
  'name' | 'env'
> {
  /** Container name. Auto-generated from the image when omitted. */
  name?: string;
  /** Environment variables for the container (default: none). */
  env?: Record<string, string>;
  /**
   * Readiness step, run once after the port maps and before
   * {@link startContainer} returns. **Throw/reject to fail startup** (the
   * container is cleaned up). Most services aren't ready the instant the port
   * maps, so wrap the check in {@link timebox} to poll until it stops throwing:
   * `({ exec }) => timebox(() => exec(['redis-cli', 'ping']))`. Omit for
   * services usable the moment the port is mapped.
   */
  healthy?: (container: Container) => unknown;
}

function dockerNameSlug(image: string): string {
  return image.replace(/[^a-zA-Z0-9_.-]/g, '-');
}

/**
 * Start any Docker image as a managed test container — no per-engine helper
 * required. Maps the internal port to a random host port, waits for the
 * `healthy` probe, and returns an {@link AsyncDisposable} handle.
 *
 * Throws if Docker is unavailable, so the result is always usable (no null
 * check). Guard the suite once with {@link isDockerAvailable} instead:
 *
 * @example
 * ```typescript
 * const hasDocker = await isDockerAvailable();
 * describe('redis', { skip: hasDocker ? false : 'Docker not available' }, () => {
 *   it('pings', async () => {
 *     await using redis = await startContainer({
 *       image: 'redis:7-alpine',
 *       internalPort: 6379,
 *       healthy: ({ exec }) => timebox(() => exec(['redis-cli', 'ping'])),
 *     });
 *     const url = `redis://localhost:${redis.port}`;
 *     // ... auto-disposed at scope exit
 *   });
 * });
 * ```
 */
export async function startContainer(
  options: StartContainerOptions,
): Promise<Container> {
  if (!(await isDockerAvailable())) {
    throw new Error(
      'Docker is not available. Guard the suite with `describe(name, { skip: !(await isDockerAvailable()) && "Docker not available" }, ...)`.',
    );
  }

  const name =
    options.name ?? `test-${dockerNameSlug(options.image)}-${randomUUID()}`;
  const container = await createContainer({
    ...options,
    name,
    env: options.env ?? {},
  });

  try {
    await options.healthy?.(container);
    return container;
  } catch (error) {
    await container.cleanup();
    throw error;
  }
}
