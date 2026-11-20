import { Postgres } from '@zukhruf/testing/postgres';
import * as assert from 'node:assert';
import { describe, it } from 'node:test';

import { PostgresFs } from '@deepagents/text2sql';

const testPostgres = new Postgres({ environment: process.env });

describe('PostgresFs', () => {
  describe('opening', () => {
    it('creates a new schema and root while other file systems open it at the same time', async () => {
      await using container = await testPostgres.database();
      const schema = `fs_${crypto.randomUUID().replaceAll('-', '_')}`;

      const results = await Promise.allSettled(
        Array.from({ length: 3 }, () =>
          PostgresFs.create({
            pool: container.pool(),
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
            result.status === 'fulfilled' ? 'opened' : result.reason.code,
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
      await using container = await testPostgres.database();
      const schema = `fs_${crypto.randomUUID().replaceAll('-', '_')}`;
      const initial = await PostgresFs.create({
        pool: container.pool(),
        schema,
        root: '/',
      });
      await initial.close();

      const results = await Promise.allSettled(
        Array.from({ length: 3 }, () =>
          PostgresFs.create({
            pool: container.pool(),
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
            result.status === 'fulfilled' ? 'opened' : result.reason.code,
          ),
          ['opened', 'opened', 'opened'],
        );
        await systems[0].writeFile('/notes.txt', 'shared');
        assert.strictEqual(await systems[2].readFile('/notes.txt'), 'shared');
      } finally {
        await Promise.all(systems.map((system) => system.close()));
      }
    });
  });

  describe('large file chunking', () => {
    it('should handle files larger than chunk size', async () => {
      await using container = await testPostgres.database();

      const chunkSize = 1024;
      const fs = await PostgresFs.create({
        pool: container.pool(),
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

  describe('copy and move operations', () => {
    it('should overwrite existing file on move', async () => {
      await using container = await testPostgres.database();

      const fs = await PostgresFs.create({
        pool: container.pool(),
        root: '/',
      });
      try {
        await fs.writeFile('/src.txt', 'new content');
        await fs.writeFile('/dest.txt', 'old content');
        await fs.mv('/src.txt', '/dest.txt');

        assert.strictEqual(await fs.exists('/src.txt'), false);
        assert.strictEqual(await fs.readFile('/dest.txt'), 'new content');
      } finally {
        await fs.close();
      }
    });

    it('should overwrite existing directory on move', async () => {
      await using container = await testPostgres.database();

      const fs = await PostgresFs.create({
        pool: container.pool(),
        root: '/',
      });
      try {
        await fs.mkdir('/src');
        await fs.writeFile('/src/a.txt', 'alpha');

        await fs.mkdir('/dest');
        await fs.writeFile('/dest/old.txt', 'stale');

        await fs.mv('/src', '/dest');

        assert.strictEqual(await fs.exists('/src'), false);
        assert.strictEqual(await fs.readFile('/dest/a.txt'), 'alpha');
        assert.strictEqual(await fs.exists('/dest/old.txt'), false);
      } finally {
        await fs.close();
      }
    });
  });

  describe('root option', () => {
    it('should prefix paths with root', async () => {
      await using container = await testPostgres.database();

      const fs = await PostgresFs.create({
        pool: container.pool(),
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
      await using container = await testPostgres.database();

      const fs = await PostgresFs.create({
        pool: container.pool(),
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
      await using container = await testPostgres.database();

      const pool = container.pool();
      const fs1 = await PostgresFs.create({ pool, root: '/chat-1' });
      const fs2 = await PostgresFs.create({ pool, root: '/chat-2' });

      await fs1.writeFile('/data.json', '{"chat": 1}');
      await fs2.writeFile('/data.json', '{"chat": 2}');

      assert.strictEqual(await fs1.readFile('/data.json'), '{"chat": 1}');
      assert.strictEqual(await fs2.readFile('/data.json'), '{"chat": 2}');

      await fs1.close();
      await fs2.close();
    });
  });

  describe('pool injection', () => {
    it('should accept a pre-existing Pool', async () => {
      await using container = await testPostgres.database();

      const pool = container.pool();
      const fs = await PostgresFs.create({ pool, root: '/' });
      try {
        await fs.writeFile('/pool-test.txt', 'injected pool');

        const content = await fs.readFile('/pool-test.txt');
        assert.strictEqual(content, 'injected pool');
      } finally {
        await fs.close();
      }

      const result = await pool.query('SELECT 1 AS val');
      assert.strictEqual(result.rows[0].val, 1);
    });

    it('should not close external pool on close()', async () => {
      await using container = await testPostgres.database();

      const pool = container.pool();
      const fs = await PostgresFs.create({ pool, root: '/' });
      await fs.writeFile('/no-close.txt', 'data');
      await fs.close();

      const result = await pool.query('SELECT 1 AS val');
      assert.strictEqual(result.rows[0].val, 1);
    });
  });

  describe('schema support', () => {
    it('should create tables in a custom schema', async () => {
      await using container = await testPostgres.database();

      const fs = await PostgresFs.create({
        pool: container.pool(),
        root: '/',
        schema: 'custom_fs_schema',
      });
      try {
        await fs.writeFile('/schema-test.txt', 'custom schema data');

        const content = await fs.readFile('/schema-test.txt');
        assert.strictEqual(content, 'custom schema data');

        const result = await container.pool().query(`
            SELECT table_schema, table_name
            FROM information_schema.tables
            WHERE table_schema = 'custom_fs_schema'
          `);
        assert.ok(result.rows.length > 0);
        assert.ok(
          result.rows.every(
            (r: { table_schema: string }) =>
              r.table_schema === 'custom_fs_schema',
          ),
        );
      } finally {
        await fs.close();
      }
    });

    it('should handle idempotent initialization', async () => {
      await using container = await testPostgres.database();
      const options = {
        pool: container.pool(),
        root: '/',
        schema: 'idempotent_fs_schema',
      };
      // Open the same schema twice: the second open finds its tables made.
      const first = await PostgresFs.create(options);
      await first.close();

      const fs = await PostgresFs.create(options);
      try {
        await fs.writeFile('/test.txt', 'idempotent');
        const content = await fs.readFile('/test.txt');
        assert.strictEqual(content, 'idempotent');
      } finally {
        await fs.close();
      }
    });

    it('should create schema in information_schema.schemata', async () => {
      await using container = await testPostgres.database();

      const fs = await PostgresFs.create({
        pool: container.pool(),
        root: '/',
        schema: 'ddl_created_fs_schema',
      });
      try {
        const result = await container.pool().query(`
            SELECT schema_name FROM information_schema.schemata
            WHERE schema_name = 'ddl_created_fs_schema'
          `);
        assert.strictEqual(result.rows.length, 1);
        assert.strictEqual(result.rows[0].schema_name, 'ddl_created_fs_schema');
      } finally {
        await fs.close();
      }
    });
  });
});
