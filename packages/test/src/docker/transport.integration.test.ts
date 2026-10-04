import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { test } from 'node:test';
import pg from 'pg';

import {
  Docker,
  Mysql,
  Postgres,
  SQL_SERVER_EDGE_IMAGE,
  SQL_SERVER_FULL_IMAGE,
  SqlServer,
} from '@deepagents/test';

test(
  'the selected Docker engine exposes a database to this Node process',
  { timeout: 120_000 },
  async () => {
    await using database = await new Postgres().start();
    const client = new pg.Client({
      connectionString: database.connectionString,
      connectionTimeoutMillis: 3_000,
    });
    try {
      await client.connect();
      assert.deepEqual((await client.query('SELECT 42 AS value')).rows, [
        { value: 42 },
      ]);
    } finally {
      await client.end();
    }
  },
);

test(
  'ports stay private and handles keep their original engine',
  { timeout: 120_000 },
  async () => {
    const docker = new Docker();
    const original = await docker.info();
    await using database = await new Postgres().start();
    const { stdout } = await docker.command(['inspect', database.containerId]);
    const [container] = JSON.parse(stdout);
    assert.equal(
      container.NetworkSettings.Ports['5432/tcp'][0].HostIp,
      '127.0.0.1',
    );
    assert.equal(container.HostConfig.Memory, 1024 ** 3);
    assert.equal(container.HostConfig.NanoCpus, 1_000_000_000);
    assert.notEqual(container.HostConfig.IpcMode, 'host');
    const previous = {
      host: process.env.DOCKER_HOST,
      context: process.env.DOCKER_CONTEXT,
    };
    try {
      process.env.DOCKER_HOST = 'unix:///nonexistent/docker-test.sock';
      delete process.env.DOCKER_CONTEXT;
      assert.deepEqual(await docker.info(), original);
      assert.equal(await new Docker().isAvailable(), false);
    } finally {
      if (previous.host === undefined) delete process.env.DOCKER_HOST;
      else process.env.DOCKER_HOST = previous.host;
      if (previous.context === undefined) delete process.env.DOCKER_CONTEXT;
      else process.env.DOCKER_CONTEXT = previous.context;
    }
  },
);

test(
  'disposing one database connection preserves other users of the shared server',
  { timeout: 120_000 },
  async () => {
    const labels = { 'dev.deepagents.test.verification': crypto.randomUUID() };
    const docker = new Docker();
    const postgres = new Postgres({ labels });
    let id: string | undefined;
    try {
      await using first = await postgres.database();
      id = first.containerId;
      await using second = await postgres.database();
      assert.equal(first.containerId, second.containerId);
      await first.cleanup();
      const client = new pg.Client({
        connectionString: second.connectionString,
        connectionTimeoutMillis: 3_000,
      });
      try {
        await client.connect();
        assert.deepEqual((await client.query('SELECT 7 AS value')).rows, [
          { value: 7 },
        ]);
      } finally {
        await client.end();
      }
    } finally {
      if (id) await docker.command(['rm', '--force', id]);
    }
  },
);

test('host fixtures preserve bytes, executable modes, and symlinks', async () => {
  await using directory = await new Docker().directory();
  await directory.mkdir("space and 'quote");
  const file = "space and 'quote/hello.txt";
  await directory.writeFile(file, 'hello\n\n', 0o755);
  await directory.symlink('hello.txt', "space and 'quote/link.txt");
  assert.equal(
    await directory.readFile("space and 'quote/link.txt"),
    'hello\n\n',
  );
  await directory.chmod(file, 0o644);
  await assert.rejects(directory.writeFile('../outside', 'no'), /inside/);
});

test(
  'MySQL exposes its protocol on the Node host',
  { timeout: 180_000 },
  async () => {
    await using database = await new Mysql().start();
    const client = connect({ host: database.host, port: database.port });
    client.setTimeout(5_000, () =>
      client.destroy(new Error('MySQL handshake timed out')),
    );
    let packet = Buffer.alloc(0);
    try {
      for await (const chunk of client) {
        packet = Buffer.concat([packet, chunk]);
        if (packet.length >= 5) break;
      }
      assert.equal(
        packet[4],
        10,
        'MySQL protocol version in the initial handshake',
      );
      assert.deepEqual(await database.query('SELECT 42 AS value'), [
        { value: '42' },
      ]);
    } finally {
      client.destroy();
    }
  },
);

test(
  'SQL Server chooses an image for the engine and accepts host connections',
  { timeout: 240_000 },
  async () => {
    const { default: sql } = await import('mssql');
    const { architecture } = await new Docker().info();
    await using database = await new SqlServer().start();
    assert.equal(
      database.image,
      ['aarch64', 'arm64'].includes(architecture)
        ? SQL_SERVER_EDGE_IMAGE
        : SQL_SERVER_FULL_IMAGE,
    );
    const pool = new sql.ConnectionPool(database.connectionString);
    try {
      await pool.connect();
      assert.equal(
        (await pool.request().query('SELECT 42 AS value')).recordset[0].value,
        42,
      );
    } finally {
      await pool.close();
    }
  },
);
