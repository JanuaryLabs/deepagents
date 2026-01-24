import assert from 'node:assert';
import { describe, it } from 'node:test';

import {
  ContextEngine,
  SqlServerContextStore,
  XmlRenderer,
  assistantText,
  user,
} from '@deepagents/context';

import {
  waitForFtsReady,
  withSqlServerContainer,
} from '../helpers/sqlserver-container.ts';

const renderer = new XmlRenderer();

describe('User Chat Management', () => {
  describe('Chat Creation with userId', () => {
    it('should create chat associated with specific user via ContextEngine', async () => {
      await withSqlServerContainer(async (container) => {
        const store = new SqlServerContextStore({
          pool: container.connectionString,
        });
        try {
          const engine = new ContextEngine({
            store,
            chatId: 'user-chat-1',
            userId: 'alice',
          });

          await engine.resolve({ renderer });

          const chat = await store.getChat('user-chat-1');
          assert.ok(chat);
          assert.strictEqual(chat.userId, 'alice');
        } finally {
          await store.close();
        }
      });
    });

    it('should expose userId via chat metadata getter', async () => {
      await withSqlServerContainer(async (container) => {
        const store = new SqlServerContextStore({
          pool: container.connectionString,
        });
        try {
          const engine = new ContextEngine({
            store,
            chatId: 'user-chat-2',
            userId: 'bob',
          });

          await engine.resolve({ renderer });

          const chatMeta = engine.chat;
          assert.ok(chatMeta);
          assert.strictEqual(chatMeta.userId, 'bob');
          assert.strictEqual(chatMeta.id, 'user-chat-2');
        } finally {
          await store.close();
        }
      });
    });
  });

  describe('Listing Chats by User', () => {
    it('should list only chats belonging to specific user', async () => {
      await withSqlServerContainer(async (container) => {
        const store = new SqlServerContextStore({
          pool: container.connectionString,
        });
        try {
          const aliceChat1 = new ContextEngine({
            store,
            chatId: 'alice-list-1',
            userId: 'alice-list',
          });
          await aliceChat1.resolve({ renderer });

          const aliceChat2 = new ContextEngine({
            store,
            chatId: 'alice-list-2',
            userId: 'alice-list',
          });
          await aliceChat2.resolve({ renderer });

          const bobChat = new ContextEngine({
            store,
            chatId: 'bob-list-1',
            userId: 'bob-list',
          });
          await bobChat.resolve({ renderer });

          const aliceChats = await store.listChats({ userId: 'alice-list' });
          assert.strictEqual(aliceChats.length, 2);
          assert.ok(aliceChats.every((c) => c.userId === 'alice-list'));

          const bobChats = await store.listChats({ userId: 'bob-list' });
          assert.strictEqual(bobChats.length, 1);
          assert.strictEqual(bobChats[0].userId, 'bob-list');
        } finally {
          await store.close();
        }
      });
    });

    it('should return empty array for user with no chats', async () => {
      await withSqlServerContainer(async (container) => {
        const store = new SqlServerContextStore({
          pool: container.connectionString,
        });
        try {
          const noChats = await store.listChats({
            userId: 'nonexistent-user-xyz',
          });
          assert.strictEqual(noChats.length, 0);
        } finally {
          await store.close();
        }
      });
    });
  });

  describe('Multi-User Conversations', () => {
    it('should isolate conversation history per user', async () => {
      await withSqlServerContainer(async (container) => {
        const store = new SqlServerContextStore({
          pool: container.connectionString,
        });
        try {
          const aliceEngine = new ContextEngine({
            store,
            chatId: 'alice-iso-private',
            userId: 'alice-iso',
          });

          aliceEngine.set(user('Hello, this is Alice'));
          aliceEngine.set(assistantText('Hi Alice!'));
          await aliceEngine.save();

          const bobEngine = new ContextEngine({
            store,
            chatId: 'bob-iso-private',
            userId: 'bob-iso',
          });
          bobEngine.set(user('Hey, Bob here'));
          bobEngine.set(assistantText('Hello Bob!'));
          await bobEngine.save();

          const aliceChats = await store.listChats({ userId: 'alice-iso' });
          assert.strictEqual(aliceChats.length, 1);
          assert.strictEqual(aliceChats[0].messageCount, 2);

          const bobChats = await store.listChats({ userId: 'bob-iso' });
          assert.strictEqual(bobChats.length, 1);
          assert.strictEqual(bobChats[0].messageCount, 2);
        } finally {
          await store.close();
        }
      });
    });

    it('should include userId in ChatInfo when listing', async () => {
      await withSqlServerContainer(async (container) => {
        const store = new SqlServerContextStore({
          pool: container.connectionString,
        });
        try {
          await new ContextEngine({
            store,
            chatId: 'chatinfo-test',
            userId: 'user-abc-info',
          }).resolve({ renderer });

          const chats = await store.listChats({ userId: 'user-abc-info' });
          assert.strictEqual(chats[0].userId, 'user-abc-info');
        } finally {
          await store.close();
        }
      });
    });
  });

  describe('Security & Data Integrity', () => {
    it('should not return cross-user chats when filtering by userId', async () => {
      await withSqlServerContainer(async (container) => {
        const store = new SqlServerContextStore({
          pool: container.connectionString,
        });
        try {
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
        } finally {
          await store.close();
        }
      });
    });

    it('should preserve userId when getChat retrieves stored chat', async () => {
      await withSqlServerContainer(async (container) => {
        const store = new SqlServerContextStore({
          pool: container.connectionString,
        });
        try {
          await store.upsertChat({
            id: 'preserve-test-chat',
            userId: 'specific-user-id-12345',
            title: 'Test',
          });

          const retrieved = await store.getChat('preserve-test-chat');
          assert.ok(retrieved);
          assert.strictEqual(retrieved.userId, 'specific-user-id-12345');
        } finally {
          await store.close();
        }
      });
    });

    it('should handle userId with special characters', async () => {
      await withSqlServerContainer(async (container) => {
        const store = new SqlServerContextStore({
          pool: container.connectionString,
        });
        try {
          const specialUserIds = [
            'user@example.com',
            'user-with-dashes',
            'user_with_underscores',
            'user.with.dots',
            'uuid-550e8400-e29b-41d4-a716-446655440000',
          ];

          for (const userId of specialUserIds) {
            await store.upsertChat({ id: `special-chat-${userId}`, userId });
            const chats = await store.listChats({ userId });
            assert.strictEqual(chats.length, 1, `Failed for userId: ${userId}`);
            assert.strictEqual(chats[0].userId, userId);
          }
        } finally {
          await store.close();
        }
      });
    });

    it('should handle userId with unicode characters', async () => {
      await withSqlServerContainer(async (container) => {
        const store = new SqlServerContextStore({
          pool: container.connectionString,
        });
        try {
          const unicodeUserIds = ['用户123', 'пользователь', 'المستخدم'];

          for (const userId of unicodeUserIds) {
            await store.upsertChat({ id: `unicode-chat-${userId}`, userId });
            const chats = await store.listChats({ userId });
            assert.strictEqual(
              chats.length,
              1,
              `Failed for unicode userId: ${userId}`,
            );
            assert.strictEqual(chats[0].userId, userId);
          }
        } finally {
          await store.close();
        }
      });
    });

    /**
     * SQL Server uses case-insensitive collation by default (Latin1_General_CI_AS),
     * so userId filtering is case-insensitive. This differs from PostgreSQL.
     * The test verifies that queries with different case variations return matching results.
     */
    it('should treat userId filtering as case-insensitive (SQL Server default)', async () => {
      await withSqlServerContainer(async (container) => {
        const store = new SqlServerContextStore({
          pool: container.connectionString,
        });
        try {
          // Create chats with same "userId" but stored with different cases
          await store.upsertChat({
            id: 'case-chat-1',
            userId: 'case-alice',
          });
          await store.upsertChat({
            id: 'case-chat-2',
            userId: 'case-Alice',
          });
          await store.upsertChat({
            id: 'case-chat-3',
            userId: 'case-ALICE',
          });

          // SQL Server's default collation treats these as the same userId,
          // so any case variation should return all 3 chats
          const chats = await store.listChats({ userId: 'case-alice' });

          // All 3 chats should match due to case-insensitive comparison
          assert.strictEqual(chats.length, 3);

          // Different case queries should return the same results
          const upperChats = await store.listChats({ userId: 'CASE-ALICE' });
          assert.strictEqual(upperChats.length, 3);
        } finally {
          await store.close();
        }
      });
    });
  });

  describe('userId with Branching & Checkpoints', () => {
    it('should preserve userId through branching operations', async () => {
      await withSqlServerContainer(async (container) => {
        const store = new SqlServerContextStore({
          pool: container.connectionString,
        });
        try {
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
        } finally {
          await store.close();
        }
      });
    });

    it('should preserve userId through checkpoint restore', async () => {
      await withSqlServerContainer(async (container) => {
        const store = new SqlServerContextStore({
          pool: container.connectionString,
        });
        try {
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
        } finally {
          await store.close();
        }
      });
    });
  });

  describe('userId with Search', () => {
    it('should return correct messageCount per user chat', async () => {
      await withSqlServerContainer(async (container) => {
        const store = new SqlServerContextStore({
          pool: container.connectionString,
        });
        try {
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
        } finally {
          await store.close();
        }
      });
    });
  });

  describe('Edge Cases', () => {
    it('should handle very long userId strings', async () => {
      await withSqlServerContainer(async (container) => {
        const store = new SqlServerContextStore({
          pool: container.connectionString,
        });
        try {
          const longUserId = 'u'.repeat(200);

          await store.upsertChat({ id: 'long-user-chat', userId: longUserId });

          const chats = await store.listChats({ userId: longUserId });
          assert.strictEqual(chats.length, 1);
          assert.strictEqual(chats[0].userId, longUserId);
        } finally {
          await store.close();
        }
      });
    });

    it('should handle pagination correctly with userId filter', async () => {
      await withSqlServerContainer(async (container) => {
        const store = new SqlServerContextStore({
          pool: container.connectionString,
        });
        try {
          for (let i = 0; i < 10; i++) {
            await store.upsertChat({
              id: `page-alice-${i}`,
              userId: 'page-alice',
            });
          }
          for (let i = 0; i < 5; i++) {
            await store.upsertChat({ id: `page-bob-${i}`, userId: 'page-bob' });
          }

          const page1 = await store.listChats({
            userId: 'page-alice',
            limit: 3,
            offset: 0,
          });
          const page2 = await store.listChats({
            userId: 'page-alice',
            limit: 3,
            offset: 3,
          });
          const page3 = await store.listChats({
            userId: 'page-alice',
            limit: 3,
            offset: 6,
          });
          const page4 = await store.listChats({
            userId: 'page-alice',
            limit: 3,
            offset: 9,
          });

          assert.strictEqual(page1.length, 3);
          assert.strictEqual(page2.length, 3);
          assert.strictEqual(page3.length, 3);
          assert.strictEqual(page4.length, 1);

          const allPages = [...page1, ...page2, ...page3, ...page4];
          assert.strictEqual(allPages.length, 10);
          assert.ok(allPages.every((c) => c.userId === 'page-alice'));
        } finally {
          await store.close();
        }
      });
    });

    it('should return empty when offset exceeds total chats', async () => {
      await withSqlServerContainer(async (container) => {
        const store = new SqlServerContextStore({
          pool: container.connectionString,
        });
        try {
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
        } finally {
          await store.close();
        }
      });
    });
  });

  describe('userId Immutability', () => {
    it('should not change userId when upserting existing chat', async () => {
      await withSqlServerContainer(async (container) => {
        const store = new SqlServerContextStore({
          pool: container.connectionString,
        });
        try {
          await store.upsertChat({
            id: 'immutable-ss-chat',
            userId: 'original-ss-owner',
            title: 'Original',
          });

          await store.upsertChat({
            id: 'immutable-ss-chat',
            userId: 'attacker-trying-to-hijack',
            title: 'Hijacked?',
          });

          const chat = await store.getChat('immutable-ss-chat');
          assert.ok(chat);
          assert.strictEqual(chat.userId, 'original-ss-owner');
          assert.strictEqual(chat.title, 'Original');
        } finally {
          await store.close();
        }
      });
    });

    it('should preserve userId when ContextEngine reconnects', async () => {
      await withSqlServerContainer(async (container) => {
        const store = new SqlServerContextStore({
          pool: container.connectionString,
        });
        try {
          const engine1 = new ContextEngine({
            store,
            chatId: 'reconnect-ss-chat',
            userId: 'original-ss-user',
          });
          engine1.set(user('First message'));
          await engine1.save();

          const engine2 = new ContextEngine({
            store,
            chatId: 'reconnect-ss-chat',
            userId: 'different-ss-user',
          });
          await engine2.resolve({ renderer });

          const storedChat = await store.getChat('reconnect-ss-chat');
          assert.ok(storedChat);
          assert.strictEqual(storedChat.userId, 'original-ss-user');
        } finally {
          await store.close();
        }
      });
    });
  });

  describe('Concurrent Operations', () => {
    it('should handle concurrent chat creation for same user', async () => {
      await withSqlServerContainer(async (container) => {
        const store = new SqlServerContextStore({
          pool: container.connectionString,
        });
        try {
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
        } finally {
          await store.close();
        }
      });
    });

    it('should handle concurrent chat creation for different users', async () => {
      await withSqlServerContainer(async (container) => {
        const store = new SqlServerContextStore({
          pool: container.connectionString,
        });
        try {
          const users = [
            'conc-user-a',
            'conc-user-b',
            'conc-user-c',
            'conc-user-d',
            'conc-user-e',
          ];
          const createPromises = users.flatMap((userId, userIndex) =>
            Array.from({ length: 5 }, (_, i) =>
              store.upsertChat({
                id: `multi-conc-${userId}-${i}`,
                userId,
                title: `Chat ${userIndex}-${i}`,
              }),
            ),
          );

          await Promise.all(createPromises);

          for (const userId of users) {
            const userChats = await store.listChats({ userId });
            assert.strictEqual(
              userChats.length,
              5,
              `User ${userId} should have 5 chats`,
            );
            assert.ok(userChats.every((c) => c.userId === userId));
          }
        } finally {
          await store.close();
        }
      });
    });

    it('should handle concurrent reads and writes', async () => {
      await withSqlServerContainer(async (container) => {
        const store = new SqlServerContextStore({
          pool: container.connectionString,
        });
        try {
          await store.upsertChat({ id: 'rw-ss-chat', userId: 'rw-ss-user' });

          const operations = [
            store.getChat('rw-ss-chat'),
            store.listChats({ userId: 'rw-ss-user' }),
            store.upsertChat({ id: 'rw-ss-chat-2', userId: 'rw-ss-user' }),
            store.getChat('rw-ss-chat'),
            store.listChats({ userId: 'rw-ss-user' }),
            store.upsertChat({ id: 'rw-ss-chat-3', userId: 'rw-ss-user' }),
          ];

          const results = await Promise.all(operations);

          assert.ok(results[0]);
          assert.ok(Array.isArray(results[1]));
          assert.ok(results[2]);

          const finalChats = await store.listChats({ userId: 'rw-ss-user' });
          assert.strictEqual(finalChats.length, 3);
        } finally {
          await store.close();
        }
      });
    });
  });
});

