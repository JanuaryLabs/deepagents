import { describe, it } from '@zukhruf/parameterized-test';
import { Sqlite } from '@zukhruf/testing/sqlite';
import assert from 'node:assert';

import {
  ContextEngine,
  SqliteContextStore,
  assistantText,
  user,
} from '@deepagents/context';

const sqlite = new Sqlite();

describe('Delete Chat', () => {
  describe('Basic Deletion', () => {
    it('should not affect other chats when deleting one', async () => {
      await using database = await sqlite.database();
      const store = new SqliteContextStore(database.connection);
      // Create two chats
      const engine1 = new ContextEngine({
        store,
        chatId: 'chat-1',
        userId: 'alice',
      });
      engine1.set(user('Hello from chat 1'));
      await engine1.save();

      const engine2 = new ContextEngine({
        store,
        chatId: 'chat-2',
        userId: 'alice',
      });
      engine2.set(user('Hello from chat 2'));
      await engine2.save();

      // Delete chat-1
      await store.deleteChat('chat-1');

      // Verify chat-2 still exists with its data
      const chat2 = await store.getChat('chat-2');
      assert.ok(chat2);
      assert.strictEqual(chat2.id, 'chat-2');

      const chats = await store.listChats({ userId: 'alice' });
      assert.strictEqual(chats.length, 1);
      assert.strictEqual(chats[0].id, 'chat-2');
      assert.strictEqual(chats[0].messageCount, 1);
    });
  });

  describe('Cascading Deletes', () => {
    it('should handle chat with deep message chains', async () => {
      await using database = await sqlite.database();
      const store = new SqliteContextStore(database.connection);
      const engine = new ContextEngine({
        store,
        chatId: 'deep-chain-chat',
        userId: 'alice',
      });

      // Create 50 messages
      for (let i = 0; i < 25; i++) {
        engine.set(user(`User message ${i}`));
        engine.set(assistantText(`Assistant response ${i}`));
      }
      await engine.save();

      const chatBefore = await store.listChats({ userId: 'alice' });
      assert.strictEqual(chatBefore[0].messageCount, 50);

      // Delete and verify
      const result = await store.deleteChat('deep-chain-chat');
      assert.strictEqual(result, true);

      const chatAfter = await store.getChat('deep-chain-chat');
      assert.strictEqual(chatAfter, undefined);
    });
  });

  describe('Transaction Safety', () => {
    it('should be atomic - complete deletion or nothing', async () => {
      await using database = await sqlite.database();
      const store = new SqliteContextStore(database.connection);
      const engine = new ContextEngine({
        store,
        chatId: 'atomic-chat',
        userId: 'alice',
      });
      engine.set(user('Message 1'));
      engine.set(assistantText('Response 1'));
      await engine.save();
      await engine.checkpoint('cp1');

      // Successful deletion should clean everything
      const result = await store.deleteChat('atomic-chat');
      assert.strictEqual(result, true);

      // All related data should be gone
      const chat = await store.getChat('atomic-chat');
      const branches = await store.listBranches('atomic-chat');
      const checkpoints = await store.listCheckpoints('atomic-chat');

      assert.strictEqual(chat, undefined);
      assert.strictEqual(branches.length, 0);
      assert.strictEqual(checkpoints.length, 0);
    });

    it('should handle deletion of chat with many messages', async () => {
      await using database = await sqlite.database();
      const store = new SqliteContextStore(database.connection);
      const engine = new ContextEngine({
        store,
        chatId: 'large-chat',
        userId: 'alice',
      });

      // Create 100 messages
      for (let i = 0; i < 50; i++) {
        engine.set(user(`User message number ${i} with some content`));
        engine.set(assistantText(`Assistant response number ${i}`));
      }
      await engine.save();

      // Verify size before deletion
      const chatsBefore = await store.listChats({ userId: 'alice' });
      assert.strictEqual(chatsBefore[0].messageCount, 100);

      // Delete should succeed
      const result = await store.deleteChat('large-chat');
      assert.strictEqual(result, true);

      // Everything should be cleaned up
      const chatsAfter = await store.listChats({ userId: 'alice' });
      assert.strictEqual(chatsAfter.length, 0);
    });
  });

  describe('Edge Cases', () => {
    it('should handle deleting chat with empty title', async () => {
      await using database = await sqlite.database();
      const store = new SqliteContextStore(database.connection);
      await store.upsertChat({
        id: 'no-title-chat',
        userId: 'alice',
        title: '',
      });

      const result = await store.deleteChat('no-title-chat');

      assert.strictEqual(result, true);
      const chat = await store.getChat('no-title-chat');
      assert.strictEqual(chat, undefined);
    });

    void it.each(
      [
        'chat-with-dashes',
        'chat_with_underscores',
        'chat.with.dots',
        'chat@with#special$chars',
        'chat/with/slashes',
        'uuid-550e8400-e29b-41d4-a716-446655440000',
      ],
      (chatId) =>
        it(`should handle the chatId ${chatId} with special characters`, async () => {
          await using database = await sqlite.database();
          const store = new SqliteContextStore(database.connection);
          await store.upsertChat({ id: chatId, userId: 'alice' });

          const result = await store.deleteChat(chatId);
          assert.strictEqual(result, true, `Failed for chatId: ${chatId}`);

          const chat = await store.getChat(chatId);
          assert.strictEqual(
            chat,
            undefined,
            `Chat not deleted for chatId: ${chatId}`,
          );
        }),
    );

    it('should handle very long chatId', async () => {
      await using database = await sqlite.database();
      const store = new SqliteContextStore(database.connection);
      const longChatId = 'c'.repeat(500);

      await store.upsertChat({ id: longChatId, userId: 'alice' });

      const result = await store.deleteChat(longChatId);

      assert.strictEqual(result, true);
      const chat = await store.getChat(longChatId);
      assert.strictEqual(chat, undefined);
    });
  });

  describe('Concurrent Operations', () => {
    it('should handle concurrent deletion of different chats', async () => {
      await using database = await sqlite.database();
      const store = new SqliteContextStore(database.connection);
      // Create 10 chats
      for (let i = 0; i < 10; i++) {
        await store.upsertChat({ id: `concurrent-${i}`, userId: 'alice' });
      }

      // Delete all concurrently
      const deletePromises = Array.from({ length: 10 }, (_, i) =>
        store.deleteChat(`concurrent-${i}`),
      );

      const results = await Promise.all(deletePromises);

      // All should succeed
      assert.ok(results.every((r) => r === true));

      // All should be gone
      const chats = await store.listChats({ userId: 'alice' });
      assert.strictEqual(chats.length, 0);
    });

    it('should not affect concurrent reads of other chats', async () => {
      await using database = await sqlite.database();
      const store = new SqliteContextStore(database.connection);
      // Create chats
      for (let i = 0; i < 5; i++) {
        const engine = new ContextEngine({
          store,
          chatId: `reader-chat-${i}`,
          userId: 'alice',
        });
        engine.set(user(`Message for chat ${i}`));
        await engine.save();
      }

      // Concurrently delete some and read others
      const operations = [
        store.deleteChat('reader-chat-0'),
        store.deleteChat('reader-chat-1'),
        store.getChat('reader-chat-2'),
        store.getChat('reader-chat-3'),
        store.listChats({ userId: 'alice' }),
        store.deleteChat('reader-chat-4'),
      ] as const;

      const results = await Promise.all(operations);

      // Deletes should succeed
      assert.strictEqual(results[0], true); // delete 0
      assert.strictEqual(results[1], true); // delete 1
      assert.strictEqual(results[5], true); // delete 4

      // Reads should work
      assert.ok(results[2]); // getChat 2
      assert.strictEqual(results[2].id, 'reader-chat-2');
      assert.ok(results[3]); // getChat 3
      assert.strictEqual(results[3].id, 'reader-chat-3');

      // Final state: only chats 2 and 3 should remain
      const finalChats = await store.listChats({ userId: 'alice' });
      assert.strictEqual(finalChats.length, 2);
      const ids = finalChats.map((c) => c.id).sort();
      assert.deepStrictEqual(ids, ['reader-chat-2', 'reader-chat-3']);
    });
  });
});
