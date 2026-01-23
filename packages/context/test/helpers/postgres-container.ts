import spawn from 'nano-spawn';

/**
 * PostgreSQL container configuration.
 */
export interface PostgresContainerConfig {
  /** PostgreSQL image to use (default: postgres:16-alpine) */
  image?: string;
  /** Database password (default: testpassword) */
  password?: string;
  /** Database name (default: testdb) */
  database?: string;
  /** PostgreSQL user (default: postgres) */
  user?: string;
}

/**
 * Running PostgreSQL container instance.
 */
export interface PostgresContainer {
  /** Full connection string for pg Pool */
  connectionString: string;
  /** Docker container ID */
  containerId: string;
  /** Host (always localhost for Docker) */
  host: string;
  /** Mapped port on host */
  port: number;
  /** Database user */
  user: string;
  /** Database password */
  password: string;
  /** Database name */
  database: string;
  /** Stop and remove the container */
  cleanup: () => Promise<void>;
}

/**
 * Check if Docker is available on this machine.
 */
export async function isDockerAvailable(): Promise<boolean> {
  try {
    await spawn('docker', ['info']);
    return true;
  } catch {
    return false;
  }
}

/**
 * Find an available port by letting the OS assign one.
 */
async function getRandomPort(): Promise<number> {
  // Use a simple approach: let Docker assign a random port
  // We'll extract it from docker port command after container starts
  return 0; // Placeholder, we'll use -P flag
}

/**
 * Wait for PostgreSQL to be ready to accept connections.
 */
async function waitForPostgres(
  containerId: string,
  user: string,
  maxRetries = 30,
  retryDelayMs = 1000,
): Promise<void> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      // nano-spawn throws on non-zero exit code
      // If this doesn't throw, pg_isready succeeded (exit code 0)
      await spawn('docker', ['exec', containerId, 'pg_isready', '-U', user]);

      // Success! PostgreSQL is ready
      return;
    } catch {
      // pg_isready failed (non-zero exit code), PostgreSQL not ready yet
    }

    await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
  }

  throw new Error(
    `PostgreSQL container ${containerId} failed to become ready after ${maxRetries} retries`,
  );
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
 * Create a PostgreSQL Docker container for testing.
 *
 * The container is created with a random host port and the
 * postgres:16-alpine image by default. The container is configured
 * to be removed automatically when stopped.
 *
 * @example
 * ```typescript
 * const container = await createPostgresContainer();
 * try {
 *   const store = new PostgresContextStore({ pool: container.connectionString });
 *   // ... run tests
 * } finally {
 *   await container.cleanup();
 * }
 * ```
 */
export async function createPostgresContainer(
  config?: PostgresContainerConfig,
): Promise<PostgresContainer> {
  const image = config?.image ?? 'postgres:16-alpine';
  const password = config?.password ?? 'testpassword';
  const database = config?.database ?? 'testdb';
  const user = config?.user ?? 'postgres';

  // Generate a unique container name to avoid conflicts
  const containerName = `postgres-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // Start the container with:
  // - Random port mapping (-P publishes all exposed ports to random host ports)
  // - Auto-remove on stop (--rm)
  // - Detached mode (-d)
  // - Environment variables for PostgreSQL setup
  const runResult = await spawn('docker', [
    'run',
    '-d',
    '--rm',
    '--name',
    containerName,
    '-e',
    `POSTGRES_PASSWORD=${password}`,
    '-e',
    `POSTGRES_DB=${database}`,
    '-e',
    `POSTGRES_USER=${user}`,
    '-P', // Publish all exposed ports to random ports
    image,
  ]);

  const containerId = runResult.stdout.trim();

  if (!containerId) {
    throw new Error(
      `Failed to start PostgreSQL container: ${runResult.stderr}`,
    );
  }

  try {
    // Get the mapped port for PostgreSQL (internal port 5432)
    const port = await getMappedPort(containerId, 5432);

    // Wait for PostgreSQL to be ready
    await waitForPostgres(containerId, user);

    const connectionString = `postgresql://${user}:${password}@localhost:${port}/${database}`;

    return {
      connectionString,
      containerId,
      host: 'localhost',
      port,
      user,
      password,
      database,
      cleanup: async () => {
        try {
          await spawn('docker', ['stop', containerId]);
        } catch {
          // Container might already be stopped, ignore errors
        }
      },
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
 * Helper to run a test function with a PostgreSQL container.
 * Automatically handles setup and cleanup.
 *
 * @example
 * ```typescript
 * await withPostgresContainer(async (container) => {
 *   const store = new PostgresContextStore({ pool: container.connectionString });
 *   // ... run tests
 *   await store.close();
 * });
 * ```
 */
export async function withPostgresContainer<T>(
  fn: (container: PostgresContainer) => Promise<T>,
  config?: PostgresContainerConfig,
): Promise<T> {
  const container = await createPostgresContainer(config);
  try {
    return await fn(container);
  } finally {
    await container.cleanup();
  }
}
