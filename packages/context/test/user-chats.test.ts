import assert from 'node:assert';
import { describe, it } from 'node:test';

import {
  ContextEngine,
  InMemoryContextStore,
  XmlRenderer,
  assistantText,
  user,
} from '@deepagents/context';

const renderer = new XmlRenderer();

describe('Metadata Filtering', () => {
  describe('listChats with metadata filter', () => {
    it('should filter chats by metadata string field', async () => {
      const store = new InMemoryContextStore();

      // Create chats with different metadata
      await store.upsertChat({
        id: 'chat-1',
        userId: 'user-1',
        metadata: { projectId: 'project-a', status: 'active' },
      });
      await store.upsertChat({
        id: 'chat-2',
        userId: 'user-1',
        metadata: { projectId: 'project-b', status: 'active' },
      });
      await store.upsertChat({
        id: 'chat-3',
        userId: 'user-1',
        metadata: { projectId: 'project-a', status: 'archived' },
      });

      // Filter by projectId
      const projectAChats = await store.listChats({
        metadata: { key: 'projectId', value: 'project-a' },
      });

      assert.strictEqual(projectAChats.length, 2);
      assert.ok(
        projectAChats.every((c) => c.metadata?.projectId === 'project-a'),
      );
    });

    it('should filter chats by metadata number field', async () => {
      const store = new InMemoryContextStore();

      await store.upsertChat({
        id: 'chat-1',
        userId: 'user-1',
        metadata: { priority: 1 },
      });
      await store.upsertChat({
        id: 'chat-2',
        userId: 'user-1',
        metadata: { priority: 2 },
      });
      await store.upsertChat({
        id: 'chat-3',
        userId: 'user-1',
        metadata: { priority: 1 },
      });

      const priority1Chats = await store.listChats({
        metadata: { key: 'priority', value: 1 },
      });

      assert.strictEqual(priority1Chats.length, 2);
      assert.ok(priority1Chats.every((c) => c.metadata?.priority === 1));
    });

    it('should filter chats by metadata boolean field', async () => {
      const store = new InMemoryContextStore();

      await store.upsertChat({
        id: 'chat-1',
        userId: 'user-1',
        metadata: { isArchived: true },
      });
      await store.upsertChat({
        id: 'chat-2',
        userId: 'user-1',
        metadata: { isArchived: false },
      });
      await store.upsertChat({
        id: 'chat-3',
        userId: 'user-1',
        metadata: { isArchived: true },
      });

      const archivedChats = await store.listChats({
        metadata: { key: 'isArchived', value: true },
      });

      assert.strictEqual(archivedChats.length, 2);
    });

    it('should combine userId and metadata filters', async () => {
      const store = new InMemoryContextStore();

      await store.upsertChat({
        id: 'alice-1',
        userId: 'alice',
        metadata: { projectId: 'shared' },
      });
      await store.upsertChat({
        id: 'alice-2',
        userId: 'alice',
        metadata: { projectId: 'personal' },
      });
      await store.upsertChat({
        id: 'bob-1',
        userId: 'bob',
        metadata: { projectId: 'shared' },
      });

      // Filter by both userId and metadata
      const aliceSharedChats = await store.listChats({
        userId: 'alice',
        metadata: { key: 'projectId', value: 'shared' },
      });

      assert.strictEqual(aliceSharedChats.length, 1);
      assert.strictEqual(aliceSharedChats[0].id, 'alice-1');
      assert.strictEqual(aliceSharedChats[0].userId, 'alice');
    });

    it('should return empty array when no chats match metadata filter', async () => {
      const store = new InMemoryContextStore();

      await store.upsertChat({
        id: 'chat-1',
        userId: 'user-1',
        metadata: { projectId: 'existing' },
      });

      const result = await store.listChats({
        metadata: { key: 'projectId', value: 'nonexistent' },
      });

      assert.strictEqual(result.length, 0);
    });

    it('should return empty array when filtering by non-existent metadata key', async () => {
      const store = new InMemoryContextStore();

      await store.upsertChat({
        id: 'chat-1',
        userId: 'user-1',
        metadata: { projectId: 'test' },
      });

      const result = await store.listChats({
        metadata: { key: 'nonExistentKey', value: 'value' },
      });

      assert.strictEqual(result.length, 0);
    });

    it('should include metadata in ChatInfo response', async () => {
      const store = new InMemoryContextStore();

      await store.upsertChat({
        id: 'chat-1',
        userId: 'user-1',
        metadata: { projectId: 'test', status: 'active', count: 42 },
      });

      const chats = await store.listChats();

      assert.strictEqual(chats.length, 1);
      assert.deepStrictEqual(chats[0].metadata, {
        projectId: 'test',
        status: 'active',
        count: 42,
      });
    });

    it('should handle chats without metadata when filtering', async () => {
      const store = new InMemoryContextStore();

      await store.upsertChat({
        id: 'chat-with-metadata',
        userId: 'user-1',
        metadata: { projectId: 'test' },
      });
      await store.upsertChat({
        id: 'chat-without-metadata',
        userId: 'user-1',
        // no metadata
      });

      const result = await store.listChats({
        metadata: { key: 'projectId', value: 'test' },
      });

      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].id, 'chat-with-metadata');
    });

    it('should support pagination with metadata filter', async () => {
      const store = new InMemoryContextStore();

      // Create 5 chats with same metadata
      for (let i = 0; i < 5; i++) {
        await store.upsertChat({
          id: `chat-${i}`,
          userId: 'user-1',
          metadata: { category: 'important' },
        });
      }
      // Create 3 chats with different metadata
      for (let i = 0; i < 3; i++) {
        await store.upsertChat({
          id: `other-${i}`,
          userId: 'user-1',
          metadata: { category: 'other' },
        });
      }

      const page1 = await store.listChats({
        metadata: { key: 'category', value: 'important' },
        limit: 2,
        offset: 0,
      });

      const page2 = await store.listChats({
        metadata: { key: 'category', value: 'important' },
        limit: 2,
        offset: 2,
      });

      assert.strictEqual(page1.length, 2);
      assert.strictEqual(page2.length, 2);

      // No overlap
      const page1Ids = page1.map((c) => c.id);
      const page2Ids = page2.map((c) => c.id);
      assert.ok(page1Ids.every((id) => !page2Ids.includes(id)));
    });
  });
});

