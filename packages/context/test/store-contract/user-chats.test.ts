import { describe, it } from '@zukhruf/testing/node';
import assert from 'node:assert';

import {
  ContextEngine,
  XmlRenderer,
  assistantText,
  user,
} from '@deepagents/context';

import { buildSandbox } from '../helpers/build-sandbox.ts';
import { storeCases } from './store-cases.ts';

const renderer = new XmlRenderer();

void describe.each(storeCases, (storeCase) =>
  describe(storeCase.name, () => {
    describe('User Chat Management', () => {
      describe('Chat Creation with userId', () => {
        it('should create chat associated with specific user via ContextEngine', async () => {
          await using opened = await storeCase.open();
          const { store } = opened;
          const engine = new ContextEngine({
            store,
            chatId: 'user-chat-1',
            userId: 'alice',
          });

          await engine.resolve({
            renderer,
            sandbox: await buildSandbox(),
          });

          const chat = await store.getChat('user-chat-1');
          assert.ok(chat);
          assert.strictEqual(chat.userId, 'alice');
        });

        it('should expose userId via chat metadata getter', async () => {
          await using opened = await storeCase.open();
          const { store } = opened;
          const engine = new ContextEngine({
            store,
            chatId: 'user-chat-2',
            userId: 'bob',
          });

          await engine.resolve({
            renderer,
            sandbox: await buildSandbox(),
          });

          const chatMeta = engine.chat;
          assert.ok(chatMeta);
          assert.strictEqual(chatMeta.userId, 'bob');
          assert.strictEqual(chatMeta.id, 'user-chat-2');
        });
      });

      describe('Security & Data Integrity', () => {
        it('should not return cross-user chats when filtering by userId', async () => {
          await using opened = await storeCase.open();
          const { store } = opened;
          await store.upsertChat({ id: 'sec-alice-1', userId: 'sec-alice' });
          await store.upsertChat({ id: 'sec-alice-2', userId: 'sec-alice' });
          await store.upsertChat({ id: 'sec-bob-1', userId: 'sec-bob' });
          await store.upsertChat({
            id: 'sec-charlie-1',
            userId: 'sec-charlie',
          });

          const aliceChats = await store.listChats({ userId: 'sec-alice' });

          assert.strictEqual(aliceChats.length, 2);
          for (const chat of aliceChats) {
            assert.strictEqual(chat.userId, 'sec-alice');
            assert.ok(
              !['sec-bob-1', 'sec-charlie-1'].includes(chat.id),
              `Should not include other users' chats, got: ${chat.id}`,
            );
          }
        });

        it('should preserve userId when getChat retrieves stored chat', async () => {
          await using opened = await storeCase.open();
          const { store } = opened;
          await store.upsertChat({
            id: 'preserve-test-chat',
            userId: 'specific-user-id-12345',
            title: 'Test',
          });

          const retrieved = await store.getChat('preserve-test-chat');
          assert.ok(retrieved);
          assert.strictEqual(retrieved.userId, 'specific-user-id-12345');
        });

        it(`should treat userId filtering as ${storeCase.userIdComparison}`, async () => {
          await using opened = await storeCase.open();
          const { store } = opened;
          await store.upsertChat({
            id: 'case-chat-lower',
            userId: 'case-alice',
          });
          await store.upsertChat({
            id: 'case-chat-upper',
            userId: 'case-Alice',
          });
          await store.upsertChat({
            id: 'case-chat-mixed',
            userId: 'case-ALICE',
          });

          if (storeCase.userIdComparison === 'case-sensitive') {
            const lowerChats = await store.listChats({ userId: 'case-alice' });
            const upperChats = await store.listChats({ userId: 'case-Alice' });
            const allCapsChats = await store.listChats({
              userId: 'case-ALICE',
            });

            assert.strictEqual(lowerChats.length, 1);
            assert.strictEqual(upperChats.length, 1);
            assert.strictEqual(allCapsChats.length, 1);
            assert.strictEqual(lowerChats[0].id, 'case-chat-lower');
            assert.strictEqual(upperChats[0].id, 'case-chat-upper');
            assert.strictEqual(allCapsChats[0].id, 'case-chat-mixed');
          } else {
            const chats = await store.listChats({ userId: 'case-alice' });
            assert.strictEqual(chats.length, 3);

            const upperChats = await store.listChats({ userId: 'CASE-ALICE' });
            assert.strictEqual(upperChats.length, 3);
          }
        });
      });

      describe('userId with Branching & Checkpoints', () => {
        it('should preserve userId through branching operations', async () => {
          await using opened = await storeCase.open();
          const { store } = opened;
          const engine = new ContextEngine({
            store,
            chatId: 'branch-user-chat',
            userId: 'branch-user',
          });

          engine.set(user('First message'));
          await engine.save();

          engine.set(assistantText('Response'));
          await engine.save();

          await engine.checkpoint('before-branch');

          engine.set(user('More messages'));
          await engine.save();

          await engine.restore('before-branch');

          const chat = await store.getChat('branch-user-chat');
          assert.ok(chat);
          assert.strictEqual(chat.userId, 'branch-user');

          assert.strictEqual(engine.chat?.userId, 'branch-user');
        });

        it('should preserve userId through checkpoint restore', async () => {
          await using opened = await storeCase.open();
          const { store } = opened;
          const engine = new ContextEngine({
            store,
            chatId: 'checkpoint-user-chat',
            userId: 'checkpoint-user',
          });

          engine.set(user('Message 1'));
          await engine.save();
          await engine.checkpoint('cp1');

          engine.set(user('Message 2'));
          await engine.save();

          await engine.restore('cp1');

          const chat = await store.getChat('checkpoint-user-chat');
          assert.ok(chat);
          assert.strictEqual(chat.userId, 'checkpoint-user');
        });
      });

      describe('userId with Search', () => {
        it('should return correct messageCount per user chat', async () => {
          await using opened = await storeCase.open();
          const { store } = opened;
          const aliceEngine = new ContextEngine({
            store,
            chatId: 'alice-count-chat',
            userId: 'alice-count',
          });
          aliceEngine.set(user('Msg 1'));
          aliceEngine.set(assistantText('Response 1'));
          aliceEngine.set(user('Msg 2'));
          await aliceEngine.save();

          const bobEngine = new ContextEngine({
            store,
            chatId: 'bob-count-chat',
            userId: 'bob-count',
          });
          bobEngine.set(user('Only message'));
          await bobEngine.save();

          const aliceChats = await store.listChats({ userId: 'alice-count' });
          const bobChats = await store.listChats({ userId: 'bob-count' });

          assert.strictEqual(aliceChats[0].messageCount, 3);
          assert.strictEqual(bobChats[0].messageCount, 1);
        });
      });

      describe('Edge Cases', () => {
        it('should return empty when offset exceeds total chats', async () => {
          await using opened = await storeCase.open();
          const { store } = opened;
          await store.upsertChat({
            id: 'only-offset-chat',
            userId: 'offset-user',
          });

          const result = await store.listChats({
            userId: 'offset-user',
            limit: 10,
            offset: 100,
          });
          assert.strictEqual(result.length, 0);
        });
      });

      describe('userId Immutability', () => {
        it('should not change userId when upserting existing chat', async () => {
          await using opened = await storeCase.open();
          const { store } = opened;
          await store.upsertChat({
            id: 'immutable-chat',
            userId: 'original-owner',
            title: 'Original',
          });

          await store.upsertChat({
            id: 'immutable-chat',
            userId: 'attacker-trying-to-hijack',
            title: 'Hijacked?',
          });

          const chat = await store.getChat('immutable-chat');
          assert.ok(chat);
          assert.strictEqual(
            chat.userId,
            'original-owner',
            'userId should not change after initial creation',
          );
          assert.strictEqual(chat.title, 'Original');
        });

        it('should reject a ContextEngine reconnecting with a different userId', async () => {
          await using opened = await storeCase.open();
          const { store } = opened;
          const engine1 = new ContextEngine({
            store,
            chatId: 'reconnect-chat',
            userId: 'original-user',
          });
          engine1.set(user('First message'));
          await engine1.save();

          const engine2 = new ContextEngine({
            store,
            chatId: 'reconnect-chat',
            userId: 'different-user',
          });
          const sandbox = await buildSandbox();
          await assert.rejects(
            () => engine2.resolve({ renderer, sandbox }),
            /belongs to user "original-user", not "different-user"/,
            'reconnecting with a different userId must be rejected, not silently allowed',
          );

          const storedChat = await store.getChat('reconnect-chat');
          assert.ok(storedChat);
          assert.strictEqual(
            storedChat.userId,
            'original-user',
            'Stored userId should not change when different engine connects',
          );
        });
      });

      describe('Concurrent Operations', () => {
        it('should handle concurrent chat creation for same user', async () => {
          await using opened = await storeCase.open();
          const { store } = opened;
          const createPromises = Array.from({ length: 10 }, (_, i) =>
            store.upsertChat({
              id: `concurrent-same-${i}`,
              userId: 'concurrent-same-user',
              title: `Chat ${i}`,
            }),
          );

          const results = await Promise.all(createPromises);

          assert.strictEqual(results.length, 10);
          for (const result of results) {
            assert.strictEqual(result.userId, 'concurrent-same-user');
          }

          const chats = await store.listChats({
            userId: 'concurrent-same-user',
          });
          assert.strictEqual(chats.length, 10);
        });

        it('should handle concurrent reads and writes', async () => {
          await using opened = await storeCase.open();
          const { store } = opened;
          await store.upsertChat({ id: 'rw-chat', userId: 'rw-user' });

          const operations = [
            store.getChat('rw-chat'),
            store.listChats({ userId: 'rw-user' }),
            store.upsertChat({ id: 'rw-chat-2', userId: 'rw-user' }),
            store.getChat('rw-chat'),
            store.listChats({ userId: 'rw-user' }),
            store.upsertChat({ id: 'rw-chat-3', userId: 'rw-user' }),
          ];

          const results = await Promise.all(operations);

          assert.ok(results[0]);
          assert.ok(Array.isArray(results[1]));
          assert.ok(results[2]);

          const finalChats = await store.listChats({ userId: 'rw-user' });
          assert.strictEqual(finalChats.length, 3);
        });
      });
    });

    describe('Message Upsert', () => {
      it('should update existing message with same ID', async () => {
        await using opened = await storeCase.open();
        const { store } = opened;
        await store.upsertChat({ id: 'upsert-chat-1', userId: 'user-1' });

        await store.addMessage({
          id: 'upsert-msg-1',
          chatId: 'upsert-chat-1',
          parentId: null,
          name: 'user',
          type: 'message',
          data: { text: 'Original content' },
          createdAt: 1000,
        });

        await store.addMessage({
          id: 'upsert-msg-2',
          chatId: 'upsert-chat-1',
          parentId: 'upsert-msg-1',
          name: 'assistant',
          type: 'message',
          data: { text: 'Response' },
          createdAt: 1500,
        });

        await store.addMessage({
          id: 'upsert-msg-1',
          chatId: 'upsert-chat-1',
          parentId: null,
          name: 'assistant',
          type: 'message',
          data: { text: 'Updated content' },
          createdAt: 2000,
        });

        const msg = await store.getMessage('upsert-msg-1');
        assert.ok(msg);

        assert.deepStrictEqual(msg.data, { text: 'Updated content' });
        assert.strictEqual(msg.name, 'assistant');
        assert.strictEqual(msg.parentId, null);
        assert.strictEqual(msg.createdAt, 1000);
      });

      it('should preserve original parentId on upsert', async () => {
        await using opened = await storeCase.open();
        const { store } = opened;
        await store.upsertChat({ id: 'upsert-parent-chat', userId: 'user-1' });

        await store.addMessage({
          id: 'upsert-parent-msg',
          chatId: 'upsert-parent-chat',
          parentId: null,
          name: 'user',
          data: 'Original',
          createdAt: 1000,
        });

        await store.addMessage({
          id: 'upsert-parent-msg',
          chatId: 'upsert-parent-chat',
          parentId: 'some-other-parent',
          name: 'user',
          data: 'Updated',
          createdAt: 1000,
        });

        const msg = await store.getMessage('upsert-parent-msg');
        assert.ok(msg);
        assert.strictEqual(msg.parentId, null);
        assert.strictEqual(msg.data, 'Updated');
      });

      it('should preserve original createdAt on upsert', async () => {
        await using opened = await storeCase.open();
        const { store } = opened;
        await store.upsertChat({ id: 'upsert-time-chat', userId: 'user-1' });

        await store.addMessage({
          id: 'upsert-time-msg',
          chatId: 'upsert-time-chat',
          parentId: null,
          name: 'user',
          data: 'Original',
          createdAt: 1000,
        });

        await store.addMessage({
          id: 'upsert-time-msg',
          chatId: 'upsert-time-chat',
          parentId: null,
          name: 'user',
          data: 'Updated',
          createdAt: 9999,
        });

        const msg = await store.getMessage('upsert-time-msg');
        assert.ok(msg);
        assert.strictEqual(msg.createdAt, 1000);
      });
    });
  }),
);
