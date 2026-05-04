import sql from 'mssql';
import { randomUUID } from 'node:crypto';

import { checkDockerAvailable, createContainer } from './container.ts';

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
export interface SqlServerContainer {
  /** Full connection string for mssql ConnectionPool */
  connectionString: string;
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
  /** Stop and remove the container */
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
      const result = await pool.request().query(`
        SELECT FULLTEXTCATALOGPROPERTY('context_store_catalog', 'PopulateStatus') as status
      `);
      // Status 0 = Idle (indexing complete)
      if (result.recordset[0]?.status === 0) {
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

async function waitForSqlServer(
  host: string,
  port: number,
  password: string,
  maxRetries = 480,
  retryDelayMs = 250,
): Promise<void> {
  const connStr = masterConnectionString(host, port, password, 1000);
  for (let i = 0; i < maxRetries; i++) {
    const pool = new sql.ConnectionPool(connStr);
    try {
      await pool.connect();
      await pool.request().query('SELECT 1');
      await pool.close();
      return;
    } catch {
      try {
        await pool.close();
      } catch {
        // ignore close failure on already-failed pool
      }
    }
    await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
  }

  throw new Error(
    `SQL Server at ${host}:${port} failed to become ready after ${maxRetries} retries`,
  );
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
  const dockerAvailable = await checkDockerAvailable('SQL Server tests');
  if (!dockerAvailable) {
    return undefined;
  }

  const image = config?.image ?? defaultSqlServerImage();
  const password = config?.password ?? 'StrongP@ssw0rd123!';
  const database = config?.database ?? 'testdb';
  const user = 'sa';

  const containerName = `sqlserver-test-${randomUUID()}`;

  const env: Record<string, string> = {
    ACCEPT_EULA: 'Y',
    MSSQL_SA_PASSWORD: password,
    MSSQL_MEMORY_LIMIT_MB: '2048',
  };
  if (!isAzureSqlEdge(image)) {
    env.MSSQL_PID = 'Express';
  }

  const container = await createContainer({
    image,
    name: containerName,
    env,
    internalPort: 1433,
    tmpfs: ['/var/opt/mssql:rw,size=2g,mode=1777'],
    ipcHost: true,
    memorySwappiness: 0,
  });

  try {
    await waitForSqlServer(container.host, container.port, password);
    await createDatabase(container.host, container.port, password, database);

    // Build connection string for mssql package
    const connectionString = `Server=localhost,${container.port};Database=${database};User Id=${user};Password=${password};TrustServerCertificate=true;Encrypt=false;`;

    const sqlServerContainer: SqlServerContainer = {
      connectionString,
      containerId: container.containerId,
      host: container.host,
      port: container.port,
      user,
      password,
      database,
      cleanup: container.cleanup,
    };

    return await fn(sqlServerContainer);
  } finally {
    await container.cleanup();
  }
}
