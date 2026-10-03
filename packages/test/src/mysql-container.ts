import spawn from 'nano-spawn';
import { randomUUID } from 'node:crypto';

import { startContainer } from './container.ts';
import {
  type ServerCoordinates,
  publishServer,
  requireServer,
} from './provisioned-servers.ts';
import { timebox } from './timebox.ts';

export interface MysqlContainerConfig {
  /** Docker metadata for the lifecycle owner. */
  labels?: Record<string, string>;
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
 * Uses a provisioned server and creates and drops a fresh database per call.
 * Missing provisioning or a configuration mismatch fails explicitly.
 */
export async function withMysqlContainer<T>(
  fn: (container: MysqlContainer) => Promise<T>,
  config?: MysqlContainerConfig,
): Promise<T> {
  const shared = requireServer('mysql', config);
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
  container: ServerCoordinates,
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
  container: ServerCoordinates,
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

/** Publish a server owned by the caller to child test processes. */
export function publishMysqlEnv(container: MysqlContainer): void {
  publishServer('mysql', container);
}

export async function startMysqlContainer(
  config?: MysqlContainerConfig,
): Promise<MysqlContainer> {
  const image = config?.image ?? 'mysql:8.4';
  const password = config?.password ?? 'testpassword';
  const database = config?.database ?? 'app';
  const user = config?.user ?? 'root';

  const container = await startContainer({
    labels: config?.labels,
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
