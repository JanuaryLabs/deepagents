import { untilAborted } from '@zukhruf/async';
import { SqlServer } from '@zukhruf/testing/sqlserver';
import sql from 'mssql';
import * as assert from 'node:assert';
import { describe, it } from 'node:test';

import { MssqlFs } from '@deepagents/text2sql';

const testSqlServer = new SqlServer({ environment: process.env });

describe('MssqlFs', () => {
  describe('opening', () => {
    it('creates a new schema and root while other file systems open it at the same time', async () => {
      await using container = await testSqlServer.database();
      const schema = `fs_${crypto.randomUUID().replaceAll('-', '_')}`;

      const results = await Promise.allSettled(
        Array.from({ length: 3 }, () =>
          MssqlFs.create({
            pool: container.connectionString,
            schema,
            root: '/workspace/project',
          }),
        ),
      );
      const systems = results.flatMap((result) =>
        result.status === 'fulfilled' ? [result.value] : [],
      );
      try {
        assert.deepStrictEqual(
          results.map((result) =>
            result.status === 'fulfilled' ? 'opened' : result.reason.message,
          ),
          ['opened', 'opened', 'opened'],
        );
        await systems[0].writeFile('/notes.txt', 'shared');
        assert.strictEqual(await systems[2].readFile('/notes.txt'), 'shared');
      } finally {
        await Promise.all(systems.map((system) => system.close()));
      }
    });

    it('adds a root while other file systems add it at the same time', async () => {
      await using container = await testSqlServer.database();
      const schema = `fs_${crypto.randomUUID().replaceAll('-', '_')}`;
      const initial = await MssqlFs.create({
        pool: container.connectionString,
        schema,
        root: '/',
      });
      await initial.close();

      const results = await Promise.allSettled(
        Array.from({ length: 3 }, () =>
          MssqlFs.create({
            pool: container.connectionString,
            schema,
            root: '/workspace/project',
          }),
        ),
      );
      const systems = results.flatMap((result) =>
        result.status === 'fulfilled' ? [result.value] : [],
      );
      try {
        assert.deepStrictEqual(
          results.map((result) =>
            result.status === 'fulfilled' ? 'opened' : result.reason.message,
          ),
          ['opened', 'opened', 'opened'],
        );
        await systems[0].writeFile('/notes.txt', 'shared');
        assert.strictEqual(await systems[2].readFile('/notes.txt'), 'shared');
      } finally {
        await Promise.all(systems.map((system) => system.close()));
      }
    });

    it('lets the next file system open after an open fails on a caller-owned pool', async (t) => {
      await using container = await testSqlServer.database();
      const schema = `fs_${crypto.randomUUID().replaceAll('-', '_')}`;
      const pool = await new sql.ConnectionPool(
        container.connectionString,
      ).connect();
      try {
        // Platform setup: a view where the DDL creates a table makes the open
        // fail partway; no file-system operation can produce that state.
        await pool.request().batch(`CREATE SCHEMA [${schema}]`);
        await pool
          .request()
          .batch(`CREATE VIEW [${schema}].[fs_entries] AS SELECT 1 AS path`);
        await assert.rejects(
          MssqlFs.create({ pool, schema, root: '/' }),
          /already an object named 'fs_entries'/,
        );
        await pool.request().batch(`DROP VIEW [${schema}].[fs_entries]`);

        const fs = await untilAborted(
          MssqlFs.create({
            pool: container.connectionString,
            schema,
            root: '/',
          }),
          t.signal,
        );
        try {
          await fs.writeFile('/after.txt', 'opened');
          assert.strictEqual(await fs.readFile('/after.txt'), 'opened');
        } finally {
          await fs.close();
        }
      } finally {
        await pool.close();
      }
    });
  });

  describe('large file chunking', () => {
    it('should handle files larger than chunk size', async () => {
      await using container = await testSqlServer.database();

      const chunkSize = 1024;
      const fs = await MssqlFs.create({
        pool: container.connectionString,
        root: '/',
        chunkSize,
      });
      try {
        const size = chunkSize * 3 + 500;
        const content = new Uint8Array(size);
        for (let i = 0; i < size; i++) {
          content[i] = i % 256;
        }

        await fs.writeFile('/large.bin', content);

        const result = await fs.readFileBuffer('/large.bin');
        assert.strictEqual(result.length, size);
        assert.deepStrictEqual(result, content);
      } finally {
        await fs.close();
      }
    });
  });

  describe('root option', () => {
    it('should prefix paths with root', async () => {
      await using container = await testSqlServer.database();

      const fs = await MssqlFs.create({
        pool: container.connectionString,
        root: '/prefix',
      });
      try {
        await fs.writeFile('/file.txt', 'prefixed content');

        const content = await fs.readFile('/file.txt');
        assert.strictEqual(content, 'prefixed content');

        const allPaths = await fs.getAllPathsAsync();
        assert.ok(
          allPaths.includes('/prefix'),
          'Should have /prefix directory',
        );
        assert.ok(
          allPaths.includes('/prefix/file.txt'),
          'Should have /prefix/file.txt',
        );
      } finally {
        await fs.close();
      }
    });

    it('should create root directory structure on initialization', async () => {
      await using container = await testSqlServer.database();

      const fs = await MssqlFs.create({
        pool: container.connectionString,
        root: '/chat/123/results',
      });
      try {
        const allPaths = await fs.getAllPathsAsync();

        assert.ok(allPaths.includes('/chat'), 'Should have /chat');
        assert.ok(allPaths.includes('/chat/123'), 'Should have /chat/123');
        assert.ok(
          allPaths.includes('/chat/123/results'),
          'Should have /chat/123/results',
        );
      } finally {
        await fs.close();
      }
    });

    it('should isolate two instances with different roots', async () => {
      await using container = await testSqlServer.database();

      const pool = new sql.ConnectionPool(container.connectionString);
      await pool.connect();
      try {
        const fs1 = await MssqlFs.create({ pool, root: '/chat-1' });
        const fs2 = await MssqlFs.create({ pool, root: '/chat-2' });

        await fs1.writeFile('/data.json', '{"chat": 1}');
        await fs2.writeFile('/data.json', '{"chat": 2}');

        assert.strictEqual(await fs1.readFile('/data.json'), '{"chat": 1}');
        assert.strictEqual(await fs2.readFile('/data.json'), '{"chat": 2}');

        await fs1.close();
        await fs2.close();
      } finally {
        await pool.close();
      }
    });
  });

  describe('pool injection', () => {
    it('should accept a pre-existing ConnectionPool', async () => {
      await using container = await testSqlServer.database();

      const pool = new sql.ConnectionPool(container.connectionString);
      await pool.connect();
      try {
        const fs = await MssqlFs.create({ pool, root: '/' });
        try {
          await fs.writeFile('/pool-test.txt', 'injected pool');

          const content = await fs.readFile('/pool-test.txt');
          assert.strictEqual(content, 'injected pool');
        } finally {
          await fs.close();
        }

        assert.strictEqual(pool.connected, true);
      } finally {
        await pool.close();
      }
    });

    it('should not close external pool on close()', async () => {
      await using container = await testSqlServer.database();

      const pool = new sql.ConnectionPool(container.connectionString);
      await pool.connect();
      try {
        const fs = await MssqlFs.create({ pool, root: '/' });
        await fs.writeFile('/no-close.txt', 'data');
        await fs.close();

        assert.strictEqual(pool.connected, true);

        const result = await pool.request().query('SELECT 1 AS val');
        assert.strictEqual(result.recordset[0].val, 1);
      } finally {
        await pool.close();
      }
    });
  });

  describe('schema support', () => {
    it('should create tables in a custom schema', async () => {
      await using container = await testSqlServer.database();

      const fs = await MssqlFs.create({
        pool: container.connectionString,
        root: '/',
        schema: 'custom_fs_schema',
      });
      try {
        await fs.writeFile('/schema-test.txt', 'custom schema data');

        const content = await fs.readFile('/schema-test.txt');
        assert.strictEqual(content, 'custom schema data');

        const pool = new sql.ConnectionPool(container.connectionString);
        await pool.connect();
        try {
          const result = await pool.request().query(`
              SELECT TABLE_SCHEMA, TABLE_NAME
              FROM INFORMATION_SCHEMA.TABLES
              WHERE TABLE_SCHEMA = 'custom_fs_schema'
            `);
          assert.ok(result.recordset.length > 0);
          assert.ok(
            result.recordset.every(
              (r: { TABLE_SCHEMA: string }) =>
                r.TABLE_SCHEMA === 'custom_fs_schema',
            ),
          );
        } finally {
          await pool.close();
        }
      } finally {
        await fs.close();
      }
    });

    it('should create schema in sys.schemas', async () => {
      await using container = await testSqlServer.database();

      const fs = await MssqlFs.create({
        pool: container.connectionString,
        root: '/',
        schema: 'ddl_created_fs_schema',
      });
      try {
        const pool = new sql.ConnectionPool(container.connectionString);
        await pool.connect();
        try {
          const result = await pool.request().query(`
              SELECT name FROM sys.schemas WHERE name = 'ddl_created_fs_schema'
            `);
          assert.strictEqual(result.recordset.length, 1);
          assert.strictEqual(result.recordset[0].name, 'ddl_created_fs_schema');
        } finally {
          await pool.close();
        }
      } finally {
        await fs.close();
      }
    });

    it('should handle idempotent initialization', async () => {
      await using container = await testSqlServer.database();
      const options = {
        pool: container.connectionString,
        root: '/',
        schema: 'idempotent_fs_schema',
      };
      // Open the same schema twice: the second open finds its tables made.
      const first = await MssqlFs.create(options);
      await first.close();

      const fs = await MssqlFs.create(options);
      try {
        await fs.writeFile('/test.txt', 'idempotent');
        const content = await fs.readFile('/test.txt');
        assert.strictEqual(content, 'idempotent');
      } finally {
        await fs.close();
      }
    });
  });
});
