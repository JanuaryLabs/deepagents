import sql from 'mssql';
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import { checkDockerAvailable, startContainer } from './container.ts';
import { timebox } from './timebox.ts';

export const SQL_SERVER_FULL_IMAGE =
  'mcr.microsoft.com/mssql/server:2022-latest';
export const SQL_SERVER_EDGE_IMAGE = 'mcr.microsoft.com/azure-sql-edge:latest';

function defaultSqlServerImage(): string {
  if (process.platform === 'darwin' && process.arch === 'arm64') {
    return SQL_SERVER_EDGE_IMAGE;
  }
  return SQL_SERVER_FULL_IMAGE;
}

function isAzureSqlEdge(image: string): boolean {
  return image.includes('azure-sql-edge');
}

/**
 * SQL Server container configuration.
 */
export interface SqlServerContainerConfig {
  /**
   * SQL Server image to use. Defaults to Azure SQL Edge on Apple Silicon
   * (native ARM64 — no QEMU emulation) and full SQL Server elsewhere.
   * Pass SQL_SERVER_FULL_IMAGE for tests that need FULLTEXT CATALOG /
   * CONTAINSTABLE — Azure SQL Edge does not support FTS.
   */
  image?: string;
  /** SA password - must meet SQL Server complexity requirements (default: StrongP@ssw0rd123!) */
  password?: string;
  /** Database name (default: testdb) */
  database?: string;
}

/**
 * Running SQL Server container instance.
 */
export interface SqlServerContainer extends AsyncDisposable {
  /** Full connection string for mssql ConnectionPool */
  connectionString: string;
  /** Image the container runs (Azure SQL Edge or full SQL Server) */
  image: string;
  /** Docker container ID */
  containerId: string;
  /** Host (always localhost for Docker) */
  host: string;
  /** Mapped port on host */
  port: number;
  /** Database user (always 'sa' for SQL Server) */
  user: string;
  /** Database password */
  password: string;
  /** Database name */
  database: string;
  /** Release this handle (drops the per-test database when pooled). */
  cleanup: () => Promise<void>;
}

/**
 * Wait for SQL Server Full-Text Search index to finish populating.
 *
 * SQL Server FTS uses a background indexing service that processes changes
 * asynchronously. This function polls FULLTEXTCATALOGPROPERTY to wait until
 * the catalog is idle (status 0), indicating indexing is complete.
 *
 * @param connectionString - SQL Server connection string
 * @param maxWaitMs - Maximum time to wait in milliseconds (default: 10000)
 * @param pollIntervalMs - Interval between polls in milliseconds (default: 100)
 */
export async function waitForFtsReady(
  connectionString: string,
  maxWaitMs = 10000,
  pollIntervalMs = 100,
): Promise<void> {
  const pool = await sql.connect(connectionString);
  try {
    const start = Date.now();

    while (Date.now() - start < maxWaitMs) {
      // The catalog name is schema-prefixed (e.g. `dbo_context_store_catalog`),
      // so match by suffix instead of a hardcoded name. An empty result means
      // there is no full-text catalog to wait for — e.g. on engines without FTS
      // (Azure SQL Edge) or images lacking the full-text component, where
      // searchMessages falls back to LIKE — so there is nothing to populate.
      const result = await pool.request().query(`
        SELECT FULLTEXTCATALOGPROPERTY(name, 'PopulateStatus') AS status
        FROM sys.fulltext_catalogs
        WHERE name LIKE '%context_store_catalog'
      `);
      const catalogs = result.recordset;
      // Status 0 = Idle (indexing complete); NULL = not populating.
      if (catalogs.every((c) => c.status === 0 || c.status == null)) {
        return;
      }
      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }
  } finally {
    await pool.close();
  }
}

function masterConnectionString(
  host: string,
  port: number,
  password: string,
  timeoutMs?: number,
): string {
  const base = `Server=${host},${port};Database=master;User Id=sa;Password=${password};TrustServerCertificate=true;Encrypt=false;`;
  return timeoutMs !== undefined
    ? `${base}connectionTimeout=${timeoutMs};requestTimeout=${timeoutMs};`
    : base;
}

