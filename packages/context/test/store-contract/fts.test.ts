import { describe, it } from '@zukhruf/parameterized-test';
import assert from 'node:assert';

import { ContextEngine, assistantText, user } from '@deepagents/context';

import { storeCases } from './store-cases.ts';

void describe.each(storeCases, (storeCase) =>
  describe(storeCase.name, () => {
    describe('Full-Text Search', () => {
      describe('Search Operations', () => {
        it('should search messages by keyword', async () => {
          await using opened = await storeCase.open();
          const { store } = opened;
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
            {
              id: 'search-msg-5',
              name: 'user',
              data: 'Thanks for the help!',
            },
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

          await store.updateBranchHead(
            branch!.id,
            lastMsgId,
            branch!.headMessageId,
          );
          await opened.searchable();

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
        });

        it(`should return ranked results with ${storeCase.searchRankOrder === 'descending' ? 'higher' : 'lower'} rank being more relevant`, async () => {
          await using opened = await storeCase.open();
          const { store } = opened;
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
          await opened.searchable();

          const results = await store.searchMessages('chat-rank', 'settings');

          assert.ok(results.length > 0);

          for (let i = 1; i < results.length; i++) {
            if (storeCase.searchRankOrder === 'descending') {
              assert.ok(results[i - 1].rank >= results[i].rank);
            } else {
              assert.ok(results[i - 1].rank <= results[i].rank);
            }
          }
        });

        it('should return highlighted snippets', async () => {
          await using opened = await storeCase.open();
          const { store } = opened;
          await store.createChat({ id: 'chat-snippet', userId: 'user-1' });

          await store.addMessage({
            id: 'snippet-msg-1',
            chatId: 'chat-snippet',
            parentId: null,
            name: 'user',
            data: 'How do I configure my settings?',
            createdAt: Date.now(),
          });
          await opened.searchable();

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
        });

        it('should filter by roles', async () => {
          await using opened = await storeCase.open();
          const { store } = opened;
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
          await opened.searchable();

          const userResults = await store.searchMessages(
            'chat-roles',
            'Hello',
            {
              roles: ['user'],
            },
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
        });

        it('should respect limit option', async () => {
          await using opened = await storeCase.open();
          const { store } = opened;
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
          await opened.searchable();

          const results = await store.searchMessages('chat-limit', 'quick', {
            limit: 2,
          });

          assert.ok(results.length <= 2);
        });

        it('should return empty array for no matches', async () => {
          await using opened = await storeCase.open();
          const { store } = opened;
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
        });
      });

      describe('Search Scoping', () => {
        it('should scope searchMessages to correct chat', async () => {
          await using opened = await storeCase.open();
          const { store } = opened;
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
          await opened.searchable();

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
        });
      });

      describe('FTS Cleanup', () => {
        it('should remove FTS entries when chat is deleted', async () => {
          await using opened = await storeCase.open();
          const { store } = opened;
          const engine = new ContextEngine({
            store,
            chatId: 'fts-chat',
            userId: 'alice',
          });
          engine.set(user('The quick brown fox jumps'));
          engine.set(assistantText('Over the lazy dog'));
          await engine.save();
          await opened.searchable();

          const resultsBefore = await store.searchMessages('fts-chat', 'fox');
          assert.strictEqual(resultsBefore.length, 1);

          await store.deleteChat('fts-chat');

          const resultsAfter = await store.searchMessages('fts-chat', 'fox');
          assert.strictEqual(resultsAfter.length, 0);
        });

        it('should handle search after deletion (no stale results)', async () => {
          await using opened = await storeCase.open();
          const { store } = opened;
          const engine = new ContextEngine({
            store,
            chatId: 'stale-fts-chat',
            userId: 'alice',
          });
          engine.set(user('Unique searchable content xyz123'));
          await engine.save();
          await opened.searchable();

          const before = await store.searchMessages('stale-fts-chat', 'xyz123');
          assert.strictEqual(before.length, 1);

          await store.deleteChat('stale-fts-chat');

          const after = await store.searchMessages('stale-fts-chat', 'xyz123');
          assert.strictEqual(after.length, 0);
        });
      });
    });
  }),
);
