import spawn from 'nano-spawn';
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import { checkDockerAvailable, startContainer } from './container.ts';
import { timebox } from './timebox.ts';

export interface MysqlContainerConfig {
  /** MySQL image to use (default: mysql:8.4) */
  image?: string;
  /** Root password (default: testpassword) */
  password?: string;
  /** Database name (default: app) */
  database?: string;
  /** Database user (default: root) */
  user?: string;
}

export interface MysqlContainer extends AsyncDisposable {
  connectionString: string;
  /** Image the container runs (e.g. `mysql:8.4`) */
  image: string;
  containerId: string;
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  query: (sql: string) => Promise<Record<string, string | null>[]>;
  /** Release this handle (drops the per-test database when pooled). */
  cleanup: () => Promise<void>;
}

function parseMysqlBatch(stdout: string): Record<string, string | null>[] {
  const lines = stdout.trimEnd().split('\n').filter(Boolean);
  if (lines.length === 0) return [];

  const headers = lines[0].split('\t');
  return lines.slice(1).map((line) => {
    const values = line.split('\t');
    return Object.fromEntries(
      headers.map((header, index) => {
        const value = values[index];
        return [header, value === undefined || value === 'NULL' ? null : value];
      }),
    );
  });
}

function makeMysqlQuery(
  containerId: string,
  user: string,
  password: string,
  database: string,
): (sql: string) => Promise<Record<string, string | null>[]> {
  return async (sql: string) => {
    const { stdout } = await spawn('docker', [
      'exec',
      containerId,
      'mysql',
      `-u${user}`,
      `-p${password}`,
      '--database',
      database,
      '--batch',
      '--raw',
      '--execute',
      sql,
    ]);
    return parseMysqlBatch(stdout);
  };
}

/**
 * Run a test with an isolated MySQL database.
 *
 * Reuses ONE container — provisioned once by {@link mysqlGlobalSetup} for the
 * whole run, or lazily booted per process — and hands each call a fresh
 * `CREATE DATABASE` (~ms) instead of a fresh container. Each call still sees an
 * empty database.
 */
export async function withMysqlContainer<T>(
  fn: (container: MysqlContainer) => Promise<T>,
  config?: MysqlContainerConfig,
): Promise<T | undefined> {
  const shared = await resolveSharedMysql(config);
  if (!shared) {
    return undefined;
  }

  const database = `test_${randomUUID().replace(/-/g, '')}`;
  await createMysqlDatabase(shared, database);

  const handle: MysqlContainer = {
    ...shared,
    connectionString: `mysql://${shared.user}:${shared.password}@localhost:${shared.port}/${database}`,
    database,
    query: makeMysqlQuery(
      shared.containerId,
      shared.user,
      shared.password,
      database,
    ),
    cleanup: () => dropMysqlDatabase(shared, database),
    [Symbol.asyncDispose]: () => dropMysqlDatabase(shared, database),
  };

  try {
    return await fn(handle);
  } finally {
    await dropMysqlDatabase(shared, database);
  }
}

async function createMysqlDatabase(
  container: MysqlContainer,
  database: string,
): Promise<void> {
  await spawn('docker', [
    'exec',
    container.containerId,
    'mysql',
    `-u${container.user}`,
    `-p${container.password}`,
    '--execute',
    `CREATE DATABASE \`${database}\``,
  ]);
}

async function dropMysqlDatabase(
  container: MysqlContainer,
  database: string,
): Promise<void> {
  try {
    await spawn('docker', [
      'exec',
      container.containerId,
      'mysql',
      `-u${container.user}`,
      `-p${container.password}`,
      '--execute',
      `DROP DATABASE IF EXISTS \`${database}\``,
    ]);
  } catch {
    // best-effort cleanup — a leaked test DB lives only until the container dies
  }
}

const MYSQL_ENV = {
  host: 'TEST_MYSQL_HOST',
  port: 'TEST_MYSQL_PORT',
  user: 'TEST_MYSQL_USER',
  password: 'TEST_MYSQL_PASSWORD',
  database: 'TEST_MYSQL_DB',
  image: 'TEST_MYSQL_IMAGE',
  containerId: 'TEST_MYSQL_CONTAINER_ID',
} as const;

/**
 * Publish a running container's coordinates to the environment so that
 * {@link withMysqlContainer} in child test processes reuses it instead of
 * booting their own. Call from a `globalSetup`; see {@link mysqlGlobalSetup}.
 */
