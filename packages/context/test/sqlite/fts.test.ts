import assert from 'node:assert';
import { describe, it } from 'node:test';

import { ContextEngine, assistantText, user } from '@deepagents/context';

import { withSqliteContainer } from '../helpers/sqlite-container.ts';

describe('Full-Text Search', () => {
  describe('FTS Cleanup', () => {
    it('should remove FTS entries when chat is deleted', async () => {
      await withSqliteContainer(async (store) => {
        const engine = new ContextEngine({
          store,
          chatId: 'fts-chat',
          userId: 'alice',
        });
        engine.set(user('The quick brown fox jumps'));
        engine.set(assistantText('Over the lazy dog'));
        await engine.save();

        const resultsBefore = await store.searchMessages('fts-chat', 'fox');
        assert.strictEqual(resultsBefore.length, 1);

        await store.deleteChat('fts-chat');

        const resultsAfter = await store.searchMessages('fts-chat', 'fox');
        assert.strictEqual(resultsAfter.length, 0);
      });
    });

    it('should not affect FTS entries of other chats', async () => {
      await withSqliteContainer(async (store) => {
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
        assert.ok(results[0].snippet?.includes('dragonfruit'));
      });
    });

    it('should handle search after deletion (no stale results)', async () => {
      await withSqliteContainer(async (store) => {
        const engine = new ContextEngine({
          store,
          chatId: 'stale-fts-chat',
          userId: 'alice',
        });
        engine.set(user('Unique searchable content xyz123'));
        await engine.save();

        const before = await store.searchMessages('stale-fts-chat', 'xyz123');
        assert.strictEqual(before.length, 1);

        await store.deleteChat('stale-fts-chat');

        const after = await store.searchMessages('stale-fts-chat', 'xyz123');
        assert.strictEqual(after.length, 0);
      });
    });
  });

  describe('Search Scoping', () => {
    it('should scope searchMessages to the correct chat', async () => {
      await withSqliteContainer(async (store) => {
        const aliceEngine = new ContextEngine({
          store,
          chatId: 'alice-search',
          userId: 'alice',
        });
        aliceEngine.set(user('I love pizza and pasta'));
        await aliceEngine.save();

        const bobEngine = new ContextEngine({
          store,
          chatId: 'bob-search',
          userId: 'bob',
        });
        bobEngine.set(user('I prefer sushi and ramen'));
        await bobEngine.save();

        const aliceResults = await store.searchMessages(
          'alice-search',
          'pizza',
        );
        assert.strictEqual(aliceResults.length, 1);

        const wrongResults = await store.searchMessages(
          'alice-search',
          'sushi',
        );
        assert.strictEqual(wrongResults.length, 0);
      });
    });
  });

  describe('FTS Index Updates', () => {
    it('should update FTS index on upsert', async () => {
      await withSqliteContainer(async (store) => {
        await store.upsertChat({ id: 'chat-1', userId: 'user-1' });

        await store.addMessage({
          id: 'msg-1',
          chatId: 'chat-1',
          parentId: null,
          name: 'user',
          type: 'message',
          data: 'original searchable content',
          createdAt: 1000,
        });

        let results = await store.searchMessages('chat-1', 'original');
        assert.strictEqual(results.length, 1);

        await store.addMessage({
          id: 'msg-1',
          chatId: 'chat-1',
          parentId: null,
          name: 'user',
          type: 'message',
          data: 'updated searchable content',
          createdAt: 1000,
        });

        results = await store.searchMessages('chat-1', 'original');
        assert.strictEqual(results.length, 0);

        results = await store.searchMessages('chat-1', 'updated');
        assert.strictEqual(results.length, 1);
      });
    });
  });
});
