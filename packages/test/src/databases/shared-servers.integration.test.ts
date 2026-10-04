import command from 'nano-spawn';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { promisify } from 'node:util';

import { Postgres, SQL_SERVER_FULL_IMAGE, SqlServer } from '@deepagents/test';

const execute = promisify(execFile);

test(
  'one instance acquires concurrent databases with independent scope cleanup',
  { timeout: 120_000 },
  async (t) => {
    const scope = randomUUID();
    const postgres = new Postgres({
      labels: { 'dev.deepagents.test.verification': scope },
    });
    t.after(async () => {
      const { stdout } = await command('docker', [
        'ps',
        '-aq',
        '--filter',
        `label=dev.deepagents.test.verification=${scope}`,
      ]);
      for (const id of stdout.split('\n').filter(Boolean))
        await command('docker', ['rm', '--force', id]);
    });
    const databases = await Promise.all([
      postgres.database(),
      postgres.database(),
    ]);
    const [first, second] = databases;
    const count = async (name: string) => {
      const { stdout } = await command('docker', [
        'exec',
        first.containerId,
        'psql',
        '-U',
        first.user,
        '-d',
        'postgres',
        '-Atc',
        `SELECT COUNT(*) FROM pg_database WHERE datname = '${name}'`,
      ]);
      return stdout;
    };
    {
      await using outer = first;
      {
        await using inner = second;
        assert.equal(outer.containerId, inner.containerId);
        assert.notEqual(outer.database, inner.database);
        assert.equal(await count(outer.database), '1');
        assert.equal(await count(inner.database), '1');
      }
      assert.equal(await count(first.database), '1');
      assert.equal(await count(second.database), '0');
    }
    assert.equal(await count(first.database), '0');
    await using next = await postgres.database();
    assert.equal(next.containerId, first.containerId);
    assert.notEqual(next.database, first.database);
  },
);

test(
  'explicit SQL Server startup creates the requested database and owns cleanup',
  {
    timeout: 240_000,
  },
  async (t) => {
    const database = `owned_${randomUUID().replaceAll('-', '')}`;
    let id: string;
    {
      await using server = await new SqlServer({ database }).start();
      id = server.containerId;
      const { default: sql } = await import('mssql');
      const pool = new sql.ConnectionPool(server.connectionString);
      try {
        await pool.connect();
        const result = await pool.request().query('SELECT DB_NAME() AS name');
        assert.equal(result.recordset[0].name, database);
      } finally {
        await pool.close();
      }
    }
    await t.waitFor(
      async () => {
        const { stdout } = await command('docker', [
          'ps',
          '-aq',
          '--filter',
          `id=${id}`,
        ]);
        assert.equal(stdout, '');
      },
      { timeout: 5_000 },
    );
  },
);

interface DatabaseHandle {
  containerId: string;
  database: string;
  user: string;
  password: string;
  port: number;
}

// Run through the public package in independent Node processes, with no runner
// setup or shared JavaScript module state.
const worker = `
  import assert from 'node:assert/strict';
  import command from 'nano-spawn';
  import sql from 'mssql';
  import * as helpers from '@deepagents/test';
  const { helper, config, fail } = JSON.parse(process.argv[1]);
  let handle;
  try {
    {
      await using container = await new helpers[helper](config).database();
      handle = container;
      if (helper === 'Postgres') {
        await command('docker', ['exec', container.containerId, 'psql',
          '-U', container.user, '-d', container.database, '-v', 'ON_ERROR_STOP=1',
          '-c', 'CREATE TABLE isolated (id INT); INSERT INTO isolated VALUES (1)']);
      } else if (helper === 'Mysql') {
        assert.deepEqual(await container.query('SHOW TABLES'), []);
        await container.query('CREATE TABLE isolated (id INT)');
        await container.query('INSERT INTO isolated VALUES (1)');
      } else {
        const pool = new sql.ConnectionPool(container.connectionString);
        try {
          await pool.connect();
          await pool.request().query('CREATE TABLE isolated (id INT); INSERT INTO isolated VALUES (1)');
        } finally {
          await pool.close();
        }
      }
      if (fail) throw new Error('intentional scope failure');
    }
    assert.equal(fail, false);
  } catch (error) {
    if (!fail || error.message !== 'intentional scope failure') throw error;
  }
  console.log(JSON.stringify(handle));
`;

