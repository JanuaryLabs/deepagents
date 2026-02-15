import sql from 'mssql';
import spawn from 'nano-spawn';
import { randomUUID } from 'node:crypto';

import { checkDockerAvailable, createContainer } from './container.ts';

/**
 * SQL Server container configuration.
 */
export interface SqlServerContainerConfig {
  /** SQL Server image to use (default: mcr.microsoft.com/mssql/server:2022-latest) */
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

/**
 * Wait for SQL Server to be ready to accept connections.
 */
async function waitForSqlServer(
  containerId: string,
  password: string,
  maxRetries = 60,
  retryDelayMs = 2000,
): Promise<void> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      // Use sqlcmd to test connection
      await spawn('docker', [
        'exec',
        containerId,
        '/opt/mssql-tools18/bin/sqlcmd',
        '-S',
        'localhost',
        '-U',
        'sa',
        '-P',
        password,
        '-C', // Trust server certificate
        '-Q',
        'SELECT 1',
      ]);

      // Success! SQL Server is ready
      return;
    } catch {
      // SQL Server not ready yet, try older sqlcmd path
      try {
        await spawn('docker', [
          'exec',
          containerId,
          '/opt/mssql-tools/bin/sqlcmd',
          '-S',
          'localhost',
          '-U',
          'sa',
          '-P',
          password,
          '-Q',
          'SELECT 1',
        ]);
        return;
      } catch {
        // Still not ready
      }
    }

    await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
  }

  throw new Error(
    `SQL Server container ${containerId} failed to become ready after ${maxRetries} retries`,
  );
}

/**
 * Create a database in the SQL Server container.
 */
async function createDatabase(
  containerId: string,
  password: string,
  database: string,
): Promise<void> {
  // Try newer sqlcmd path first, then fall back to older path
  try {
    await spawn('docker', [
      'exec',
      containerId,
      '/opt/mssql-tools18/bin/sqlcmd',
      '-S',
      'localhost',
      '-U',
      'sa',
      '-P',
      password,
      '-C',
      '-Q',
      `IF NOT EXISTS (SELECT * FROM sys.databases WHERE name = '${database}') CREATE DATABASE [${database}]`,
    ]);
  } catch {
    await spawn('docker', [
      'exec',
      containerId,
      '/opt/mssql-tools/bin/sqlcmd',
      '-S',
      'localhost',
      '-U',
      'sa',
      '-P',
      password,
      '-Q',
      `IF NOT EXISTS (SELECT * FROM sys.databases WHERE name = '${database}') CREATE DATABASE [${database}]`,
    ]);
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

  const image = config?.image ?? 'mcr.microsoft.com/mssql/server:2022-latest';
  const password = config?.password ?? 'StrongP@ssw0rd123!';
  const database = config?.database ?? 'testdb';
  const user = 'sa';

  const containerName = `sqlserver-test-${randomUUID()}`;

  const container = await createContainer({
    image,
    name: containerName,
    env: {
      ACCEPT_EULA: 'Y',
      MSSQL_SA_PASSWORD: password,
    },
    internalPort: 1433,
  });

  try {
    // Wait for SQL Server to be ready (can take 30-60 seconds)
    await waitForSqlServer(container.containerId, password);

    // Create the test database
    await createDatabase(container.containerId, password, database);

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
