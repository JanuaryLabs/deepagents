import spawn from 'nano-spawn';
import { randomUUID } from 'node:crypto';

import { startContainer } from './container.ts';
import {
  type ServerCoordinates,
  publishServer,
  requireServer,
} from './provisioned-servers.ts';
import { timebox } from './timebox.ts';

/**
 * PostgreSQL container configuration.
 */
export interface PostgresContainerConfig {
  /** Docker metadata for the lifecycle owner. */
  labels?: Record<string, string>;
  /** PostgreSQL image to use (default: postgres:18-alpine) */
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
export interface PostgresContainer extends AsyncDisposable {
  /** Full connection string for pg Pool */
  connectionString: string;
  /** Image the container runs (e.g. `postgres:18-alpine`) */
  image: string;
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
  /** Release this handle (drops the per-test database when pooled). */
  cleanup: () => Promise<void>;
}

/**
 * Run a test with an isolated PostgreSQL database.
 *
 * Uses a server provisioned by the Nx task hook or an explicit global setup.
 * Each call creates and drops a fresh database. Missing provisioning or a
 * configuration mismatch fails before the callback runs.
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
): Promise<T> {
  const shared = requireServer('postgres', config);
  const database = `test_${randomUUID().replace(/-/g, '')}`;
  await psql(shared, `CREATE DATABASE ${database}`);

  const handle: PostgresContainer = {
    ...shared,
    connectionString: `postgresql://${shared.user}:${shared.password}@localhost:${shared.port}/${database}`,
    database,
    cleanup: () => dropDatabase(shared, database),
    [Symbol.asyncDispose]: () => dropDatabase(shared, database),
  };

  try {
    return await fn(handle);
  } finally {
    await dropDatabase(shared, database);
  }
}

/** Publish a server owned by the caller to child test processes. */
export function publishPostgresEnv(container: PostgresContainer): void {
  publishServer('postgres', container);
}

async function psql(container: ServerCoordinates, sql: string): Promise<void> {
  await spawn('docker', [
    'exec',
    container.containerId,
    'psql',
    '-U',
    container.user,
    '-c',
    sql,
  ]);
}

async function dropDatabase(
  container: ServerCoordinates,
  database: string,
): Promise<void> {
  try {
    await psql(container, `DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
  } catch {
    // best-effort cleanup — a leaked test DB lives only until the container dies
  }
}

/**
 * Start a PostgreSQL test container and return it to the caller.
 * The caller owns cleanup (or uses `await using`).
 */
export async function startPostgresContainer(
  config?: PostgresContainerConfig,
): Promise<PostgresContainer> {
  const image = config?.image ?? 'postgres:18-alpine';
  const password = config?.password ?? 'testpassword';
  const database = config?.database ?? 'testdb';
  const user = config?.user ?? 'postgres';

  const container = await startContainer({
    labels: config?.labels,
    image,
    internalPort: 5432,
    env: {
      POSTGRES_PASSWORD: password,
      POSTGRES_DB: database,
      POSTGRES_USER: user,
    },
    tmpfs: ['/var/lib/postgresql:rw,size=512m'],
    ipcHost: true,
    memorySwappiness: 0,
    healthy: ({ exec }) =>
      // Probe over TCP (`-h 127.0.0.1`), never the Unix socket. On first boot the
      // image runs a temporary socket-only server (`listen_addresses=''`) to run
      // init, then restarts the real server on TCP. A socket probe passes against
      // that throwaway server and reports ready ~seconds before callers can
      // actually connect; TCP is exclusive to the real server, so it can't.
      timebox(
        async () => {
          await exec(['pg_isready', '-h', '127.0.0.1', '-U', user]);
          await exec(['psql', '-h', '127.0.0.1', '-U', user, '-c', 'SELECT 1']);
        },
        { maxRetryTime: 60_000 },
      ),
  });

  return {
    connectionString: `postgresql://${user}:${password}@localhost:${container.port}/${database}`,
    image,
    containerId: container.containerId,
    host: container.host,
    port: container.port,
    user,
    password,
    database,
    cleanup: container.cleanup,
    [Symbol.asyncDispose]: container.cleanup,
  };
}