export function publishMysqlEnv(container: MysqlContainer): void {
  process.env[MYSQL_ENV.host] = container.host;
  process.env[MYSQL_ENV.port] = String(container.port);
  process.env[MYSQL_ENV.user] = container.user;
  process.env[MYSQL_ENV.password] = container.password;
  process.env[MYSQL_ENV.database] = container.database;
  process.env[MYSQL_ENV.image] = container.image;
  process.env[MYSQL_ENV.containerId] = container.containerId;
}

function mysqlFromEnv(): MysqlContainer | undefined {
  const containerId = process.env[MYSQL_ENV.containerId];
  const port = process.env[MYSQL_ENV.port];
  if (!containerId || !port) {
    return undefined;
  }
  const host = process.env[MYSQL_ENV.host] ?? 'localhost';
  const user = process.env[MYSQL_ENV.user] ?? 'root';
  const password = process.env[MYSQL_ENV.password] ?? 'testpassword';
  const database = process.env[MYSQL_ENV.database] ?? 'app';
  const image = process.env[MYSQL_ENV.image] ?? 'mysql:8.4';
  const ownedByGlobalTeardown = async () => {};
  return {
    connectionString: `mysql://${user}:${password}@${host}:${port}/${database}`,
    image,
    containerId,
    host,
    port: Number(port),
    user,
    password,
    database,
    query: makeMysqlQuery(containerId, user, password, database),
    cleanup: ownedByGlobalTeardown,
    [Symbol.asyncDispose]: ownedByGlobalTeardown,
  };
}

function mysqlConfigMatches(
  container: MysqlContainer,
  config?: MysqlContainerConfig,
): boolean {
  return (
    (config?.image ?? container.image) === container.image &&
    (config?.user ?? container.user) === container.user &&
    (config?.password ?? container.password) === container.password
  );
}

function resolveSharedMysql(
  config?: MysqlContainerConfig,
): Promise<MysqlContainer | undefined> {
  const provisioned = mysqlFromEnv();
  if (provisioned && mysqlConfigMatches(provisioned, config)) {
    return Promise.resolve(provisioned);
  }
  return sharedMysqlContainer(config);
}

const sharedMysqlContainers = new Map<
  string,
  Promise<MysqlContainer | undefined>
>();
const sharedMysqlContainerIds = new Set<string>();
let mysqlExitHookRegistered = false;

function sharedMysqlContainer(
  config?: MysqlContainerConfig,
): Promise<MysqlContainer | undefined> {
  const key = JSON.stringify(config ?? {});
  let pending = sharedMysqlContainers.get(key);
  if (!pending) {
    pending = startMysqlContainer(config).then((container) => {
      if (container) {
        sharedMysqlContainerIds.add(container.containerId);
        registerMysqlExitCleanup();
      }
      return container;
    });
    sharedMysqlContainers.set(key, pending);
  }
  return pending;
}

function registerMysqlExitCleanup(): void {
  if (mysqlExitHookRegistered) {
    return;
  }
  mysqlExitHookRegistered = true;
  process.on('exit', () => {
    for (const id of sharedMysqlContainerIds) {
      try {
        execSync(`docker kill ${id}`, { stdio: 'ignore' });
      } catch {
        // best-effort teardown — the process is exiting anyway
      }
    }
  });
}

export async function startMysqlContainer(
  config?: MysqlContainerConfig,
): Promise<MysqlContainer | undefined> {
  if (!(await checkDockerAvailable('MySQL tests'))) {
    return undefined;
  }

  const image = config?.image ?? 'mysql:8.4';
  const password = config?.password ?? 'testpassword';
  const database = config?.database ?? 'app';
  const user = config?.user ?? 'root';

  const container = await startContainer({
    image,
    internalPort: 3306,
    env: {
      MYSQL_ROOT_PASSWORD: password,
      MYSQL_DATABASE: database,
    },
    tmpfs: ['/var/lib/mysql:rw,size=512m'],
    memorySwappiness: 0,
    healthy: ({ exec }) =>
      timebox(
        () =>
          exec([
            'mysqladmin',
            'ping',
            '-h',
            '127.0.0.1',
            `-u${user}`,
            `-p${password}`,
            '--silent',
          ]),
        { maxRetryTime: 90_000 },
      ),
  });

  return {
    connectionString: `mysql://${user}:${password}@localhost:${container.port}/${database}`,
    image,
    containerId: container.containerId,
    host: container.host,
    port: container.port,
    user,
    password,
    database,
    query: makeMysqlQuery(container.containerId, user, password, database),
    cleanup: container.cleanup,
    [Symbol.asyncDispose]: container.cleanup,
  };
}
