import {
  globalTeardown,
  postgresGlobalSetup,
  sqlServerGlobalSetup,
} from '@deepagents/test';

export async function globalSetup(): Promise<void> {
  await Promise.all([postgresGlobalSetup(), sqlServerGlobalSetup()]);
}

export { globalTeardown };
