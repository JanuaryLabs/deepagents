import { randomUUID } from 'node:crypto';

import { timebox } from '../async/timebox.ts';
import type { Container } from '../docker/container.ts';
import { Docker } from '../docker/docker.ts';
import type { Database, DatabaseOptions } from './database.ts';

export interface PostgresOptions extends DatabaseOptions {
  user?: string;
}

/** PostgreSQL test configuration. Each acquisition returns an independent handle. */
export class Postgres {
  readonly #docker = new Docker();
  readonly #options;

  constructor({
    image = 'postgres:18-alpine',
    password = 'testpassword',
    database = 'testdb',
    user = 'postgres',
    labels,
  }: PostgresOptions = {}) {
    this.#options = { image, password, database, user, labels };
  }

  /** Create an isolated database on the persistent shared server. */
  async database(): Promise<Database> {
    const container = await this.#acquire('postgres', 'reuse');
    const database = `test_${randomUUID().replaceAll('-', '')}`;
    await this.#sql(container, `CREATE DATABASE ${database}`);
    return this.#handle(container, database, async () => {
      await this.#sql(
        container,
        `DROP DATABASE IF EXISTS ${database} WITH (FORCE)`,
      ).catch(() => {
        /* Best-effort cleanup after external removal. */
      });
    });
  }

  /** Start a dedicated server; the returned handle owns its container. */
  async start(): Promise<Database> {
    const { database } = this.#options;
    const container = await this.#acquire(database, 'start');
    return this.#handle(container, database, container.cleanup);
  }

  #sql(container: Container, sql: string) {
    return container.exec([
      'psql',
      '-U',
      this.#options.user,
      '-d',
      'postgres',
      '-c',
      sql,
    ]);
  }

  #acquire(database: string, mode: 'start' | 'reuse'): Promise<Container> {
    const { image, password, user, labels } = this.#options;
    return this.#docker[mode]({
      image,
      labels,
      internalPort: 5432,
      env: {
        POSTGRES_PASSWORD: password,
        POSTGRES_DB: database,
        POSTGRES_USER: user,
      },
      tmpfs: ['/var/lib/postgresql:rw,size=512m'],
      ipcHost: true,
      memorySwappiness: 0,
      healthy: (container) => this.#ready(container, database),
    });
  }

  #ready(container: Container, database: string): Promise<void> {
    const { user } = this.#options;
    // TCP excludes PostgreSQL's temporary, socket-only initialization server.
    return timebox(
      async () => {
        await container.exec(['pg_isready', '-h', '127.0.0.1', '-U', user]);
        await container.exec([
          'psql',
          '-h',
          '127.0.0.1',
          '-U',
          user,
          '-d',
          database,
          '-c',
          'SELECT 1',
        ]);
      },
      { maxRetryTime: 60_000 },
    );
  }

  #handle(
    container: Container,
    database: string,
    cleanup: () => Promise<void>,
  ): Database {
    const { image, user, password } = this.#options;
    return {
      connectionString: `postgresql://${user}:${password}@localhost:${container.port}/${database}`,
      image,
      user,
      password,
      database,
      containerId: container.containerId,
      host: container.host,
      port: container.port,
      cleanup,
      [Symbol.asyncDispose]: cleanup,
    };
  }
}