for (const [engine, helper, config] of [
  ['postgres', 'Postgres', { user: 'shared_tester' }],
  ['mysql', 'Mysql', {}],
  ['sqlserver', 'SqlServer', {}],
  ['sqlserver-full', 'SqlServer', { image: SQL_SERVER_FULL_IMAGE }],
] as const) {
  test(
    `${engine} shares across processes and restarts until explicit cleanup`,
    {
      timeout: 300_000,
    },
    async (t) => {
      const scope = randomUUID();
      const labels = { 'dev.deepagents.test.verification': scope };
      t.after(async () => {
        const { stdout } = await command('docker', [
          'ps',
          '-aq',
          '--filter',
          `label=dev.deepagents.test.verification=${scope}`,
        ]);
        for (const id of stdout.split('\n').filter(Boolean)) {
          await command('docker', ['rm', '--force', id]);
        }
      });

      const run = async (fail: boolean): Promise<DatabaseHandle> => {
        const env = { ...process.env };
        delete env.NODE_TEST_CONTEXT;
        const { stdout } = await execute(
          process.execPath,
          [
            '--input-type=module',
            '--eval',
            worker,
            JSON.stringify({
              helper,
              config: {
                ...config,
                labels,
                database: `requested_${randomUUID()}`,
              },
              fail,
            }),
          ],
          { env, signal: t.signal },
        );
        return JSON.parse(stdout);
      };

      const concurrent = await Promise.allSettled([
        run(false),
        run(false),
        run(false),
      ]);
      const first = concurrent.map((result) => {
        assert.equal(
          result.status,
          'fulfilled',
          result.status === 'rejected' ? String(result.reason) : '',
        );
        return result.value;
      });
      const restarted = await run(false);
      const failed = await run(true);
      const handles = [...first, restarted, failed];
      const [server] = handles;
      assert.equal(
        new Set(handles.map((handle) => handle.containerId)).size,
        1,
      );
      assert.equal(
        new Set(handles.map((handle) => handle.database)).size,
        handles.length,
      );

      const names = handles.map(({ database }) => `'${database}'`).join(',');
      if (engine === 'postgres') {
        const { stdout } = await command('docker', [
          'exec',
          server.containerId,
          'psql',
          '-U',
          server.user,
          '-d',
          'postgres',
          '-Atc',
          `SELECT COUNT(*) FROM pg_database WHERE datname IN (${names})`,
        ]);
        assert.equal(stdout.trim(), '0');
      } else if (engine === 'mysql') {
        const { stdout } = await command('docker', [
          'exec',
          server.containerId,
          'mysql',
          `-u${server.user}`,
          `-p${server.password}`,
          '--batch',
          '--skip-column-names',
          '--execute',
          `SELECT COUNT(*) FROM information_schema.schemata WHERE schema_name IN (${names})`,
        ]);
        assert.equal(stdout.trim(), '0');
      } else {
        const { default: sql } = await import('mssql');
        const pool = new sql.ConnectionPool({
          server: 'localhost',
          port: server.port,
          user: server.user,
          password: server.password,
          database: 'master',
          options: { trustServerCertificate: true, encrypt: false },
        });
        try {
          await pool.connect();
          const result = await pool
            .request()
            .query(
              `SELECT COUNT(*) AS count FROM sys.databases WHERE name IN (${names})`,
            );
          assert.equal(result.recordset[0].count, 0);
        } finally {
          await pool.close();
        }
      }

      const { stdout } = await command('docker', [
        'inspect',
        '--format',
        '{{.State.Running}}',
        server.containerId,
      ]);
      assert.equal(stdout, 'true');
      await command('docker', ['stop', server.containerId]);
      await t.waitFor(
        async () => {
          const { stdout } = await command('docker', [
            'ps',
            '-aq',
            '--filter',
            `id=${server.containerId}`,
          ]);
          assert.equal(stdout, '');
        },
        { timeout: 5_000 },
      );
      const replacement = await run(false);
      assert.notEqual(replacement.containerId, server.containerId);
    },
  );
}