function sqlServerConnectionString(
  port: number,
  password: string,
  database: string,
): string {
  return `Server=localhost,${port};Database=${database};User Id=sa;Password=${password};TrustServerCertificate=true;Encrypt=false;`;
}

async function pingSqlServer(
  host: string,
  port: number,
  password: string,
): Promise<void> {
  const pool = new sql.ConnectionPool(
    masterConnectionString(host, port, password, 1000),
  );
  try {
    await pool.connect();
    await pool.request().query('SELECT 1');
  } finally {
    await pool.close().catch(() => {
      // ignore close failure on an already-failed pool
    });
  }
}

async function createDatabase(
  host: string,
  port: number,
  password: string,
  database: string,
): Promise<void> {
  const pool = new sql.ConnectionPool(
    masterConnectionString(host, port, password),
  );
  await pool.connect();
  try {
    await pool
      .request()
      .query(
        `IF NOT EXISTS (SELECT * FROM sys.databases WHERE name = '${database}') CREATE DATABASE [${database}]`,
      );
  } finally {
    await pool.close();
  }
}

/**
 * Helper to run a test function with a SQL Server container.
 * Automatically handles setup and cleanup.
 *
 * If Docker is not available, returns undefined and logs a skip message.
 *
 * @example
 * ```typescript
 * await withSqlServerContainer(async (container) => {
 *   const store = new SqlServerContextStore({ pool: container.connectionString });
 *   await store.initialize();
 *   // ... run tests
 *   await store.close();
 * });
 * ```
 */
export async function withSqlServerContainer<T>(
  fn: (container: SqlServerContainer) => Promise<T>,
  config?: SqlServerContainerConfig,
): Promise<T | undefined> {
  const shared = await resolveSharedSqlServer(config);
  if (!shared) {
    return undefined;
  }

  const database = `test_${randomUUID().replace(/-/g, '')}`;
  await createDatabase(shared.host, shared.port, shared.password, database);

  const handle: SqlServerContainer = {
    ...shared,
    connectionString: sqlServerConnectionString(
      shared.port,
      shared.password,
      database,
    ),
    database,
    cleanup: () => dropSqlServerDatabase(shared, database),
    [Symbol.asyncDispose]: () => dropSqlServerDatabase(shared, database),
  };

  try {
    return await fn(handle);
  } finally {
    await dropSqlServerDatabase(shared, database);
  }
}

async function dropSqlServerDatabase(
  container: SqlServerContainer,
  database: string,
): Promise<void> {
  const pool = new sql.ConnectionPool(
    masterConnectionString(container.host, container.port, container.password),
  );
  try {
    await pool.connect();
    await pool
      .request()
      .query(
        `IF DB_ID('${database}') IS NOT NULL BEGIN ALTER DATABASE [${database}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [${database}]; END`,
      );
  } catch {
    // best-effort cleanup — a leaked test DB lives only until the container dies
  } finally {
    await pool.close().catch(() => {});
  }
}

const SQLSERVER_ENV = {
  host: 'TEST_SQLSERVER_HOST',
  port: 'TEST_SQLSERVER_PORT',
  password: 'TEST_SQLSERVER_PASSWORD',
  database: 'TEST_SQLSERVER_DB',
  image: 'TEST_SQLSERVER_IMAGE',
  containerId: 'TEST_SQLSERVER_CONTAINER_ID',
} as const;

/**
 * Publish a running container's coordinates to the environment so that
 * {@link withSqlServerContainer} in child test processes reuses it instead of
 * booting their own. Call from a `globalSetup`; see {@link sqlServerGlobalSetup}.
 */
export function publishSqlServerEnv(container: SqlServerContainer): void {
  process.env[SQLSERVER_ENV.host] = container.host;
  process.env[SQLSERVER_ENV.port] = String(container.port);
  process.env[SQLSERVER_ENV.password] = container.password;
  process.env[SQLSERVER_ENV.database] = container.database;
  process.env[SQLSERVER_ENV.image] = container.image;
  process.env[SQLSERVER_ENV.containerId] = container.containerId;
}

