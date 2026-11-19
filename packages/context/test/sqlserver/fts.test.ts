import { SQL_SERVER_FULL_IMAGE, SqlServer } from '@zukhruf/testing/sqlserver';
import assert from 'node:assert';
import { describe, it } from 'node:test';

import {
  ContextEngine,
  SqlServerContextStore,
  user,
} from '@deepagents/context';

import { waitForFtsReady } from './wait-for-fts-ready.ts';

const testSqlServer = new SqlServer({
  environment: process.env,
  image: SQL_SERVER_FULL_IMAGE,
});

/**
 * SQL Server Full-Text Search tests.
 *
 * Note: SQL Server FTS uses CONTAINSTABLE which requires the FTS index
 * to be populated asynchronously. Tests include appropriate delays.
 */
describe('Full-Text Search', () => {
  describe('FTS Cleanup', () => {
    it('should not affect FTS entries of other chats', async () => {
      await using container = await testSqlServer.database();

      const store = await SqlServerContextStore.create({
        pool: container.connectionString,
      });
      try {
        const engine1 = new ContextEngine({
          store,
          chatId: 'fts-chat-1',
          userId: 'alice',
        });
        engine1.set(user('Apple banana cherry'));
        await engine1.save();

        const engine2 = new ContextEngine({
          store,
          chatId: 'fts-chat-2',
          userId: 'alice',
        });
        engine2.set(user('Apple dragonfruit elderberry'));
        await engine2.save();

        // Wait for full-text index to populate (SQL Server FTS is async)
        await waitForFtsReady(container.connectionString);

        await store.deleteChat('fts-chat-1');

        const results = await store.searchMessages('fts-chat-2', 'apple');
        assert.strictEqual(results.length, 1);
      } finally {
        await store.close();
      }
    });
  });
});
