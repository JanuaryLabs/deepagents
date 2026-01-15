import assert from 'node:assert';
import { describe, it } from 'node:test';

import {
  ContextEngine,
  InMemoryContextStore,
  XmlRenderer,
  assistantText,
  user,
} from '../src/index.ts';

const renderer = new XmlRenderer();

describe('Delete Chat', () => {
  describe('Basic Deletion', () => {
    it('should delete an existing chat and return true', async () => {
      const store = new InMemoryContextStore();

      const engine = new ContextEngine({
        store,
        chatId: 'chat-to-delete',
        userId: 'alice',
      });
      await engine.resolve({ renderer });

      const result = await store.deleteChat('chat-to-delete');

      assert.strictEqual(result, true);
      const chat = await store.getChat('chat-to-delete');
      assert.strictEqual(chat, undefined);
    });

    it('should return false when deleting non-existent chat', async () => {
      const store = new InMemoryContextStore();

      const result = await store.deleteChat('non-existent-chat');

      assert.strictEqual(result, false);
    });

    it('should return false when deleting already-deleted chat', async () => {
      const store = new InMemoryContextStore();

      const engine = new ContextEngine({
        store,
        chatId: 'chat-double-delete',
        userId: 'alice',
      });
      await engine.resolve({ renderer });

      // First delete
      const firstResult = await store.deleteChat('chat-double-delete');
      assert.strictEqual(firstResult, true);

      // Second delete
      const secondResult = await store.deleteChat('chat-double-delete');
      assert.strictEqual(secondResult, false);
    });

    it('should not affect other chats when deleting one', async () => {
      const store = new InMemoryContextStore();

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
    it('should delete all messages when chat is deleted', async () => {
      const store = new InMemoryContextStore();

      const engine = new ContextEngine({
        store,
        chatId: 'chat-with-messages',
        userId: 'alice',
      });
      engine.set(user('Message 1'));
      engine.set(assistantText('Response 1'));
      engine.set(user('Message 2'));
      engine.set(assistantText('Response 2'));
      await engine.save();

      // Get branch to find message chain
      const branch = await store.getActiveBranch('chat-with-messages');
      assert.ok(branch?.headMessageId);

      // Verify messages exist before deletion
      const messagesBefore = await store.getMessageChain(branch.headMessageId);
      assert.strictEqual(messagesBefore.length, 4);

      // Delete the chat
      await store.deleteChat('chat-with-messages');

      // Verify messages are gone (getMessageChain returns empty for non-existent)
      const messagesAfter = await store.getMessageChain(branch.headMessageId);
      assert.strictEqual(messagesAfter.length, 0);
    });

    it('should delete all branches when chat is deleted', async () => {
      const store = new InMemoryContextStore();

      const engine = new ContextEngine({
        store,
        chatId: 'chat-with-branches',
        userId: 'alice',
      });
      engine.set(user('Message 1'));
      await engine.save();

      // Create checkpoint and restore to create a new branch
      await engine.checkpoint('before-branch');
      engine.set(user('Message on main'));
      await engine.save();

      await engine.restore('before-branch');
      engine.set(user('Message on new branch'));
      await engine.save();

      // Verify multiple branches exist
      const branchesBefore = await store.listBranches('chat-with-branches');
      assert.strictEqual(branchesBefore.length, 2);

      // Delete the chat
      await store.deleteChat('chat-with-branches');

      // Verify branches are gone
      const branchesAfter = await store.listBranches('chat-with-branches');
      assert.strictEqual(branchesAfter.length, 0);
    });

    it('should delete all checkpoints when chat is deleted', async () => {
      const store = new InMemoryContextStore();

      const engine = new ContextEngine({
        store,
        chatId: 'chat-with-checkpoints',
        userId: 'alice',
      });
      engine.set(user('Message 1'));
      await engine.save();
      await engine.checkpoint('cp-1');

      engine.set(user('Message 2'));
      await engine.save();
      await engine.checkpoint('cp-2');

      engine.set(user('Message 3'));
      await engine.save();
      await engine.checkpoint('cp-3');

      // Verify checkpoints exist
      const checkpointsBefore = await store.listCheckpoints(
        'chat-with-checkpoints',
      );
      assert.strictEqual(checkpointsBefore.length, 3);

      // Delete the chat
      await store.deleteChat('chat-with-checkpoints');

      // Verify checkpoints are gone
      const checkpointsAfter = await store.listCheckpoints(
        'chat-with-checkpoints',
      );
      assert.strictEqual(checkpointsAfter.length, 0);
    });

    it('should handle chat with multiple branches', async () => {
      const store = new InMemoryContextStore();

      const engine = new ContextEngine({
        store,
        chatId: 'multi-branch-chat',
        userId: 'alice',
      });

      // Create initial message
      engine.set(user('Initial message'));
      await engine.save();
      await engine.checkpoint('fork-point');

      // Create branch 1
      engine.set(user('Branch 1 message'));
      await engine.save();

      // Create branch 2
      await engine.restore('fork-point');
      engine.set(user('Branch 2 message'));
      await engine.save();

      // Create branch 3
      await engine.restore('fork-point');
      engine.set(user('Branch 3 message'));
      await engine.save();

      const branchesBefore = await store.listBranches('multi-branch-chat');
      assert.strictEqual(branchesBefore.length, 3);

      // Delete and verify all cleaned up
      const result = await store.deleteChat('multi-branch-chat');
      assert.strictEqual(result, true);

      const chat = await store.getChat('multi-branch-chat');
      assert.strictEqual(chat, undefined);

      const branchesAfter = await store.listBranches('multi-branch-chat');
      assert.strictEqual(branchesAfter.length, 0);
    });

    it('should handle chat with deep message chains', async () => {
      const store = new InMemoryContextStore();

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

  describe('User Authorization (userId validation)', () => {
    it('should delete chat when userId matches', async () => {
      const store = new InMemoryContextStore();

      const engine = new ContextEngine({
        store,
        chatId: 'alice-chat',
        userId: 'alice',
      });
      await engine.resolve({ renderer });

      const result = await store.deleteChat('alice-chat', { userId: 'alice' });

      assert.strictEqual(result, true);
      const chat = await store.getChat('alice-chat');
      assert.strictEqual(chat, undefined);
    });

    it('should return false when userId does not match (no deletion)', async () => {
      const store = new InMemoryContextStore();

      const engine = new ContextEngine({
        store,
        chatId: 'alice-only-chat',
        userId: 'alice',
      });
      await engine.resolve({ renderer });

      // Bob tries to delete Alice's chat
      const result = await store.deleteChat('alice-only-chat', {
        userId: 'bob',
      });

      assert.strictEqual(result, false);

      // Verify chat still exists
      const chat = await store.getChat('alice-only-chat');
      assert.ok(chat);
      assert.strictEqual(chat.userId, 'alice');
    });

    it('should delete any chat when userId is not provided (admin mode)', async () => {
      const store = new InMemoryContextStore();

      const engine = new ContextEngine({
        store,
        chatId: 'any-user-chat',
        userId: 'someuser',
      });
      await engine.resolve({ renderer });

      // Delete without userId (admin mode)
      const result = await store.deleteChat('any-user-chat');

      assert.strictEqual(result, true);
      const chat = await store.getChat('any-user-chat');
      assert.strictEqual(chat, undefined);
    });

    it('should not delete other users chats', async () => {
      const store = new InMemoryContextStore();

      // Create chats for Alice and Bob
      const aliceEngine = new ContextEngine({
        store,
        chatId: 'alice-private',
        userId: 'alice',
      });
      aliceEngine.set(user('Alice secret message'));
      await aliceEngine.save();

      const bobEngine = new ContextEngine({
        store,
        chatId: 'bob-private',
        userId: 'bob',
      });
      bobEngine.set(user('Bob secret message'));
      await bobEngine.save();

      // Alice tries to delete Bob's chat
      const result = await store.deleteChat('bob-private', { userId: 'alice' });
      assert.strictEqual(result, false);

      // Bob's chat should still exist
      const bobChat = await store.getChat('bob-private');
      assert.ok(bobChat);

      // Alice's chat should still exist too
      const aliceChat = await store.getChat('alice-private');
      assert.ok(aliceChat);
    });

    it('should handle case-sensitive userId comparison', async () => {
      const store = new InMemoryContextStore();

      const engine = new ContextEngine({
        store,
        chatId: 'case-sensitive-chat',
        userId: 'Alice',
      });
      await engine.resolve({ renderer });

      // Try with lowercase 'alice' - should fail
      const result1 = await store.deleteChat('case-sensitive-chat', {
        userId: 'alice',
      });
      assert.strictEqual(result1, false);

      // Try with uppercase 'ALICE' - should fail
      const result2 = await store.deleteChat('case-sensitive-chat', {
        userId: 'ALICE',
      });
      assert.strictEqual(result2, false);

      // Try with correct case 'Alice' - should succeed
      const result3 = await store.deleteChat('case-sensitive-chat', {
        userId: 'Alice',
      });
      assert.strictEqual(result3, true);
    });
  });

  describe('FTS Cleanup', () => {
    it('should remove FTS entries when chat is deleted', async () => {
      const store = new InMemoryContextStore();

      const engine = new ContextEngine({
        store,
        chatId: 'fts-chat',
        userId: 'alice',
      });
      engine.set(user('The quick brown fox jumps'));
      engine.set(assistantText('Over the lazy dog'));
      await engine.save();

      // Verify search works before deletion
      const resultsBefore = await store.searchMessages('fts-chat', 'fox');
      assert.strictEqual(resultsBefore.length, 1);

      // Delete the chat
      await store.deleteChat('fts-chat');

      // Verify search returns nothing after deletion
      const resultsAfter = await store.searchMessages('fts-chat', 'fox');
      assert.strictEqual(resultsAfter.length, 0);
    });

    it('should not affect FTS entries of other chats', async () => {
      const store = new InMemoryContextStore();

      // Create two chats with searchable content
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

      // Delete first chat
      await store.deleteChat('fts-chat-1');

      // Second chat's FTS should still work
      const results = await store.searchMessages('fts-chat-2', 'apple');
      assert.strictEqual(results.length, 1);
      // message.data is the full message object, snippet contains the matched text
      assert.ok(results[0].snippet?.includes('dragonfruit'));
    });

    it('should handle search after deletion (no stale results)', async () => {
      const store = new InMemoryContextStore();

      const engine = new ContextEngine({
        store,
        chatId: 'stale-fts-chat',
        userId: 'alice',
      });
      engine.set(user('Unique searchable content xyz123'));
      await engine.save();

      // Search before deletion
      const before = await store.searchMessages('stale-fts-chat', 'xyz123');
      assert.strictEqual(before.length, 1);

      // Delete
      await store.deleteChat('stale-fts-chat');

      // Search after - should not find anything
      const after = await store.searchMessages('stale-fts-chat', 'xyz123');
      assert.strictEqual(after.length, 0);
    });
  });

  describe('Transaction Safety', () => {
    it('should be atomic - complete deletion or nothing', async () => {
      const store = new InMemoryContextStore();

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
      const store = new InMemoryContextStore();

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
    it('should handle deleting chat with no messages', async () => {
      const store = new InMemoryContextStore();

      const engine = new ContextEngine({
        store,
        chatId: 'empty-chat',
        userId: 'alice',
      });
      await engine.resolve({ renderer }); // Initialize but don't add messages

      const result = await store.deleteChat('empty-chat');

      assert.strictEqual(result, true);
      const chat = await store.getChat('empty-chat');
      assert.strictEqual(chat, undefined);
    });

    it('should handle deleting chat with empty title', async () => {
      const store = new InMemoryContextStore();

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

    it('should handle chatId with special characters', async () => {
      const store = new InMemoryContextStore();
      const specialIds = [
        'chat-with-dashes',
        'chat_with_underscores',
        'chat.with.dots',
        'chat@with#special$chars',
        'chat/with/slashes',
        'uuid-550e8400-e29b-41d4-a716-446655440000',
      ];

      for (const chatId of specialIds) {
        await store.upsertChat({ id: chatId, userId: 'alice' });

        const result = await store.deleteChat(chatId);
        assert.strictEqual(result, true, `Failed for chatId: ${chatId}`);

        const chat = await store.getChat(chatId);
        assert.strictEqual(
          chat,
          undefined,
          `Chat not deleted for chatId: ${chatId}`,
        );
      }
    });

    it('should handle very long chatId', async () => {
      const store = new InMemoryContextStore();
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
      const store = new InMemoryContextStore();

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

    it('should handle concurrent deletion of same chat (one succeeds)', async () => {
      const store = new InMemoryContextStore();

      await store.upsertChat({ id: 'race-chat', userId: 'alice' });

      // Try to delete the same chat 5 times concurrently
      const deletePromises = Array.from({ length: 5 }, () =>
        store.deleteChat('race-chat'),
      );

      const results = await Promise.all(deletePromises);

      // Exactly one should succeed, rest should return false
      const successCount = results.filter((r) => r === true).length;
      const failCount = results.filter((r) => r === false).length;

      assert.strictEqual(successCount, 1, 'Exactly one delete should succeed');
      assert.strictEqual(
        failCount,
        4,
        'Other deletes should return false (already deleted)',
      );

      // Chat should be gone
      const chat = await store.getChat('race-chat');
      assert.strictEqual(chat, undefined);
    });

    it('should not affect concurrent reads of other chats', async () => {
      const store = new InMemoryContextStore();

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
      ];

      const results = await Promise.all(operations);

      // Deletes should succeed
      assert.strictEqual(results[0], true); // delete 0
      assert.strictEqual(results[1], true); // delete 1
      assert.strictEqual(results[5], true); // delete 4

      // Reads should work
      assert.ok(results[2]); // getChat 2
      assert.strictEqual((results[2] as { id: string }).id, 'reader-chat-2');
      assert.ok(results[3]); // getChat 3
      assert.strictEqual((results[3] as { id: string }).id, 'reader-chat-3');

      // Final state: only chats 2 and 3 should remain
      const finalChats = await store.listChats({ userId: 'alice' });
      assert.strictEqual(finalChats.length, 2);
      const ids = finalChats.map((c) => c.id).sort();
      assert.deepStrictEqual(ids, ['reader-chat-2', 'reader-chat-3']);
    });
  });
});
