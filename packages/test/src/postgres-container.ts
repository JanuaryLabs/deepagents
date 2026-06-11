import spawn from 'nano-spawn';
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import { checkDockerAvailable, startContainer } from './container.ts';
import { timebox } from './timebox.ts';

/**
 * PostgreSQL container configuration.
 */
export interface PostgresContainerConfig {
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
 * Reuses ONE container — provisioned once by {@link postgresGlobalSetup} for the
 * whole run, or lazily booted per process when global setup isn't wired (e.g. a
 * single-file dev run) — and hands each call a fresh `CREATE DATABASE` (~ms)
 * instead of a fresh container (~2s). Each call still sees an empty database, so
 * existing per-test suites keep their isolation while paying the boot once.
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
  const shared = await resolveSharedPostgres(config);
  if (!shared) {
    return undefined;
  }

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

const POSTGRES_ENV = {
  host: 'TEST_POSTGRES_HOST',
  port: 'TEST_POSTGRES_PORT',
  user: 'TEST_POSTGRES_USER',
  password: 'TEST_POSTGRES_PASSWORD',
  database: 'TEST_POSTGRES_DB',
  image: 'TEST_POSTGRES_IMAGE',
  containerId: 'TEST_POSTGRES_CONTAINER_ID',
} as const;

/**
 * Publish a running container's coordinates to the environment so that
 * {@link withPostgresContainer} in child test processes reuses it instead of
 * booting their own. Call from a `globalSetup`; see {@link postgresGlobalSetup}.
 */
export function publishPostgresEnv(container: PostgresContainer): void {
  process.env[POSTGRES_ENV.host] = container.host;
  process.env[POSTGRES_ENV.port] = String(container.port);
  process.env[POSTGRES_ENV.user] = container.user;
  process.env[POSTGRES_ENV.password] = container.password;
  process.env[POSTGRES_ENV.database] = container.database;
  process.env[POSTGRES_ENV.image] = container.image;
  process.env[POSTGRES_ENV.containerId] = container.containerId;
}

function postgresFromEnv(): PostgresContainer | undefined {
  const containerId = process.env[POSTGRES_ENV.containerId];
  const port = process.env[POSTGRES_ENV.port];
  if (!containerId || !port) {
    return undefined;
  }
  const host = process.env[POSTGRES_ENV.host] ?? 'localhost';
  const user = process.env[POSTGRES_ENV.user] ?? 'postgres';
  const password = process.env[POSTGRES_ENV.password] ?? 'testpassword';
  const database = process.env[POSTGRES_ENV.database] ?? 'testdb';
  const image = process.env[POSTGRES_ENV.image] ?? 'postgres:18-alpine';
  const ownedByGlobalTeardown = async () => {};
  return {
    connectionString: `postgresql://${user}:${password}@${host}:${port}/${database}`,
    image,
    containerId,
    host,
    port: Number(port),
    user,
    password,
    database,
    cleanup: ownedByGlobalTeardown,
    [Symbol.asyncDispose]: ownedByGlobalTeardown,
  };
}

/**
 * A requested config can reuse the globally-provisioned container when its
 * boot-time params match. The per-test database is always created fresh, so
 * `database` never blocks reuse — only image/user/password do.
 */
function postgresConfigMatches(
  container: PostgresContainer,
  config?: PostgresContainerConfig,
): boolean {
  return (
    (config?.image ?? container.image) === container.image &&
    (config?.user ?? container.user) === container.user &&
    (config?.password ?? container.password) === container.password
  );
}

function resolveSharedPostgres(
  config?: PostgresContainerConfig,
): Promise<PostgresContainer | undefined> {
  const provisioned = postgresFromEnv();
  if (provisioned && postgresConfigMatches(provisioned, config)) {
    return Promise.resolve(provisioned);
  }
  return sharedPostgresContainer(config);
}

const sharedPostgresContainers = new Map<
  string,
  Promise<PostgresContainer | undefined>
>();
const sharedPostgresContainerIds = new Set<string>();
let postgresExitHookRegistered = false;

function sharedPostgresContainer(
  config?: PostgresContainerConfig,
): Promise<PostgresContainer | undefined> {
  const key = JSON.stringify(config ?? {});
  let pending = sharedPostgresContainers.get(key);
  if (!pending) {
    pending = startPostgresContainer(config).then((container) => {
      if (container) {
        sharedPostgresContainerIds.add(container.containerId);
        registerPostgresExitCleanup();
      }
      return container;
    });
    sharedPostgresContainers.set(key, pending);
  }
  return pending;
}

function registerPostgresExitCleanup(): void {
  if (postgresExitHookRegistered) {
    return;
  }
  postgresExitHookRegistered = true;
  // Shared containers outlive every test in the process; stop them on exit.
  // `--rm` means `docker kill` also removes them.
  process.on('exit', () => {
    for (const id of sharedPostgresContainerIds) {
      try {
        execSync(`docker kill ${id}`, { stdio: 'ignore' });
      } catch {
        // best-effort teardown — the process is exiting anyway
      }
    }
  });
}

async function psql(container: PostgresContainer, sql: string): Promise<void> {
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
  container: PostgresContainer,
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
): Promise<PostgresContainer | undefined> {
  if (!(await checkDockerAvailable('PostgreSQL tests'))) {
    return undefined;
  }

  const image = config?.image ?? 'postgres:18-alpine';
  const password = config?.password ?? 'testpassword';
  const database = config?.database ?? 'testdb';
  const user = config?.user ?? 'postgres';

  const container = await startContainer({
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
      timebox(
        async () => {
          await exec(['pg_isready', '-U', user]);
          await exec(['psql', '-U', user, '-c', 'SELECT 1']);
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
