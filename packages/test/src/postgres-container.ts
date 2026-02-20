import spawn from 'nano-spawn';

import { checkDockerAvailable, createContainer } from './container.ts';

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
 * Helper to run a test function with a PostgreSQL container.
 * Automatically handles setup and cleanup.
 *
 * If Docker is not available, returns undefined and logs a skip message.
 *
 * @example
 * ```typescript
 * await withPostgresContainer(async (container) => {
 *   const store = new PostgresContextStore({ pool: container.connectionString });
 *   await store.initialize();
 *   // ... run tests
 *   await store.close();
 * });
 * ```
 */
export async function withPostgresContainer<T>(
  fn: (container: PostgresContainer) => Promise<T>,
  config?: PostgresContainerConfig,
): Promise<T | undefined> {
  const dockerAvailable = await checkDockerAvailable('PostgreSQL tests');
  if (!dockerAvailable) {
    return undefined;
  }

  const image = config?.image ?? 'postgres:17-alpine';
  const password = config?.password ?? 'testpassword';
  const database = config?.database ?? 'testdb';
  const user = config?.user ?? 'postgres';

  const containerName = `postgres-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const container = await createContainer({
    image,
    name: containerName,
    env: {
      POSTGRES_PASSWORD: password,
      POSTGRES_DB: database,
      POSTGRES_USER: user,
    },
    internalPort: 5432,
  });

  try {
    await waitForPostgres(container.containerId, user);

    const connectionString = `postgresql://${user}:${password}@localhost:${container.port}/${database}`;

    const postgresContainer: PostgresContainer = {
      connectionString,
      containerId: container.containerId,
      host: container.host,
      port: container.port,
      user,
      password,
      database,
      cleanup: container.cleanup,
    };

    return await fn(postgresContainer);
  } finally {
    await container.cleanup();
  }
}
