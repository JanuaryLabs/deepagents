import { randomUUID } from 'node:crypto';

import { timebox } from '../async/timebox.ts';
import type { Container } from '../docker/container.ts';
import { Docker } from '../docker/docker.ts';
import type { Database, DatabaseOptions } from './database.ts';

export interface MysqlOptions extends DatabaseOptions {
  user?: string;
}

export interface MysqlDatabase extends Database {
  query: (sql: string) => Promise<Record<string, string | null>[]>;
}

export class Mysql {
  readonly #docker = new Docker();
  readonly #options;

  constructor({
    image = 'mysql:8.4',
    password = 'testpassword',
    database = 'app',
    user = 'root',
    labels,
  }: MysqlOptions = {}) {
    this.#options = { image, password, database, user, labels };
  }

  /** Create an isolated database on the persistent shared server. */
  async database(): Promise<MysqlDatabase> {
    const container = await this.#acquire('app', 'reuse');
    const database = `test_${randomUUID().replaceAll('-', '')}`;
    try {
      await this.#sql(container, `CREATE DATABASE \`${database}\``);
    } catch (error) {
      await container.disconnect();
      throw error;
    }
    return this.#handle(container, database, async () => {
      await this.#sql(
        container,
        `DROP DATABASE IF EXISTS \`${database}\``,
      ).catch(() => {
        /* Best-effort cleanup after external removal. */
      });
      await container.disconnect();
    });
  }

  /** Start a dedicated server; the returned handle owns its container. */
  async start(): Promise<MysqlDatabase> {
    const { database } = this.#options;
    const container = await this.#acquire(database, 'start');
    return this.#handle(container, database, container.cleanup);
  }

  #sql(container: Container, sql: string) {
    const { user, password } = this.#options;
    return container.exec([
      'mysql',
      `-u${user}`,
      `-p${password}`,
      '--execute',
      sql,
    ]);
  }

  async #query(
    container: Container,
    database: string,
    sql: string,
  ): Promise<Record<string, string | null>[]> {
    const { user, password } = this.#options;
    const { stdout } = await container.exec([
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
    return this.#parseBatch(stdout);
  }

  #parseBatch(stdout: string): Record<string, string | null>[] {
    const lines = stdout.trimEnd().split('\n').filter(Boolean);
    if (lines.length === 0) return [];
    const headers = lines[0].split('\t');
    return lines.slice(1).map((line) => {
      const values = line.split('\t');
      return Object.fromEntries(
        headers.map((header, index) => {
          const value = values[index];
          return [
            header,
            value === undefined || value === 'NULL' ? null : value,
          ];
        }),
      );
    });
  }

  #acquire(database: string, mode: 'start' | 'reuse'): Promise<Container> {
    const { image, password, labels } = this.#options;
    return this.#docker[mode]({
      image,
      labels,
      internalPort: 3306,
      env: { MYSQL_ROOT_PASSWORD: password, MYSQL_DATABASE: database },
      tmpfs: ['/var/lib/mysql:rw,size=512m'],
      memorySwappiness: 0,
      healthy: (container) => this.#ready(container),
    });
  }

  #ready(container: Container) {
    const { user, password } = this.#options;
    return timebox(
      () =>
        container.exec([
          'mysqladmin',
          'ping',
          '-h',
          '127.0.0.1',
          `-u${user}`,
          `-p${password}`,
          '--silent',
        ]),
      { maxRetryTime: 90_000 },
    );
  }

  #handle(
    container: Container,
    database: string,
    cleanup: () => Promise<void>,
  ): MysqlDatabase {
    const { image, user, password } = this.#options;
    return {
      connectionString: `mysql://${user}:${password}@${container.host}:${container.port}/${database}`,
      image,
      user,
      password,
      database,
      containerId: container.containerId,
      host: container.host,
      port: container.port,
      query: (sql) => this.#query(container, database, sql),
      cleanup,
      [Symbol.asyncDispose]: cleanup,
    };
  }
}
