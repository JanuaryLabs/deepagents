import { waitFor } from '@zukhruf/testing/async';
import { Postgres } from '@zukhruf/testing/postgres';
import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import pg from 'pg';

import { PostgresContextStore } from '@deepagents/context';

const testPostgres = new Postgres({ environment: process.env });

/**
 * Integration tests for PostgreSQL ContextStore.
 *
 * These tests require Docker to be installed and running.
 * Tests fail explicitly if Docker is not available.
 */
describe('PostgreSQL ContextStore Integration', () => {
  describe('Transactions', () => {
    it('rejects with the error that ended the transaction when its connection dies, not with the failed rollback', async (t) => {
      await using container = await testPostgres.database();
      const pool = container.pool({ application_name: 'store-under-test' });
      const blocker = new pg.Client({
        connectionString: container.connectionString,
      });
      await blocker.connect();
      try {
        const store = await PostgresContextStore.create({ pool });
        await store.createChat({ id: 'chat-tx', userId: 'user-1' });
        await blocker.query('BEGIN');
        await blocker.query(
          'SELECT 1 FROM "public"."chats" WHERE id = $1 FOR UPDATE',
          ['chat-tx'],
        );

        const update = store.updateChat('chat-tx', () => ({
          title: 'renamed',
        }));
        const waiting = await waitFor(
          async () => {
            const { rows } = await blocker.query<{ pid: number }>(
              `SELECT pid FROM pg_stat_activity
                WHERE application_name = 'store-under-test'
                  AND wait_event_type = 'Lock'`,
            );
            assert.strictEqual(rows.length, 1);
            return rows[0].pid;
          },
          { signal: t.signal },
        );
        await blocker.query('SELECT pg_terminate_backend($1)', [waiting]);

        await assert.rejects(update, { code: '57P01' });
      } finally {
        await blocker.end();
      }
    });
  });

  describe('Opening', () => {
    it('opens an existing schema while other stores open it at the same time', async () => {
      await using container = await testPostgres.database();
      const schema = `open_${randomUUID().replaceAll('-', '_')}`;
      const initial = await PostgresContextStore.create({
        pool: container.pool(),
        schema,
      });
      await initial.close();

      // Reopening an existing schema deadlocks only when the openers' DDL
      // overlaps, so six openers make the overlap dependable.
      const results = await Promise.allSettled(
        Array.from({ length: 6 }, () =>
          PostgresContextStore.create({
            pool: container.pool(),
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
            result.status === 'fulfilled' ? 'opened' : result.reason.code,
          ),
          Array.from({ length: 6 }, () => 'opened'),
        );
        await stores[0].createChat({ id: 'chat-open', userId: 'user-1' });
        assert.strictEqual(
          (await stores[5].getChat('chat-open'))?.id,
          'chat-open',
        );
      } finally {
        await Promise.all(stores.map((store) => store.close()));
      }
    });

    it('creates a new schema while other stores create it at the same time', async () => {
      await using container = await testPostgres.database();
      const schema = `open_${randomUUID().replaceAll('-', '_')}`;

      const results = await Promise.allSettled(
        Array.from({ length: 3 }, () =>
          PostgresContextStore.create({
            pool: container.pool(),
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
            result.status === 'fulfilled' ? 'opened' : result.reason.code,
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
  });

  // ==========================================================================
  // Message Operations
  // ==========================================================================

  describe('Message Operations', () => {
    it('serializes concurrent chat updaters from independent stores', async () => {
      await using container = await testPostgres.database();

      const first = await PostgresContextStore.create({
        pool: container.pool(),
      });
      const second = await PostgresContextStore.create({
        pool: container.pool(),
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
  // PostgreSQL-Specific Tests
  // ==========================================================================

  describe('PostgreSQL-Specific', () => {
    describe('JSONB Metadata', () => {
      it('should filter by string metadata value', async () => {
        await using container = await testPostgres.database();

        const store = await PostgresContextStore.create({
          pool: container.pool(),
        });
        try {
          await store.createChat({
            id: 'chat-meta-string',
            userId: 'user-meta-test',
            metadata: { category: 'support' },
          });

          await store.createChat({
            id: 'chat-meta-string-2',
            userId: 'user-meta-test',
            metadata: { category: 'sales' },
          });

          const results = await store.listChats({
            userId: 'user-meta-test',
            metadata: { key: 'category', value: 'support' },
          });

          assert.strictEqual(results.length, 1);
          assert.strictEqual(results[0].id, 'chat-meta-string');
        } finally {
          await store.close();
        }
      });

      it('should filter by boolean metadata value', async () => {
        await using container = await testPostgres.database();

        const store = await PostgresContextStore.create({
          pool: container.pool(),
        });
        try {
          await store.createChat({
            id: 'chat-meta-bool-true',
            userId: 'user-bool-test',
            metadata: { active: true },
          });

          await store.createChat({
            id: 'chat-meta-bool-false',
            userId: 'user-bool-test',
            metadata: { active: false },
          });

          const activeChats = await store.listChats({
            userId: 'user-bool-test',
            metadata: { key: 'active', value: true },
          });

          assert.strictEqual(activeChats.length, 1);
          assert.strictEqual(activeChats[0].id, 'chat-meta-bool-true');

          const inactiveChats = await store.listChats({
            userId: 'user-bool-test',
            metadata: { key: 'active', value: false },
          });

          assert.strictEqual(inactiveChats.length, 1);
          assert.strictEqual(inactiveChats[0].id, 'chat-meta-bool-false');
        } finally {
          await store.close();
        }
      });

      it('should filter by number metadata value', async () => {
        await using container = await testPostgres.database();

        const store = await PostgresContextStore.create({
          pool: container.pool(),
        });
        try {
          await store.createChat({
            id: 'chat-meta-num-1',
            userId: 'user-num-test',
            metadata: { priority: 1 },
          });

          await store.createChat({
            id: 'chat-meta-num-2',
            userId: 'user-num-test',
            metadata: { priority: 2 },
          });

          const results = await store.listChats({
            userId: 'user-num-test',
            metadata: { key: 'priority', value: 1 },
          });

          assert.strictEqual(results.length, 1);
          assert.strictEqual(results[0].id, 'chat-meta-num-1');
        } finally {
          await store.close();
        }
      });
    });
  });
});
