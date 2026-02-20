import assert from 'node:assert';
import { describe, it } from 'node:test';

import {
  ContextEngine,
  PostgresContextStore,
  assistantText,
  user,
} from '@deepagents/context';
import { withPostgresContainer } from '@deepagents/test';

describe('Full-Text Search', () => {
  describe('Search Operations', () => {
    it('should search messages by keyword', () =>
      withPostgresContainer(async (container) => {
        const store = new PostgresContextStore({
          pool: container.connectionString,
        });
        await store.initialize();
        try {
          await store.createChat({ id: 'chat-search', userId: 'user-1' });

          const branch = await store.getActiveBranch('chat-search');
          let lastMsgId: string | null = null;

          const messages = [
            { id: 'search-msg-1', name: 'user', data: 'Hello world' },
            {
              id: 'search-msg-2',
              name: 'assistant',
              data: 'Welcome to the application',
            },
            {
              id: 'search-msg-3',
              name: 'user',
              data: 'How do I configure settings?',
            },
            {
              id: 'search-msg-4',
              name: 'assistant',
              data: 'You can configure settings in the preferences menu',
            },
            { id: 'search-msg-5', name: 'user', data: 'Thanks for the help!' },
          ];

          for (const msg of messages) {
            await store.addMessage({
              id: msg.id,
              chatId: 'chat-search',
              parentId: lastMsgId,
              name: msg.name,
              data: msg.data,
              createdAt: Date.now(),
            });
            lastMsgId = msg.id;
          }

          await store.updateBranchHead(branch!.id, lastMsgId);

          const results = await store.searchMessages(
            'chat-search',
            'configure',
          );

          assert.ok(results.length > 0);
          assert.ok(
            results.some((r) =>
              JSON.stringify(r.message.data).includes('configure'),
            ),
          );
        } finally {
          await store.close();
        }
      }));

    it('should return ranked results with higher rank being more relevant', () =>
      withPostgresContainer(async (container) => {
        const store = new PostgresContextStore({
          pool: container.connectionString,
        });
        await store.initialize();
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

          const results = await store.searchMessages('chat-rank', 'settings');

          assert.ok(results.length > 0);

          for (let i = 1; i < results.length; i++) {
            assert.ok(results[i - 1].rank >= results[i].rank);
          }
        } finally {
          await store.close();
        }
      }));

    it('should return highlighted snippets', () =>
      withPostgresContainer(async (container) => {
        const store = new PostgresContextStore({
          pool: container.connectionString,
        });
        await store.initialize();
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

          const results = await store.searchMessages(
            'chat-snippet',
            'configure',
          );

          assert.ok(results.length > 0);
          assert.ok(results[0].snippet);
          assert.ok(
            results[0].snippet?.includes('<mark>') ||
              results[0].snippet?.includes('configure'),
          );
        } finally {
          await store.close();
        }
      }));

    it('should filter by roles', () =>
      withPostgresContainer(async (container) => {
        const store = new PostgresContextStore({
          pool: container.connectionString,
        });
        await store.initialize();
        try {
          await store.createChat({ id: 'chat-roles', userId: 'user-1' });

          await store.addMessage({
            id: 'role-msg-1',
            chatId: 'chat-roles',
            parentId: null,
            name: 'user',
            data: 'Hello from user',
            createdAt: Date.now(),
          });

          await store.addMessage({
            id: 'role-msg-2',
            chatId: 'chat-roles',
            parentId: 'role-msg-1',
            name: 'assistant',
            data: 'Welcome back!',
            createdAt: Date.now(),
          });

          const userResults = await store.searchMessages(
            'chat-roles',
            'Hello',
            { roles: ['user'] },
          );

          const assistantResults = await store.searchMessages(
            'chat-roles',
            'Welcome',
            { roles: ['assistant'] },
          );

          assert.ok(userResults.every((r) => r.message.name === 'user'));
          assert.ok(
            assistantResults.every((r) => r.message.name === 'assistant'),
          );
        } finally {
          await store.close();
        }
      }));

    it('should respect limit option', () =>
      withPostgresContainer(async (container) => {
        const store = new PostgresContextStore({
          pool: container.connectionString,
        });
        await store.initialize();
        try {
          await store.createChat({ id: 'chat-limit', userId: 'user-1' });

          for (let i = 0; i < 5; i++) {
            await store.addMessage({
              id: `limit-msg-${i}`,
              chatId: 'chat-limit',
              parentId: null,
              name: 'user',
              data: 'The quick brown fox',
              createdAt: Date.now() + i,
            });
          }

          const results = await store.searchMessages('chat-limit', 'quick', {
            limit: 2,
          });

          assert.ok(results.length <= 2);
        } finally {
          await store.close();
        }
      }));

    it('should return empty array for no matches', () =>
      withPostgresContainer(async (container) => {
        const store = new PostgresContextStore({
          pool: container.connectionString,
        });
        await store.initialize();
        try {
          await store.createChat({ id: 'chat-nomatch', userId: 'user-1' });

          await store.addMessage({
            id: 'nomatch-msg-1',
            chatId: 'chat-nomatch',
            parentId: null,
            name: 'user',
            data: 'Hello world',
            createdAt: Date.now(),
          });

          const results = await store.searchMessages(
            'chat-nomatch',
            'xyznonexistent',
          );

          assert.strictEqual(results.length, 0);
        } finally {
          await store.close();
        }
      }));
  });

  describe('Search Scoping', () => {
    it('should scope searchMessages to correct chat', async () => {
      await withPostgresContainer(async (container) => {
        const store = new PostgresContextStore({
          pool: container.connectionString,
        });
        await store.initialize();
        try {
          const aliceEngine = new ContextEngine({
            store,
            chatId: 'alice-search-chat',
            userId: 'alice-search',
          });
          aliceEngine.set(user('I love pizza and pasta'));
          await aliceEngine.save();

          const bobEngine = new ContextEngine({
            store,
            chatId: 'bob-search-chat',
            userId: 'bob-search',
          });
          bobEngine.set(user('I prefer sushi and ramen'));
          await bobEngine.save();

          const aliceResults = await store.searchMessages(
            'alice-search-chat',
            'pizza',
          );
          assert.strictEqual(aliceResults.length, 1);

          const wrongResults = await store.searchMessages(
            'alice-search-chat',
            'sushi',
          );
          assert.strictEqual(wrongResults.length, 0);
        } finally {
          await store.close();
        }
      });
    });
  });

  describe('FTS Cleanup', () => {
    it('should remove FTS entries when chat is deleted', () =>
      withPostgresContainer(async (container) => {
        const store = new PostgresContextStore({
          pool: container.connectionString,
        });
        await store.initialize();
        try {
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
        } finally {
          await store.close();
        }
      }));

    it('should not affect FTS entries of other chats', () =>
      withPostgresContainer(async (container) => {
        const store = new PostgresContextStore({
          pool: container.connectionString,
        });
        await store.initialize();
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
      }));

    it('should handle search after deletion (no stale results)', () =>
      withPostgresContainer(async (container) => {
        const store = new PostgresContextStore({
          pool: container.connectionString,
        });
        await store.initialize();
        try {
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
        } finally {
          await store.close();
        }
      }));
  });
});
