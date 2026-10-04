import sql from 'mssql';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

import { timebox } from '../async/timebox.ts';
import type { Container } from '../docker/container.ts';
import { Docker } from '../docker/docker.ts';
import type { Database, DatabaseOptions } from './database.ts';

export const SQL_SERVER_FULL_IMAGE =
  'mcr.microsoft.com/mssql/server:2022-latest';
export const SQL_SERVER_EDGE_IMAGE = 'mcr.microsoft.com/azure-sql-edge:latest';

export interface SqlServerDatabase extends Database {
  /** Wait for the context store's full-text catalogs to stop populating. */
  waitForFtsReady: (
    maxWaitMs?: number,
    pollIntervalMs?: number,
  ) => Promise<void>;
}

export class SqlServer {
  readonly #docker = new Docker();
  readonly #options;

  constructor({
    image = process.platform === 'darwin' && process.arch === 'arm64'
      ? SQL_SERVER_EDGE_IMAGE
      : SQL_SERVER_FULL_IMAGE,
    password = 'StrongP@ssw0rd123!',
    database = 'testdb',
    labels,
  }: DatabaseOptions = {}) {
    this.#options = { image, password, database, labels };
  }

  /** Create an isolated database on the persistent shared server. */
  async database(): Promise<SqlServerDatabase> {
    const container = await this.#acquire('reuse');
    const database = `test_${randomUUID().replaceAll('-', '')}`;
    await this.#createDatabase(container, database);
    return this.#handle(container, database, () =>
      this.#dropDatabase(container, database),
    );
  }

  /** Start a dedicated server; the returned handle owns its container. */
  async start(): Promise<SqlServerDatabase> {
    const container = await this.#acquire('start');
    const { database } = this.#options;
    try {
      await this.#createDatabase(container, database);
      return this.#handle(container, database, container.cleanup);
    } catch (error) {
      await container.cleanup();
      throw error;
    }
  }

  #connectionString(container: Container, database: string): string {
    return `Server=${container.host},${container.port};Database=${database};User Id=sa;Password=${this.#options.password};TrustServerCertificate=true;Encrypt=false;`;
  }

  async #ping(container: Container): Promise<void> {
    const pool = new sql.ConnectionPool(
      `${this.#connectionString(container, 'master')}connectionTimeout=1000;requestTimeout=1000;`,
    );
    try {
      await pool.connect();
      await pool.request().query('SELECT 1');
    } finally {
      await pool.close().catch(() => {});
    }
  }

  async #createDatabase(container: Container, database: string): Promise<void> {
    const pool = new sql.ConnectionPool(
      this.#connectionString(container, 'master'),
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

  async #dropDatabase(container: Container, database: string): Promise<void> {
    const pool = new sql.ConnectionPool(
      this.#connectionString(container, 'master'),
    );
    try {
      await pool.connect();
      await pool
        .request()
        .query(
          `IF DB_ID('${database}') IS NOT NULL BEGIN ALTER DATABASE [${database}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [${database}]; END`,
        );
    } catch {
      // Best-effort cleanup; a leaked database lasts until container removal.
    } finally {
      await pool.close().catch(() => {});
    }
  }

  #acquire(mode: 'start' | 'reuse'): Promise<Container> {
    const { image, password, labels } = this.#options;
    const env: Record<string, string> = {
      ACCEPT_EULA: 'Y',
      MSSQL_SA_PASSWORD: password,
      MSSQL_MEMORY_LIMIT_MB: '2048',
    };
    if (!image.includes('azure-sql-edge')) env.MSSQL_PID = 'Express';
    return this.#docker[mode]({
      image,
      labels,
      env,
      internalPort: 1433,
      tmpfs: ['/var/opt/mssql:rw,size=2g,mode=1777'],
      ipcHost: true,
      memorySwappiness: 0,
      healthy: (container) =>
        timebox(() => this.#ping(container), { maxRetryTime: 180_000 }),
    });
  }

  async #waitForFtsReady(
    connectionString: string,
    maxWaitMs: number,
    pollIntervalMs: number,
  ): Promise<void> {
    const pool = await sql.connect(connectionString);
    try {
      const start = Date.now();
      while (Date.now() - start < maxWaitMs) {
        // Empty means no catalog (e.g. Edge); the context store then uses LIKE.
        const result = await pool.request().query(`
          SELECT FULLTEXTCATALOGPROPERTY(name, 'PopulateStatus') AS status
          FROM sys.fulltext_catalogs
          WHERE name LIKE '%context_store_catalog'
        `);
        if (result.recordset.every((c) => c.status === 0 || c.status == null))
          return;
        await sleep(pollIntervalMs);
      }
    } finally {
      await pool.close();
    }
  }

  #handle(
    container: Container,
    database: string,
    cleanup: () => Promise<void>,
  ): SqlServerDatabase {
    const { image, password } = this.#options;
    const connectionString = this.#connectionString(container, database);
    return {
      connectionString,
      image,
      user: 'sa',
      password,
      database,
      containerId: container.containerId,
      host: container.host,
      port: container.port,
      waitForFtsReady: (maxWaitMs = 10_000, pollIntervalMs = 100) =>
        this.#waitForFtsReady(connectionString, maxWaitMs, pollIntervalMs),
      cleanup,
      [Symbol.asyncDispose]: cleanup,
    };
  }
}
