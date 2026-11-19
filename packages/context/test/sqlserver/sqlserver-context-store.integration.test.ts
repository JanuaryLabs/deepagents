import { untilAborted } from '@zukhruf/async';
import { SqlServer } from '@zukhruf/testing/sqlserver';
import sql from 'mssql';
import assert from 'node:assert';
import { describe, it } from 'node:test';

import { SqlServerContextStore } from '@deepagents/context';

import { waitForFtsReady } from './wait-for-fts-ready.ts';

const testSqlServer = new SqlServer({ environment: process.env });

/**
 * Integration tests for SQL Server ContextStore.
 *
 * These tests require Docker to be installed and running.
 * Tests fail explicitly if Docker is not available.
 */
describe('SQL Server ContextStore Integration', () => {
  // ==========================================================================
  // Message Operations
  // ==========================================================================

  describe('Message Operations', () => {
    it('serializes concurrent chat updaters from independent stores', async () => {
      await using container = await testSqlServer.database();

      const first = await SqlServerContextStore.create({
        pool: container.connectionString,
      });
      const second = await SqlServerContextStore.create({
        pool: container.connectionString,
      });
      try {
        await first.createChat({ id: 'chat-cas', userId: 'user-1' });
        await Promise.all([
          first.updateChat('chat-cas', (chat) => ({
            metadata: { ...chat.metadata, firstKey: 'first' },
          })),
          second.updateChat('chat-cas', (chat) => ({
            metadata: { ...chat.metadata, secondKey: 'second' },
          })),
        ]);
        assert.deepStrictEqual((await first.getChat('chat-cas'))?.metadata, {
          firstKey: 'first',
          secondKey: 'second',
        });
      } finally {
        await first.close();
        await second.close();
      }
    });
  });

  // ==========================================================================
  // Search Operations (CONTAINSTABLE)
  // ==========================================================================

  describe('Search Operations', () => {
    it('should return ranked results', async () => {
      await using container = await testSqlServer.database();

      const store = await SqlServerContextStore.create({
        pool: container.connectionString,
      });
      try {
        await store.createChat({ id: 'chat-rank', userId: 'user-1' });

        await store.addMessage({
          id: 'rank-msg-1',
          chatId: 'chat-rank',
          parentId: null,
          name: 'user',
          data: 'I need to change my settings',
          createdAt: Date.now(),
        });

        await store.addMessage({
          id: 'rank-msg-2',
          chatId: 'chat-rank',
          parentId: 'rank-msg-1',
          name: 'assistant',
          data: 'Settings settings settings are important',
          createdAt: Date.now(),
        });

        // Wait for full-text index to populate (SQL Server FTS is async)
        await waitForFtsReady(container.connectionString);

        const results = await store.searchMessages('chat-rank', 'settings');

        assert.ok(results.length > 0);

        // Results should have a rank
        assert.ok(results.every((r) => typeof r.rank === 'number'));
      } finally {
        await store.close();
      }
    });

    it('should return snippets', async () => {
      await using container = await testSqlServer.database();

      const store = await SqlServerContextStore.create({
        pool: container.connectionString,
      });
      try {
        await store.createChat({ id: 'chat-snippet', userId: 'user-1' });

        await store.addMessage({
          id: 'snippet-msg-1',
          chatId: 'chat-snippet',
          parentId: null,
          name: 'user',
          data: 'How do I configure my settings?',
          createdAt: Date.now(),
        });

        // Wait for full-text index to populate (SQL Server FTS is async)
        await waitForFtsReady(container.connectionString);

        const results = await store.searchMessages('chat-snippet', 'configure');

        assert.ok(results.length > 0);
        assert.ok(results[0].snippet);
      } finally {
        await store.close();
      }
    });
  });

  // ==========================================================================
  // Pool Injection
  // ==========================================================================

  describe('Pool Injection', () => {
    it('should accept a pre-existing connected ConnectionPool', async () => {
      await using container = await testSqlServer.database();

      const pool = new sql.ConnectionPool(container.connectionString);
      await pool.connect();
      try {
        const store = await SqlServerContextStore.create({ pool });
        try {
          await store.createChat({
            id: 'chat-pool-inject',
            userId: 'user-1',
            title: 'Pool Injection Test',
          });

          const chat = await store.getChat('chat-pool-inject');
          assert.ok(chat);
          assert.strictEqual(chat.id, 'chat-pool-inject');
        } finally {
          await store.close();
        }

        assert.strictEqual(pool.connected, true);
      } finally {
        await pool.close();
      }
    });

    it('should not close external pool on store.close()', async () => {
      await using container = await testSqlServer.database();

      const pool = new sql.ConnectionPool(container.connectionString);
      await pool.connect();
      try {
        const store = await SqlServerContextStore.create({ pool });
        await store.createChat({
          id: 'chat-no-close',
          userId: 'user-1',
        });

        await store.close();

        assert.strictEqual(pool.connected, true);

        const request = pool.request();
        const result = await request.query('SELECT 1 AS val');
        assert.strictEqual(result.recordset[0].val, 1);
      } finally {
        await pool.close();
      }
    });

    it('should allow two store instances to share the same pool', async () => {
      await using container = await testSqlServer.database();

      const pool = new sql.ConnectionPool(container.connectionString);
      await pool.connect();
      try {
        const store1 = await SqlServerContextStore.create({ pool });
        const store2 = await SqlServerContextStore.create({ pool });

        await store1.createChat({
          id: 'chat-shared-1',
          userId: 'user-1',
        });

        const chat = await store2.getChat('chat-shared-1');
        assert.ok(chat);
        assert.strictEqual(chat.id, 'chat-shared-1');

        await store1.close();
        await store2.close();

        assert.strictEqual(pool.connected, true);
      } finally {
        await pool.close();
      }
    });
  });

  // ==========================================================================
  // Schema Support
  // ==========================================================================

  describe('Schema Support', () => {
    it('should create tables in a custom schema', async () => {
      await using container = await testSqlServer.database();

      const store = await SqlServerContextStore.create({
        pool: container.connectionString,
        schema: 'custom_schema',
      });
      try {
        await store.createChat({
          id: 'chat-custom-schema',
          userId: 'user-1',
          title: 'Custom Schema Chat',
        });

        const chat = await store.getChat('chat-custom-schema');
        assert.ok(chat);
        assert.strictEqual(chat.title, 'Custom Schema Chat');

        const pool = new sql.ConnectionPool(container.connectionString);
        await pool.connect();
        try {
          const result = await pool.request().query(`
              SELECT TABLE_SCHEMA, TABLE_NAME
              FROM INFORMATION_SCHEMA.TABLES
              WHERE TABLE_SCHEMA = 'custom_schema'
            `);
          assert.ok(result.recordset.length > 0);
          assert.ok(
            result.recordset.every(
              (r: { TABLE_SCHEMA: string }) =>
                r.TABLE_SCHEMA === 'custom_schema',
            ),
          );
        } finally {
          await pool.close();
        }
      } finally {
        await store.close();
      }
    });

    it('should isolate two stores with different schemas', async () => {
      await using container = await testSqlServer.database();

      const storeA = await SqlServerContextStore.create({
        pool: container.connectionString,
        schema: 'schema_a',
      });
      const storeB = await SqlServerContextStore.create({
        pool: container.connectionString,
        schema: 'schema_b',
      });

      try {
        await storeA.createChat({
          id: 'chat-iso',
          userId: 'user-1',
          title: 'Schema A Chat',
        });

        await storeB.createChat({
          id: 'chat-iso',
          userId: 'user-1',
          title: 'Schema B Chat',
        });

        const chatA = await storeA.getChat('chat-iso');
        const chatB = await storeB.getChat('chat-iso');

        assert.ok(chatA);
        assert.ok(chatB);
        assert.strictEqual(chatA.title, 'Schema A Chat');
        assert.strictEqual(chatB.title, 'Schema B Chat');
      } finally {
        await storeA.close();
        await storeB.close();
      }
    });

    it('should create schema in sys.schemas', async () => {
      await using container = await testSqlServer.database();

      const store = await SqlServerContextStore.create({
        pool: container.connectionString,
        schema: 'ddl_created_schema',
      });
      try {
        const pool = new sql.ConnectionPool(container.connectionString);
        await pool.connect();
        try {
          const result = await pool.request().query(`
              SELECT name FROM sys.schemas WHERE name = 'ddl_created_schema'
            `);
          assert.strictEqual(result.recordset.length, 1);
          assert.strictEqual(result.recordset[0].name, 'ddl_created_schema');
        } finally {
          await pool.close();
        }
      } finally {
        await store.close();
      }
    });

    it('should handle idempotent initialization', async () => {
      await using container = await testSqlServer.database();

      const first = await SqlServerContextStore.create({
        pool: container.connectionString,
        schema: 'idempotent_schema',
      });
      await first.close();
      // A second open runs the schema DDL again over the existing objects.
      const store = await SqlServerContextStore.create({
        pool: container.connectionString,
        schema: 'idempotent_schema',
      });
      try {
        const chat = await store.createChat({ id: 'c1', userId: 'u1' });
        assert.ok(chat);
      } finally {
        await store.close();
      }
    });

    it('creates a new schema while other stores create it at the same time', async () => {
      await using container = await testSqlServer.database();
      const schema = `open_${crypto.randomUUID().replaceAll('-', '_')}`;

      const results = await Promise.allSettled(
        Array.from({ length: 3 }, () =>
          SqlServerContextStore.create({
            pool: container.connectionString,
            schema,
          }),
        ),
      );
      const stores = results.flatMap((result) =>
        result.status === 'fulfilled' ? [result.value] : [],
      );
      try {
        assert.deepStrictEqual(
          results.map((result) =>
            result.status === 'fulfilled' ? 'opened' : result.reason.message,
          ),
          ['opened', 'opened', 'opened'],
        );
        await stores[0].createChat({ id: 'chat-new', userId: 'user-1' });
        assert.strictEqual(
          (await stores[2].getChat('chat-new'))?.id,
          'chat-new',
        );
      } finally {
        await Promise.all(stores.map((store) => store.close()));
      }
    });

    it('lets the next store open after an open fails on a caller-owned pool', async (t) => {
      await using container = await testSqlServer.database();
      const schema = `open_${crypto.randomUUID().replaceAll('-', '_')}`;
      const pool = await new sql.ConnectionPool(
        container.connectionString,
      ).connect();
      try {
        // Platform setup: a view where the DDL creates a table makes the open
        // fail partway; no store operation can produce that state.
        await pool.request().batch(`CREATE SCHEMA [${schema}]`);
        await pool
          .request()
          .batch(`CREATE VIEW [${schema}].[chats] AS SELECT 1 AS id`);
        await assert.rejects(
          SqlServerContextStore.create({ pool, schema }),
          /already an object named 'chats'/,
        );
        await pool.request().batch(`DROP VIEW [${schema}].[chats]`);

        const store = await untilAborted(
          SqlServerContextStore.create({
            pool: container.connectionString,
            schema,
          }),
          t.signal,
        );
        try {
          await store.createChat({ id: 'chat-after', userId: 'user-1' });
          assert.strictEqual(
            (await store.getChat('chat-after'))?.id,
            'chat-after',
          );
        } finally {
          await store.close();
        }
      } finally {
        await pool.close();
      }
    });
  });
});
