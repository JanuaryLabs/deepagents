import { Sqlite } from '@zukhruf/testing/sqlite';
import assert from 'node:assert';
import { describe, it } from 'node:test';

import {
  ContextEngine,
  SearchQuerySyntaxError,
  SqliteContextStore,
  assistantText,
  reminder,
  user,
} from '@deepagents/context';

const sqlite = new Sqlite();

describe('Full-Text Search', () => {
  describe('Search Query Syntax', () => {
    it("throws SearchQuerySyntaxError with SQLite's error as the cause when a query is not valid FTS5 syntax", async () => {
      await using database = await sqlite.database();
      const store = new SqliteContextStore(database.connection);
      const engine = new ContextEngine({
        store,
        chatId: 'syntax-chat',
        userId: 'alice',
      });
      engine.set(user('A well-known fix: now'));
      await engine.save();

      for (const [query, cause] of [
        ['well-known', 'no such column: known'],
        ['fix: now', 'no such column: fix'],
      ]) {
        const error = await store.searchMessages('syntax-chat', query).then(
          () => assert.fail(`expected ${query} to be rejected`),
          (rejection: unknown) => rejection,
        );
        assert.ok(error instanceof SearchQuerySyntaxError);
        assert.match(error.message, /not valid FTS5 syntax.*"well-known"/);
        assert.ok(error.cause instanceof Error);
        assert.strictEqual(error.cause.message, cause);
        assert.ok('errcode' in error.cause);
        assert.strictEqual(error.cause.errcode, 1);
      }
    });

    it('finds messages with a quoted phrase and with an AND query', async () => {
      await using database = await sqlite.database();
      const store = new SqliteContextStore(database.connection);
      const engine = new ContextEngine({
        store,
        chatId: 'syntax-chat',
        userId: 'alice',
      });
      engine.set(user('A well-known way to learn programming'));
      await engine.save();

      const phrase = await store.searchMessages('syntax-chat', '"well-known"');
      const and = await store.searchMessages(
        'syntax-chat',
        'learn AND programming',
      );

      assert.strictEqual(phrase.length, 1);
      assert.strictEqual(and.length, 1);
    });
  });

  describe('FTS Cleanup', () => {
    it('should remove FTS entries when chat is deleted', async () => {
      await using database = await sqlite.database();
      const store = new SqliteContextStore(database.connection);
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

    it('should not affect FTS entries of other chats', async () => {
      await using database = await sqlite.database();
      const store = new SqliteContextStore(database.connection);
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

    it('should handle search after deletion (no stale results)', async () => {
      await using database = await sqlite.database();
      const store = new SqliteContextStore(database.connection);
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

  describe('Search Scoping', () => {
    it('should scope searchMessages to the correct chat', async () => {
      await using database = await sqlite.database();
      const store = new SqliteContextStore(database.connection);
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

      const aliceResults = await store.searchMessages('alice-search', 'pizza');
      assert.strictEqual(aliceResults.length, 1);

      const wrongResults = await store.searchMessages('alice-search', 'sushi');
      assert.strictEqual(wrongResults.length, 0);
    });
  });

  describe('FTS Index Updates', () => {
    it('should update FTS index on upsert', async () => {
      await using database = await sqlite.database();
      const store = new SqliteContextStore(database.connection);
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

  describe('Reminder Searchability', () => {
    it('indexes reminder text in FTS', async () => {
      await using database = await sqlite.database();
      const store = new SqliteContextStore(database.connection);
      const engine = new ContextEngine({
        store,
        chatId: 'fts-reminder-chat',
        userId: 'alice',
      });

      engine.set(
        reminder('remindersearchabletoken92743'),
        user('User visible message'),
      );
      await engine.save();

      const results = await store.searchMessages(
        'fts-reminder-chat',
        'remindersearchabletoken92743',
      );
      assert.strictEqual(results.length, 1);
    });
  });
});
