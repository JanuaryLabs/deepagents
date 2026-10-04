import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

import * as primitives from '@deepagents/test';

test('the public API exposes only the instance API and independent test primitives', () => {
  assert.deepEqual(
    Object.keys(primitives).sort(),
    [
      'Container',
      'Docker',
      'DuckDB',
      'Mysql',
      'Postgres',
      'SQL_SERVER_EDGE_IMAGE',
      'SQL_SERVER_FULL_IMAGE',
      'SqlServer',
      'Sqlite',
      'settleWithin',
      'timebox',
    ].sort(),
  );
});

test('container-backed databases require Docker; SQLite works without it', () => {
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `
        import assert from 'node:assert/strict';
        import { Docker, Mysql, Postgres, SqlServer, Sqlite } from '@deepagents/test';

        for (const server of [new Mysql(), new Postgres(), new SqlServer()]) {
          await assert.rejects(server.database(), /Docker is required/);
          await assert.rejects(server.start(), /Docker is required/);
        }
        const docker = new Docker();
        assert.equal(await docker.isAvailable(), false);
        const config = { image: 'postgres:18-alpine', internalPort: 5432 };
        await assert.rejects(docker.start(config), /Docker is required/);
        await assert.rejects(docker.reuse(config), /Docker is required/);
        await using database = await new Sqlite().database();
        assert.equal(database.connection.prepare('SELECT 1 AS value').get().value, 1);
      `,
    ],
    {
      encoding: 'utf8',
      env: { ...process.env, PATH: '/usr/bin:/bin' },
    },
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
});
