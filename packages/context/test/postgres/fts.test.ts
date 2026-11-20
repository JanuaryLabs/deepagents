import { Postgres } from '@zukhruf/testing/postgres';
import assert from 'node:assert';
import { describe, it } from 'node:test';

import { ContextEngine, PostgresContextStore, user } from '@deepagents/context';

const testPostgres = new Postgres({ environment: process.env });

describe('Full-Text Search', () => {
  describe('FTS Cleanup', () => {
    it('should not affect FTS entries of other chats', async () => {
      await using container = await testPostgres.database();

      const store = await PostgresContextStore.create({
        pool: container.pool(),
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

        await store.deleteChat('fts-chat-1');

        const results = await store.searchMessages('fts-chat-2', 'apple');
        assert.strictEqual(results.length, 1);
      } finally {
        await store.close();
      }
    });
  });
});