describe('Message Upsert', () => {
  it('should update existing message with same ID', async () => {
    await withSqlServerContainer(async (container) => {
      const store = new SqlServerContextStore({
        pool: container.connectionString,
      });
      try {
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
      } finally {
        await store.close();
      }
    });
  });

  it('should update FTS index on upsert', async () => {
    await withSqlServerContainer(async (container) => {
      const store = new SqlServerContextStore({
        pool: container.connectionString,
      });
      try {
        await store.upsertChat({ id: 'upsert-fts-chat', userId: 'user-1' });

        await store.addMessage({
          id: 'upsert-fts-msg',
          chatId: 'upsert-fts-chat',
          parentId: null,
          name: 'user',
          type: 'message',
          data: 'original searchable content',
          createdAt: 1000,
        });

        // Wait for full-text index to populate (SQL Server FTS is async)
        await waitForFtsReady(container.connectionString);

        let results = await store.searchMessages('upsert-fts-chat', 'original');
        assert.strictEqual(results.length, 1);

        await store.addMessage({
          id: 'upsert-fts-msg',
          chatId: 'upsert-fts-chat',
          parentId: null,
          name: 'user',
          type: 'message',
          data: 'updated searchable content',
          createdAt: 1000,
        });

        // Wait for full-text index to update (SQL Server FTS is async)
        await new Promise((resolve) => setTimeout(resolve, 2000));

        results = await store.searchMessages('upsert-fts-chat', 'original');
        assert.strictEqual(results.length, 0);

        results = await store.searchMessages('upsert-fts-chat', 'updated');
        assert.strictEqual(results.length, 1);
      } finally {
        await store.close();
      }
    });
  });

  it('should preserve original parentId on upsert', async () => {
    await withSqlServerContainer(async (container) => {
      const store = new SqlServerContextStore({
        pool: container.connectionString,
      });
      try {
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
      } finally {
        await store.close();
      }
    });
  });

  it('should preserve original createdAt on upsert', async () => {
    await withSqlServerContainer(async (container) => {
      const store = new SqlServerContextStore({
        pool: container.connectionString,
      });
      try {
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
      } finally {
        await store.close();
      }
    });
  });
});
