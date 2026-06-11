import { publishMysqlEnv, startMysqlContainer } from './mysql-container.ts';
import {
  publishPostgresEnv,
  startPostgresContainer,
} from './postgres-container.ts';
import {
  publishSqlServerEnv,
  startSqlServerContainer,
} from './sqlserver-container.ts';

interface ProvisionedContainer {
  cleanup: () => Promise<void>;
}

const provisioned: ProvisionedContainer[] = [];

/**
 * `globalSetup` building block for the Node test runner (`--test-global-setup`):
 * boot ONE PostgreSQL container for the whole run and publish its coordinates to
 * the environment, so every test file's {@link withPostgresContainer} reuses it
 * (one boot for the run, not one per file) and does its own per-test
 * `CREATE DATABASE`. Pair with {@link globalTeardown}.
 *
 * @example
 * ```typescript
 * // packages/<pkg>/test/global-setup.ts
 * import {
 *   postgresGlobalSetup,
 *   sqlServerGlobalSetup,
 *   globalTeardown,
 * } from '@deepagents/test';
 * export async function globalSetup() {
 *   await Promise.all([postgresGlobalSetup(), sqlServerGlobalSetup()]);
 * }
 * export { globalTeardown };
 * // then: node --test --test-global-setup=packages/<pkg>/test/global-setup.ts ...
 * ```
 */
export async function postgresGlobalSetup(): Promise<void> {
  const container = await startPostgresContainer();
  if (container) {
    publishPostgresEnv(container);
    provisioned.push(container);
  }
}

/**
 * `globalSetup` building block that boots ONE SQL Server container for the whole
 * run and publishes its coordinates, so {@link withSqlServerContainer} reuses it
 * and does its own per-test `CREATE DATABASE`. Pair with {@link globalTeardown}.
 */
export async function sqlServerGlobalSetup(): Promise<void> {
  const container = await startSqlServerContainer();
  if (container) {
    publishSqlServerEnv(container);
    provisioned.push(container);
  }
}

/**
 * `globalSetup` building block that boots ONE MySQL container for the whole run
 * and publishes its coordinates, so {@link withMysqlContainer} reuses it and
 * does its own per-test `CREATE DATABASE`. Pair with {@link globalTeardown}.
 */
export async function mysqlGlobalSetup(): Promise<void> {
  const container = await startMysqlContainer();
  if (container) {
    publishMysqlEnv(container);
    provisioned.push(container);
  }
}

/**
 * `globalTeardown` for every container provisioned by the `*GlobalSetup` helpers.
 * Stops them with a proper async call — runs in the runner process, which owns
 * the containers, so no `process.on('exit')` hack is needed on this path.
 */
export async function globalTeardown(): Promise<void> {
  const pending = provisioned.splice(0);
  await Promise.all(pending.map((container) => container.cleanup()));
}