describe('User Chat Management', () => {
  describe('Chat Creation with userId', () => {
    it('should create a chat associated with a specific user', async () => {
      const store = new InMemoryContextStore();

      const engine = new ContextEngine({
        store,
        chatId: 'chat-1',
        userId: 'alice',
      });

      // Trigger initialization
      await engine.resolve({ renderer });

      const chat = await store.getChat('chat-1');
      assert.ok(chat);
      assert.strictEqual(chat.userId, 'alice');
    });

    it('should expose userId via chat metadata getter', async () => {
      const store = new InMemoryContextStore();

      const engine = new ContextEngine({
        store,
        chatId: 'chat-2',
        userId: 'bob',
      });

      await engine.resolve({ renderer });

      const chatMeta = engine.chat;
      assert.ok(chatMeta);
      assert.strictEqual(chatMeta.userId, 'bob');
      assert.strictEqual(chatMeta.id, 'chat-2');
    });

    it('should require userId when creating ContextEngine', () => {
      const store = new InMemoryContextStore();

      assert.throws(
        () =>
          new ContextEngine({
            store,
            chatId: 'chat-3',
            // @ts-expect-error - testing missing userId
            userId: undefined,
          }),
        /userId is required/,
      );
    });
  });

  describe('Listing Chats by User', () => {
    it('should list only chats belonging to a specific user', async () => {
      const store = new InMemoryContextStore();

      // Create chats for different users
      const aliceChat1 = new ContextEngine({
        store,
        chatId: 'alice-chat-1',
        userId: 'alice',
      });
      await aliceChat1.resolve({ renderer });

      const aliceChat2 = new ContextEngine({
        store,
        chatId: 'alice-chat-2',
        userId: 'alice',
      });
      await aliceChat2.resolve({ renderer });

      const bobChat = new ContextEngine({
        store,
        chatId: 'bob-chat-1',
        userId: 'bob',
      });
      await bobChat.resolve({ renderer });

      // List Alice's chats
      const aliceChats = await store.listChats({ userId: 'alice' });
      assert.strictEqual(aliceChats.length, 2);
      assert.ok(aliceChats.every((c) => c.userId === 'alice'));

      // List Bob's chats
      const bobChats = await store.listChats({ userId: 'bob' });
      assert.strictEqual(bobChats.length, 1);
      assert.strictEqual(bobChats[0].userId, 'bob');
      assert.strictEqual(bobChats[0].id, 'bob-chat-1');
    });

    it('should return all chats when no userId filter is provided', async () => {
      const store = new InMemoryContextStore();

      // Create chats for different users
      await new ContextEngine({
        store,
        chatId: 'chat-a',
        userId: 'user-1',
      }).resolve({ renderer });

      await new ContextEngine({
        store,
        chatId: 'chat-b',
        userId: 'user-2',
      }).resolve({ renderer });

      await new ContextEngine({
        store,
        chatId: 'chat-c',
        userId: 'user-3',
      }).resolve({ renderer });

      // List all chats
      const allChats = await store.listChats();
      assert.strictEqual(allChats.length, 3);
    });

    it('should return empty array for user with no chats', async () => {
      const store = new InMemoryContextStore();

      await new ContextEngine({
        store,
        chatId: 'chat-1',
        userId: 'alice',
      }).resolve({ renderer });

      const bobChats = await store.listChats({ userId: 'bob' });
      assert.strictEqual(bobChats.length, 0);
    });
  });

  describe('Pagination', () => {
    it('should support limit option', async () => {
      const store = new InMemoryContextStore();

      // Create 5 chats for same user
      for (let i = 0; i < 5; i++) {
        await new ContextEngine({
          store,
          chatId: `chat-${i}`,
          userId: 'alice',
        }).resolve({ renderer });
      }

      const limitedChats = await store.listChats({ userId: 'alice', limit: 3 });
      assert.strictEqual(limitedChats.length, 3);
    });

    it('should support offset option for pagination', async () => {
      const store = new InMemoryContextStore();

      // Create 5 chats for same user with different timestamps
      for (let i = 0; i < 5; i++) {
        const engine = new ContextEngine({
          store,
          chatId: `chat-${i}`,
          userId: 'alice',
        });
        await engine.resolve({ renderer });
        // Add a message to update the timestamp
        engine.set(user(`Message ${i}`));
        await engine.save();
      }

      // Get first page
      const page1 = await store.listChats({
        userId: 'alice',
        limit: 2,
        offset: 0,
      });
      assert.strictEqual(page1.length, 2);

      // Get second page
      const page2 = await store.listChats({
        userId: 'alice',
        limit: 2,
        offset: 2,
      });
      assert.strictEqual(page2.length, 2);

      // Ensure no overlap
      const page1Ids = page1.map((c) => c.id);
      const page2Ids = page2.map((c) => c.id);
      assert.ok(page1Ids.every((id) => !page2Ids.includes(id)));
    });
  });

  describe('Multi-User Conversations', () => {
    it('should isolate conversation history per user', async () => {
      const store = new InMemoryContextStore();

      // Alice has a conversation
      const aliceEngine = new ContextEngine({
        store,
        chatId: 'alice-private',
        userId: 'alice',
      });

      aliceEngine.set(user('Hello, this is Alice'));
      aliceEngine.set(assistantText('Hi Alice!'));
      await aliceEngine.save();

      // Bob has a separate conversation
      const bobEngine = new ContextEngine({
        store,
        chatId: 'bob-private',
        userId: 'bob',
      });
      bobEngine.set(user('Hey, Bob here'));
      bobEngine.set(assistantText('Hello Bob!'));
      await bobEngine.save();

      // Verify Alice's chat info
      const aliceChats = await store.listChats({ userId: 'alice' });
      assert.strictEqual(aliceChats.length, 1);
      assert.strictEqual(aliceChats[0].messageCount, 2);

      // Verify Bob's chat info
      const bobChats = await store.listChats({ userId: 'bob' });
      assert.strictEqual(bobChats.length, 1);
      assert.strictEqual(bobChats[0].messageCount, 2);

      // Verify total chats
      const allChats = await store.listChats();
      assert.strictEqual(allChats.length, 2);
    });

    it('should include userId in ChatInfo when listing', async () => {
      const store = new InMemoryContextStore();

      await new ContextEngine({
        store,
        chatId: 'chat-1',
        userId: 'user-abc',
      }).resolve({ renderer });

      const chats = await store.listChats();
      assert.strictEqual(chats[0].userId, 'user-abc');
    });
  });

  describe('Chat CRUD with userId', () => {
    it('should preserve userId on chat update', async () => {
      const store = new InMemoryContextStore();

      const engine = new ContextEngine({
        store,
        chatId: 'updatable-chat',
        userId: 'original-user',
      });
      await engine.resolve({ renderer });

      // Update chat title
      await engine.updateChat({ title: 'My Updated Title' });

      // Verify userId is preserved
      const chat = await store.getChat('updatable-chat');
      assert.ok(chat);
      assert.strictEqual(chat.userId, 'original-user');
      assert.strictEqual(chat.title, 'My Updated Title');
    });

    it('should return userId from upsertChat', async () => {
      const store = new InMemoryContextStore();

      const result = await store.upsertChat({
        id: 'new-chat',
        userId: 'test-user',
        title: 'Test Chat',
      });

      assert.strictEqual(result.userId, 'test-user');
      assert.strictEqual(result.id, 'new-chat');
      assert.strictEqual(result.title, 'Test Chat');
    });
  });

  describe('Security & Data Integrity', () => {
    it('should not return cross-user chats when filtering by userId', async () => {
      const store = new InMemoryContextStore();

      // Create chats for multiple users
      await store.upsertChat({ id: 'alice-1', userId: 'alice' });
      await store.upsertChat({ id: 'alice-2', userId: 'alice' });
      await store.upsertChat({ id: 'bob-1', userId: 'bob' });
      await store.upsertChat({ id: 'charlie-1', userId: 'charlie' });

      // Filter by alice - should NEVER include bob or charlie's chats
      const aliceChats = await store.listChats({ userId: 'alice' });

      assert.strictEqual(aliceChats.length, 2);
      for (const chat of aliceChats) {
        assert.strictEqual(chat.userId, 'alice');
        assert.ok(
          !['bob-1', 'charlie-1'].includes(chat.id),
          `Should not include other users' chats, got: ${chat.id}`,
        );
      }
    });

    it('should allow empty userId string (SQLite accepts it)', async () => {
      const store = new InMemoryContextStore();

      // Note: SQLite's NOT NULL constraint allows empty strings
      // This documents current behavior - consider adding app-level validation if needed
      await store.upsertChat({
        id: 'empty-user-chat',
        userId: '', // empty string is technically valid in SQLite
      });

      const chat = await store.getChat('empty-user-chat');
      assert.ok(chat);
      assert.strictEqual(chat.userId, '');
    });

    it('should preserve userId when getChat retrieves stored chat', async () => {
      const store = new InMemoryContextStore();

      await store.upsertChat({
        id: 'test-chat',
        userId: 'specific-user-id-12345',
        title: 'Test',
      });

      const retrieved = await store.getChat('test-chat');
      assert.ok(retrieved);
      assert.strictEqual(retrieved.userId, 'specific-user-id-12345');
    });

    it('should handle userId with special characters', async () => {
      const store = new InMemoryContextStore();
      const specialUserIds = [
        'user@example.com',
        'user-with-dashes',
        'user_with_underscores',
        'user.with.dots',
        'user+plus',
        '12345-numeric-prefix',
        'uuid-550e8400-e29b-41d4-a716-446655440000',
      ];

      for (const userId of specialUserIds) {
        await store.upsertChat({ id: `chat-${userId}`, userId });
        const chats = await store.listChats({ userId });
        assert.strictEqual(chats.length, 1, `Failed for userId: ${userId}`);
        assert.strictEqual(chats[0].userId, userId);
      }
    });

    it('should handle userId with unicode characters', async () => {
      const store = new InMemoryContextStore();
      const unicodeUserIds = ['用户123', 'пользователь', 'المستخدم', '🎉user'];

      for (const userId of unicodeUserIds) {
        await store.upsertChat({ id: `chat-${userId}`, userId });
        const chats = await store.listChats({ userId });
        assert.strictEqual(
          chats.length,
          1,
          `Failed for unicode userId: ${userId}`,
        );
        assert.strictEqual(chats[0].userId, userId);
      }
    });

    it('should treat userId filtering as case-sensitive', async () => {
      const store = new InMemoryContextStore();

      await store.upsertChat({ id: 'chat-lower', userId: 'alice' });
      await store.upsertChat({ id: 'chat-upper', userId: 'Alice' });
      await store.upsertChat({ id: 'chat-mixed', userId: 'ALICE' });

      const lowerChats = await store.listChats({ userId: 'alice' });
      const upperChats = await store.listChats({ userId: 'Alice' });
      const allCapsChats = await store.listChats({ userId: 'ALICE' });

      // Each should only match exact case
      assert.strictEqual(lowerChats.length, 1);
      assert.strictEqual(upperChats.length, 1);
      assert.strictEqual(allCapsChats.length, 1);
      assert.strictEqual(lowerChats[0].id, 'chat-lower');
      assert.strictEqual(upperChats[0].id, 'chat-upper');
      assert.strictEqual(allCapsChats[0].id, 'chat-mixed');
    });
  });

  describe('userId with Branching & Checkpoints', () => {
    it('should preserve userId through branching operations', async () => {
      const store = new InMemoryContextStore();

      const engine = new ContextEngine({
        store,
        chatId: 'branching-chat',
        userId: 'branch-user',
      });

      // Add messages and create branches
      engine.set(user('First message'));
      await engine.save();

      engine.set(assistantText('Response'));
      await engine.save();

      // Create a checkpoint
      await engine.checkpoint('before-branch');

      engine.set(user('More messages'));
      await engine.save();

      // Restore to checkpoint (creates a new branch)
      await engine.restore('before-branch');

      // Verify userId is still correct after branching
      const chat = await store.getChat('branching-chat');
      assert.ok(chat);
      assert.strictEqual(chat.userId, 'branch-user');

      // Verify through engine getter too
      assert.strictEqual(engine.chat?.userId, 'branch-user');
    });

    it('should preserve userId through checkpoint restore', async () => {
      const store = new InMemoryContextStore();

      const engine = new ContextEngine({
        store,
        chatId: 'checkpoint-chat',
        userId: 'checkpoint-user',
      });

      engine.set(user('Message 1'));
      await engine.save();
      await engine.checkpoint('cp1');

      engine.set(user('Message 2'));
      await engine.save();

      // Restore to checkpoint
      await engine.restore('cp1');

      // userId should be preserved
      const chat = await store.getChat('checkpoint-chat');
      assert.ok(chat);
      assert.strictEqual(chat.userId, 'checkpoint-user');
    });
  });

  describe('userId with Search & Aggregations', () => {
    it('should return correct messageCount per user chat', async () => {
      const store = new InMemoryContextStore();

      // Alice's chat with 3 messages
      const aliceEngine = new ContextEngine({
        store,
        chatId: 'alice-counted',
        userId: 'alice',
      });
      aliceEngine.set(user('Msg 1'));
      aliceEngine.set(assistantText('Response 1'));
      aliceEngine.set(user('Msg 2'));
      await aliceEngine.save();

      // Bob's chat with 1 message
      const bobEngine = new ContextEngine({
        store,
        chatId: 'bob-counted',
        userId: 'bob',
      });
      bobEngine.set(user('Only message'));
      await bobEngine.save();

      // Verify counts are correct per user
      const aliceChats = await store.listChats({ userId: 'alice' });
      const bobChats = await store.listChats({ userId: 'bob' });

      assert.strictEqual(aliceChats[0].messageCount, 3);
      assert.strictEqual(bobChats[0].messageCount, 1);
    });

    it('should scope searchMessages to the correct chat', async () => {
      const store = new InMemoryContextStore();

      // Alice's chat with searchable content
      const aliceEngine = new ContextEngine({
        store,
        chatId: 'alice-search',
        userId: 'alice',
      });
      aliceEngine.set(user('I love pizza and pasta'));
      await aliceEngine.save();

      // Bob's chat with different content
      const bobEngine = new ContextEngine({
        store,
        chatId: 'bob-search',
        userId: 'bob',
      });
      bobEngine.set(user('I prefer sushi and ramen'));
      await bobEngine.save();

      // Search in Alice's chat should only find her content
      const aliceResults = await store.searchMessages('alice-search', 'pizza');
      assert.strictEqual(aliceResults.length, 1);

      // Searching for Bob's content in Alice's chat should return nothing
      const wrongResults = await store.searchMessages('alice-search', 'sushi');
      assert.strictEqual(wrongResults.length, 0);
    });
  });

  describe('Edge Cases & Boundary Conditions', () => {
    it('should handle very long userId strings', async () => {
      const store = new InMemoryContextStore();
      const longUserId = 'u'.repeat(500); // 500 character userId

      await store.upsertChat({ id: 'long-user-chat', userId: longUserId });

      const chats = await store.listChats({ userId: longUserId });
      assert.strictEqual(chats.length, 1);
      assert.strictEqual(chats[0].userId, longUserId);
    });

    it('should handle pagination correctly with userId filter', async () => {
      const store = new InMemoryContextStore();

      // Create 10 chats for alice
      for (let i = 0; i < 10; i++) {
        await store.upsertChat({ id: `alice-page-${i}`, userId: 'alice' });
      }
      // Create 5 chats for bob (should not affect alice's pagination)
      for (let i = 0; i < 5; i++) {
        await store.upsertChat({ id: `bob-page-${i}`, userId: 'bob' });
      }

      // Paginate through alice's chats
      const page1 = await store.listChats({
        userId: 'alice',
        limit: 3,
        offset: 0,
      });
      const page2 = await store.listChats({
        userId: 'alice',
        limit: 3,
        offset: 3,
      });
      const page3 = await store.listChats({
        userId: 'alice',
        limit: 3,
        offset: 6,
      });
      const page4 = await store.listChats({
        userId: 'alice',
        limit: 3,
        offset: 9,
      });

      assert.strictEqual(page1.length, 3);
      assert.strictEqual(page2.length, 3);
      assert.strictEqual(page3.length, 3);
      assert.strictEqual(page4.length, 1); // Only 1 remaining

      // All should belong to alice
      const allPages = [...page1, ...page2, ...page3, ...page4];
      assert.strictEqual(allPages.length, 10);
      assert.ok(allPages.every((c) => c.userId === 'alice'));

      // No duplicates
      const ids = allPages.map((c) => c.id);
      const uniqueIds = new Set(ids);
      assert.strictEqual(uniqueIds.size, 10);
    });

    it('should return empty when offset exceeds total chats', async () => {
      const store = new InMemoryContextStore();

      await store.upsertChat({ id: 'only-chat', userId: 'user' });

      // Note: OFFSET only works with LIMIT in SQLite
      const result = await store.listChats({
        userId: 'user',
        limit: 10,
        offset: 100,
      });
      assert.strictEqual(result.length, 0);
    });
  });

  describe('userId Immutability & Validation', () => {
    it('should not change userId when upserting existing chat with different userId', async () => {
      const store = new InMemoryContextStore();

      // Create chat with original userId
      await store.upsertChat({
        id: 'immutable-chat',
        userId: 'original-owner',
        title: 'Original',
      });

      // Attempt to upsert same chat with different userId
      // Current behavior: ON CONFLICT DO UPDATE SET id = excluded.id (no-op)
      // The userId from the second call is ignored
      await store.upsertChat({
        id: 'immutable-chat',
        userId: 'attacker-trying-to-hijack',
        title: 'Hijacked?',
      });

      // Verify original userId is preserved
      const chat = await store.getChat('immutable-chat');
      assert.ok(chat);
      assert.strictEqual(
        chat.userId,
        'original-owner',
        'userId should not change after initial creation',
      );
      // Note: title also won't change due to ON CONFLICT behavior
      assert.strictEqual(chat.title, 'Original');
    });

    it('should validate userId at TypeScript level (compile-time)', async () => {
      const store = new InMemoryContextStore();

      // This test documents that TypeScript enforces userId as required
      // The following would cause a compile error if uncommented:
      // await store.upsertChat({ id: 'no-user' }); // Error: Property 'userId' is missing

      // Valid call with userId
      const result = await store.upsertChat({
        id: 'valid-chat',
        userId: 'valid-user',
      });
      assert.strictEqual(result.userId, 'valid-user');
    });

    it('should preserve userId when ContextEngine reconnects to existing chat', async () => {
      const store = new InMemoryContextStore();

      // First engine creates the chat
      const engine1 = new ContextEngine({
        store,
        chatId: 'reconnect-chat',
        userId: 'original-user',
      });
      engine1.set(user('First message'));
      await engine1.save();

      // Second engine with DIFFERENT userId connects to same chatId
      // This simulates a potential attack or bug scenario
      const engine2 = new ContextEngine({
        store,
        chatId: 'reconnect-chat',
        userId: 'different-user', // Different userId!
      });
      await engine2.resolve({ renderer });

      // The stored chat should still have original userId
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
      const store = new InMemoryContextStore();

      // Create multiple chats concurrently for same user
      const createPromises = Array.from({ length: 10 }, (_, i) =>
        store.upsertChat({
          id: `concurrent-${i}`,
          userId: 'concurrent-user',
          title: `Chat ${i}`,
        }),
      );

      const results = await Promise.all(createPromises);

      // All should succeed
      assert.strictEqual(results.length, 10);
      for (const result of results) {
        assert.strictEqual(result.userId, 'concurrent-user');
      }

      // All should be retrievable
      const chats = await store.listChats({ userId: 'concurrent-user' });
      assert.strictEqual(chats.length, 10);
    });

    it('should handle concurrent chat creation for different users', async () => {
      const store = new InMemoryContextStore();

      // Create chats for multiple users concurrently
      const users = ['user-a', 'user-b', 'user-c', 'user-d', 'user-e'];
      const createPromises = users.flatMap((userId, userIndex) =>
        Array.from({ length: 5 }, (_, i) =>
          store.upsertChat({
            id: `multi-${userId}-${i}`,
            userId,
            title: `Chat ${userIndex}-${i}`,
          }),
        ),
      );

      await Promise.all(createPromises);

      // Each user should have exactly 5 chats
      for (const userId of users) {
        const userChats = await store.listChats({ userId });
        assert.strictEqual(
          userChats.length,
          5,
          `User ${userId} should have 5 chats`,
        );
        assert.ok(userChats.every((c) => c.userId === userId));
      }

      // Total should be 25 chats
      const allChats = await store.listChats();
      assert.strictEqual(allChats.length, 25);
    });

    it('should handle concurrent reads and writes', async () => {
      const store = new InMemoryContextStore();

      // Create initial chat
      await store.upsertChat({ id: 'rw-chat', userId: 'rw-user' });

      // Perform concurrent reads and writes
      const operations = [
        store.getChat('rw-chat'),
        store.listChats({ userId: 'rw-user' }),
        store.upsertChat({ id: 'rw-chat-2', userId: 'rw-user' }),
        store.getChat('rw-chat'),
        store.listChats({ userId: 'rw-user' }),
        store.upsertChat({ id: 'rw-chat-3', userId: 'rw-user' }),
      ];

      const results = await Promise.all(operations);

      // All operations should complete without error
      assert.ok(results[0]); // getChat result
      assert.ok(Array.isArray(results[1])); // listChats result
      assert.ok(results[2]); // upsertChat result

      // Final state should be consistent
      const finalChats = await store.listChats({ userId: 'rw-user' });
      assert.strictEqual(finalChats.length, 3);
    });
  });
});
