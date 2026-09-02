import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

test('database container helpers fail closed when Docker is unavailable', () => {
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
        } from '@deepagents/test';

        for (const withContainer of [
          withMysqlContainer,
          withPostgresContainer,
          withSqlServerContainer,
        ]) {
          await assert.rejects(
            withContainer(async () => assert.fail('callback must not run')),
            /Docker is required/,
          );
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
