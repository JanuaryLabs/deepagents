import command from 'nano-spawn';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  globalTeardown,
  mysqlGlobalSetup,
  withMysqlContainer,
} from '@deepagents/test';

test(
  'standalone MySQL setup shares a server and drops isolated databases',
  { timeout: 180_000 },
  async () => {
    await mysqlGlobalSetup();
    const ids = new Set<string>();
    try {
      const first = await withMysqlContainer(async (container) => {
        ids.add(container.containerId);
        await container.query('CREATE TABLE isolated (id INT)');
        return container;
      });
      const second = await withMysqlContainer(async (container) => {
        ids.add(container.containerId);
        assert.deepEqual(await container.query('SHOW TABLES'), []);
        return container;
      });
      assert.equal(ids.size, 1);
      assert.notEqual(first.database, second.database);
      const { stdout } = await command('docker', [
        'exec',
        first.containerId,
        'mysql',
        `-u${first.user}`,
        `-p${first.password}`,
        '--batch',
        '--skip-column-names',
        '--execute',
        `SELECT COUNT(*) FROM information_schema.schemata WHERE schema_name IN ('${first.database}', '${second.database}')`,
      ]);
      assert.equal(stdout.trim(), '0');
      await assert.rejects(
        withMysqlContainer(async () => assert.fail(), {
          image: 'unprovisioned',
        }),
        /No provisioned/,
      );
    } finally {
      await globalTeardown();
    }
    for (const id of ids) {
      const { stdout } = await command('docker', [
        'ps',
        '-aq',
        '--filter',
        `id=${id}`,
      ]);
      assert.equal(stdout.trim(), '');
    }
  },
);
