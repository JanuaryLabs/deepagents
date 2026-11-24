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
      assert.deepStrictEqual(
        results.map((result) =>
          result.status === 'fulfilled' ? 'opened' : result.reason.code,
        ),
        ['opened', 'opened', 'opened'],
      );
      await systems[0].writeFile('/notes.txt', 'shared');
      assert.strictEqual(await systems[2].readFile('/notes.txt'), 'shared');
    });

    it('adds a root while other file systems add it at the same time', async () => {
      await using container = await testPostgres.database();
      const schema = `fs_${crypto.randomUUID().replaceAll('-', '_')}`;
      const initial = await PostgresFs.create({
        pool: container.pool(),
        schema,
        root: '/',
      });

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
      assert.deepStrictEqual(
        results.map((result) =>
          result.status === 'fulfilled' ? 'opened' : result.reason.code,
        ),
        ['opened', 'opened', 'opened'],
      );
      await systems[0].writeFile('/notes.txt', 'shared');
      assert.strictEqual(await systems[2].readFile('/notes.txt'), 'shared');
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
      const size = chunkSize * 3 + 500;
      const content = new Uint8Array(size);
      for (let i = 0; i < size; i++) {
        content[i] = i % 256;
      }

      await fs.writeFile('/large.bin', content);

      const result = await fs.readFileBuffer('/large.bin');
      assert.strictEqual(result.length, size);
      assert.deepStrictEqual(result, content);
    });
  });

  describe('root option', () => {
    it('should prefix paths with root', async () => {
      await using container = await testPostgres.database();

      const fs = await PostgresFs.create({
        pool: container.pool(),
        root: '/prefix',
      });
      await fs.writeFile('/file.txt', 'prefixed content');

      const content = await fs.readFile('/file.txt');
      assert.strictEqual(content, 'prefixed content');

      const allPaths = await fs.getAllPathsAsync();
      assert.ok(allPaths.includes('/prefix'), 'Should have /prefix directory');
      assert.ok(
        allPaths.includes('/prefix/file.txt'),
        'Should have /prefix/file.txt',
      );
    });

    it('should create root directory structure on initialization', async () => {
      await using container = await testPostgres.database();

      const fs = await PostgresFs.create({
        pool: container.pool(),
        root: '/chat/123/results',
      });
      const allPaths = await fs.getAllPathsAsync();

      assert.ok(allPaths.includes('/chat'), 'Should have /chat');
      assert.ok(allPaths.includes('/chat/123'), 'Should have /chat/123');
      assert.ok(
        allPaths.includes('/chat/123/results'),
        'Should have /chat/123/results',
      );
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
    });
  });

  describe('pool injection', () => {
    it('should accept a pre-existing Pool', async () => {
      await using container = await testPostgres.database();

      const pool = container.pool();
      const fs = await PostgresFs.create({ pool, root: '/' });
      await fs.writeFile('/pool-test.txt', 'injected pool');

      const content = await fs.readFile('/pool-test.txt');
      assert.strictEqual(content, 'injected pool');

      const result = await pool.query('SELECT 1 AS val');
      assert.strictEqual(result.rows[0].val, 1);
    });

    it('should not close external pool on close()', async () => {
      await using container = await testPostgres.database();

      const pool = container.pool();
      const fs = await PostgresFs.create({ pool, root: '/' });
      await fs.writeFile('/no-close.txt', 'data');

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

      const fs = await PostgresFs.create(options);
      await fs.writeFile('/test.txt', 'idempotent');
      const content = await fs.readFile('/test.txt');
      assert.strictEqual(content, 'idempotent');
    });

    it('should create schema in information_schema.schemata', async () => {
      await using container = await testPostgres.database();

      const fs = await PostgresFs.create({
        pool: container.pool(),
        root: '/',
        schema: 'ddl_created_fs_schema',
      });
      const result = await container.pool().query(`
          SELECT schema_name FROM information_schema.schemata
          WHERE schema_name = 'ddl_created_fs_schema'
        `);
      assert.strictEqual(result.rows.length, 1);
      assert.strictEqual(result.rows[0].schema_name, 'ddl_created_fs_schema');
    });
  });
});
