import spawn from 'nano-spawn';
import { randomUUID } from 'node:crypto';

import { checkDockerAvailable, createContainer } from './container.ts';

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

export interface MysqlContainer {
  connectionString: string;
  containerId: string;
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  query: (sql: string) => Promise<Record<string, string | null>[]>;
  cleanup: () => Promise<void>;
}

async function waitForMysql(
  containerId: string,
  user: string,
  password: string,
  maxRetries = 240,
  retryDelayMs = 250,
): Promise<void> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      await spawn('docker', [
        'exec',
        containerId,
        'mysqladmin',
        'ping',
        '-h',
        '127.0.0.1',
        `-u${user}`,
        `-p${password}`,
        '--silent',
      ]);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }

  throw new Error(
    `MySQL container ${containerId} failed to become ready after ${maxRetries} retries`,
  );
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

export async function startMysqlContainer(
  config?: MysqlContainerConfig,
): Promise<MysqlContainer | undefined> {
  const dockerAvailable = await checkDockerAvailable('MySQL tests');
  if (!dockerAvailable) {
    return undefined;
  }

  const image = config?.image ?? 'mysql:8.4';
  const password = config?.password ?? 'testpassword';
  const database = config?.database ?? 'app';
  const user = config?.user ?? 'root';
  const containerName = `mysql-test-${randomUUID()}`;

  const container = await createContainer({
    image,
    name: containerName,
    env: {
      MYSQL_ROOT_PASSWORD: password,
      MYSQL_DATABASE: database,
    },
    internalPort: 3306,
    tmpfs: ['/var/lib/mysql:rw,size=512m'],
    memorySwappiness: 0,
  });

  try {
    await waitForMysql(container.containerId, user, password);

    const query = async (sql: string) => {
      const result = await spawn('docker', [
        'exec',
        container.containerId,
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
      return parseMysqlBatch(result.stdout);
    };

    return {
      connectionString: `mysql://${user}:${password}@localhost:${container.port}/${database}`,
      containerId: container.containerId,
      host: container.host,
      port: container.port,
      user,
      password,
      database,
      query,
      cleanup: container.cleanup,
    };
  } catch (error) {
    await container.cleanup();
    throw error;
  }
}

export async function withMysqlContainer<T>(
  fn: (container: MysqlContainer) => Promise<T>,
  config?: MysqlContainerConfig,
): Promise<T | undefined> {
  const container = await startMysqlContainer(config);
  if (!container) {
    return undefined;
  }

  try {
    return await fn(container);
  } finally {
    await container.cleanup();
  }
}
