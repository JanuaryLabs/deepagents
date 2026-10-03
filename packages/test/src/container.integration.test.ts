import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

test('database helpers require provisioning and explicit startup requires Docker', () => {
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `
        import assert from 'node:assert/strict';
        import {
          withMysqlContainer,
          withPostgresContainer,
          withSqlServerContainer,
          startMysqlContainer,
          startPostgresContainer,
          startSqlServerContainer,
        } from '@deepagents/test';

        delete process.env.DEEPAGENTS_TEST_SERVERS;
        for (const withContainer of [
          withMysqlContainer,
          withPostgresContainer,
          withSqlServerContainer,
        ]) {
          await assert.rejects(
            withContainer(async () => assert.fail('callback must not run')),
            /No provisioned/,
          );
        }
        for (const startContainer of [startMysqlContainer, startPostgresContainer, startSqlServerContainer]) {
          await assert.rejects(startContainer(), /Docker is required/);
        }
      `,
    ],
    {
      encoding: 'utf8',
      env: { ...process.env, PATH: '/usr/bin:/bin' },
    },
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
});