function sqlServerFromEnv(): SqlServerContainer | undefined {
  const containerId = process.env[SQLSERVER_ENV.containerId];
  const port = process.env[SQLSERVER_ENV.port];
  if (!containerId || !port) {
    return undefined;
  }
  const host = process.env[SQLSERVER_ENV.host] ?? 'localhost';
  const password = process.env[SQLSERVER_ENV.password] ?? 'StrongP@ssw0rd123!';
  const database = process.env[SQLSERVER_ENV.database] ?? 'testdb';
  const image = process.env[SQLSERVER_ENV.image] ?? defaultSqlServerImage();
  const ownedByGlobalTeardown = async () => {};
  return {
    connectionString: sqlServerConnectionString(
      Number(port),
      password,
      database,
    ),
    image,
    containerId,
    host,
    port: Number(port),
    user: 'sa',
    password,
    database,
    cleanup: ownedByGlobalTeardown,
    [Symbol.asyncDispose]: ownedByGlobalTeardown,
  };
}

function sqlServerConfigMatches(
  container: SqlServerContainer,
  config?: SqlServerContainerConfig,
): boolean {
  return (
    (config?.image ?? container.image) === container.image &&
    (config?.password ?? container.password) === container.password
  );
}

function resolveSharedSqlServer(
  config?: SqlServerContainerConfig,
): Promise<SqlServerContainer | undefined> {
  const provisioned = sqlServerFromEnv();
  if (provisioned && sqlServerConfigMatches(provisioned, config)) {
    return Promise.resolve(provisioned);
  }
  return sharedSqlServerContainer(config);
}

const sharedSqlServerContainers = new Map<
  string,
  Promise<SqlServerContainer | undefined>
>();
const sharedSqlServerContainerIds = new Set<string>();
let sqlServerExitHookRegistered = false;

function sharedSqlServerContainer(
  config?: SqlServerContainerConfig,
): Promise<SqlServerContainer | undefined> {
  const key = JSON.stringify(config ?? {});
  let pending = sharedSqlServerContainers.get(key);
  if (!pending) {
    pending = startSqlServerContainer(config).then((container) => {
      if (container) {
        sharedSqlServerContainerIds.add(container.containerId);
        registerSqlServerExitCleanup();
      }
      return container;
    });
    sharedSqlServerContainers.set(key, pending);
  }
  return pending;
}

function registerSqlServerExitCleanup(): void {
  if (sqlServerExitHookRegistered) {
    return;
  }
  sqlServerExitHookRegistered = true;
  process.on('exit', () => {
    for (const id of sharedSqlServerContainerIds) {
      try {
        execSync(`docker kill ${id}`, { stdio: 'ignore' });
      } catch {
        // best-effort teardown — the process is exiting anyway
      }
    }
  });
}

/**
 * Start a SQL Server test container and return it to the caller.
 * The caller owns cleanup.
 */
export async function startSqlServerContainer(
  config?: SqlServerContainerConfig,
): Promise<SqlServerContainer | undefined> {
  const dockerAvailable = await checkDockerAvailable('SQL Server tests');
  if (!dockerAvailable) {
    return undefined;
  }

  const image = config?.image ?? defaultSqlServerImage();
  const password = config?.password ?? 'StrongP@ssw0rd123!';
  const database = config?.database ?? 'testdb';
  const user = 'sa';

  const env: Record<string, string> = {
    ACCEPT_EULA: 'Y',
    MSSQL_SA_PASSWORD: password,
    MSSQL_MEMORY_LIMIT_MB: '2048',
  };
  if (!isAzureSqlEdge(image)) {
    env.MSSQL_PID = 'Express';
  }

  const container = await startContainer({
    image,
    env,
    internalPort: 1433,
    tmpfs: ['/var/opt/mssql:rw,size=2g,mode=1777'],
    ipcHost: true,
    memorySwappiness: 0,
    healthy: ({ host, port }) =>
      timebox(() => pingSqlServer(host, port, password), {
        maxRetryTime: 180_000,
      }),
  });

  try {
    await createDatabase(container.host, container.port, password, database);
  } catch (error) {
    await container.cleanup();
    throw error;
  }

  return {
    connectionString: sqlServerConnectionString(
      container.port,
      password,
      database,
    ),
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
