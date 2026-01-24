import assert from 'node:assert';
import { describe, it } from 'node:test';

import {
  ContextEngine,
  SqlServerContextStore,
  XmlRenderer,
  assistantText,
  user,
} from '@deepagents/context';

import { withSqlServerContainer } from '../helpers/sqlserver-container.ts';

const renderer = new XmlRenderer();

describe('Delete Chat', () => {
  describe('Basic Deletion', () => {
    it('should delete an existing chat and return true', () =>
      withSqlServerContainer(async (container) => {
        const store = new SqlServerContextStore({
          pool: container.connectionString,
        });
        try {
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
        } finally {
          await store.close();
        }
      }));

    it('should return false when deleting non-existent chat', () =>
      withSqlServerContainer(async (container) => {
        const store = new SqlServerContextStore({
          pool: container.connectionString,
        });
        try {
          const result = await store.deleteChat('non-existent-chat-12345');

          assert.strictEqual(result, false);
        } finally {
          await store.close();
        }
      }));

    it('should return false when deleting already-deleted chat', () =>
      withSqlServerContainer(async (container) => {
        const store = new SqlServerContextStore({
          pool: container.connectionString,
        });
        try {
          const engine = new ContextEngine({
            store,
            chatId: 'chat-double-delete',
            userId: 'alice',
          });
          await engine.resolve({ renderer });

          const firstResult = await store.deleteChat('chat-double-delete');
          assert.strictEqual(firstResult, true);

          const secondResult = await store.deleteChat('chat-double-delete');
          assert.strictEqual(secondResult, false);
        } finally {
          await store.close();
        }
      }));

    it('should not affect other chats when deleting one', () =>
      withSqlServerContainer(async (container) => {
        const store = new SqlServerContextStore({
          pool: container.connectionString,
        });
        try {
          const engine1 = new ContextEngine({
            store,
            chatId: 'chat-keep-1',
            userId: 'alice',
          });
          engine1.set(user('Hello from chat 1'));
          await engine1.save();

          const engine2 = new ContextEngine({
            store,
            chatId: 'chat-keep-2',
            userId: 'alice',
          });
          engine2.set(user('Hello from chat 2'));
          await engine2.save();

          await store.deleteChat('chat-keep-1');

          const chat2 = await store.getChat('chat-keep-2');
          assert.ok(chat2);
          assert.strictEqual(chat2.id, 'chat-keep-2');
        } finally {
          await store.close();
        }
      }));
  });

  describe('Cascading Deletes', () => {
    it('should delete all messages when chat is deleted', () =>
      withSqlServerContainer(async (container) => {
        const store = new SqlServerContextStore({
          pool: container.connectionString,
        });
        try {
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

          const branch = await store.getActiveBranch('chat-with-messages');
          assert.ok(branch?.headMessageId);

          const messagesBefore = await store.getMessageChain(
            branch.headMessageId,
          );
          assert.strictEqual(messagesBefore.length, 4);

          await store.deleteChat('chat-with-messages');

          const messagesAfter = await store.getMessageChain(
            branch.headMessageId,
          );
          assert.strictEqual(messagesAfter.length, 0);
        } finally {
          await store.close();
        }
      }));

    it('should delete all branches when chat is deleted', () =>
      withSqlServerContainer(async (container) => {
        const store = new SqlServerContextStore({
          pool: container.connectionString,
        });
        try {
          const engine = new ContextEngine({
            store,
            chatId: 'chat-with-branches',
            userId: 'alice',
          });
          engine.set(user('Message 1'));
          await engine.save();

          await engine.checkpoint('before-branch');
          engine.set(user('Message on main'));
          await engine.save();

          await engine.restore('before-branch');
          engine.set(user('Message on new branch'));
          await engine.save();

          const branchesBefore = await store.listBranches('chat-with-branches');
          assert.strictEqual(branchesBefore.length, 2);

          await store.deleteChat('chat-with-branches');

          const branchesAfter = await store.listBranches('chat-with-branches');
          assert.strictEqual(branchesAfter.length, 0);
        } finally {
          await store.close();
        }
      }));

    it('should delete all checkpoints when chat is deleted', () =>
      withSqlServerContainer(async (container) => {
        const store = new SqlServerContextStore({
          pool: container.connectionString,
        });
        try {
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

          const checkpointsBefore = await store.listCheckpoints(
            'chat-with-checkpoints',
          );
          assert.strictEqual(checkpointsBefore.length, 3);

          await store.deleteChat('chat-with-checkpoints');

          const checkpointsAfter = await store.listCheckpoints(
            'chat-with-checkpoints',
          );
          assert.strictEqual(checkpointsAfter.length, 0);
        } finally {
          await store.close();
        }
      }));

    it('should handle chat with multiple branches', () =>
      withSqlServerContainer(async (container) => {
        const store = new SqlServerContextStore({
          pool: container.connectionString,
        });
        try {
          const engine = new ContextEngine({
            store,
            chatId: 'multi-branch-chat',
            userId: 'alice',
          });

          engine.set(user('Initial message'));
          await engine.save();
          await engine.checkpoint('fork-point');

          engine.set(user('Branch 1 message'));
          await engine.save();

          await engine.restore('fork-point');
          engine.set(user('Branch 2 message'));
          await engine.save();

          await engine.restore('fork-point');
          engine.set(user('Branch 3 message'));
          await engine.save();

          const branchesBefore = await store.listBranches('multi-branch-chat');
          assert.strictEqual(branchesBefore.length, 3);

          const result = await store.deleteChat('multi-branch-chat');
          assert.strictEqual(result, true);

          const chat = await store.getChat('multi-branch-chat');
          assert.strictEqual(chat, undefined);

          const branchesAfter = await store.listBranches('multi-branch-chat');
          assert.strictEqual(branchesAfter.length, 0);
        } finally {
          await store.close();
        }
      }));

    it('should handle chat with deep message chains (50+ messages)', () =>
      withSqlServerContainer(async (container) => {
        const store = new SqlServerContextStore({
          pool: container.connectionString,
        });
        try {
          const engine = new ContextEngine({
            store,
            chatId: 'deep-chain-chat',
            userId: 'alice',
          });

          for (let i = 0; i < 25; i++) {
            engine.set(user(`User message ${i}`));
            engine.set(assistantText(`Assistant response ${i}`));
          }
          await engine.save();

          const result = await store.deleteChat('deep-chain-chat');
          assert.strictEqual(result, true);

          const chatAfter = await store.getChat('deep-chain-chat');
          assert.strictEqual(chatAfter, undefined);
        } finally {
          await store.close();
        }
      }));
  });

  describe('User Authorization', () => {
    it('should delete chat when userId matches', () =>
      withSqlServerContainer(async (container) => {
        const store = new SqlServerContextStore({
          pool: container.connectionString,
        });
        try {
          const engine = new ContextEngine({
            store,
            chatId: 'alice-chat-auth',
            userId: 'alice',
          });
          await engine.resolve({ renderer });

          const result = await store.deleteChat('alice-chat-auth', {
            userId: 'alice',
          });

          assert.strictEqual(result, true);
          const chat = await store.getChat('alice-chat-auth');
          assert.strictEqual(chat, undefined);
        } finally {
          await store.close();
        }
      }));

    it('should return false when userId does not match', () =>
      withSqlServerContainer(async (container) => {
        const store = new SqlServerContextStore({
          pool: container.connectionString,
        });
        try {
          const engine = new ContextEngine({
            store,
            chatId: 'alice-only-chat',
            userId: 'alice',
          });
          await engine.resolve({ renderer });

          const result = await store.deleteChat('alice-only-chat', {
            userId: 'bob',
          });

          assert.strictEqual(result, false);

          const chat = await store.getChat('alice-only-chat');
          assert.ok(chat);
          assert.strictEqual(chat.userId, 'alice');
        } finally {
          await store.close();
        }
      }));

    it('should delete any chat when userId not provided (admin mode)', () =>
      withSqlServerContainer(async (container) => {
        const store = new SqlServerContextStore({
          pool: container.connectionString,
        });
        try {
          const engine = new ContextEngine({
            store,
            chatId: 'any-user-chat',
            userId: 'someuser',
          });
          await engine.resolve({ renderer });

          const result = await store.deleteChat('any-user-chat');

          assert.strictEqual(result, true);
          const chat = await store.getChat('any-user-chat');
          assert.strictEqual(chat, undefined);
        } finally {
          await store.close();
        }
      }));

    it('should not delete other users chats', () =>
      withSqlServerContainer(async (container) => {
        const store = new SqlServerContextStore({
          pool: container.connectionString,
        });
        try {
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

          const result = await store.deleteChat('bob-private', {
            userId: 'alice',
          });
          assert.strictEqual(result, false);

          const bobChat = await store.getChat('bob-private');
          assert.ok(bobChat);

          const aliceChat = await store.getChat('alice-private');
          assert.ok(aliceChat);
        } finally {
          await store.close();
        }
      }));

    /**
     * SQL Server uses case-insensitive collation by default (Latin1_General_CI_AS),
     * so userId comparisons are case-insensitive. This differs from PostgreSQL.
     * The test verifies that any case variation of the userId can match.
     */
    it('should handle case-insensitive userId comparison (SQL Server default)', () =>
      withSqlServerContainer(async (container) => {
        const store = new SqlServerContextStore({
          pool: container.connectionString,
        });
        try {
          const engine = new ContextEngine({
            store,
            chatId: 'case-insensitive-chat',
            userId: 'Alice',
          });
          await engine.resolve({ renderer });

          // SQL Server's default collation is case-insensitive,
          // so 'alice' should match 'Alice'
          const result = await store.deleteChat('case-insensitive-chat', {
            userId: 'alice',
          });
          assert.strictEqual(result, true);
        } finally {
          await store.close();
        }
      }));
  });

  describe('Edge Cases', () => {
    it('should handle deleting chat with no messages', () =>
      withSqlServerContainer(async (container) => {
        const store = new SqlServerContextStore({
          pool: container.connectionString,
        });
        try {
          const engine = new ContextEngine({
            store,
            chatId: 'empty-chat',
            userId: 'alice',
          });
          await engine.resolve({ renderer });

          const result = await store.deleteChat('empty-chat');

          assert.strictEqual(result, true);
          const chat = await store.getChat('empty-chat');
          assert.strictEqual(chat, undefined);
        } finally {
          await store.close();
        }
      }));

    it('should handle chatId with special characters', () =>
      withSqlServerContainer(async (container) => {
        const store = new SqlServerContextStore({
          pool: container.connectionString,
        });
        try {
          const specialIds = [
            'chat-with-dashes-ss',
            'chat_with_underscores_ss',
            'chat.with.dots.ss',
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
        } finally {
          await store.close();
        }
      }));

    it('should handle very long chatId', () =>
      withSqlServerContainer(async (container) => {
        const store = new SqlServerContextStore({
          pool: container.connectionString,
        });
        try {
          const longChatId = 'c'.repeat(200);

          await store.upsertChat({ id: longChatId, userId: 'alice' });

          const result = await store.deleteChat(longChatId);

          assert.strictEqual(result, true);
          const chat = await store.getChat(longChatId);
          assert.strictEqual(chat, undefined);
        } finally {
          await store.close();
        }
      }));
  });

  describe('Concurrent Operations', () => {
    it('should handle concurrent deletion of different chats', () =>
      withSqlServerContainer(async (container) => {
        const store = new SqlServerContextStore({
          pool: container.connectionString,
        });
        try {
          for (let i = 0; i < 10; i++) {
            await store.upsertChat({
              id: `concurrent-del-${i}`,
              userId: 'alice',
            });
          }

          const deletePromises = Array.from({ length: 10 }, (_, i) =>
            store.deleteChat(`concurrent-del-${i}`),
          );

          const results = await Promise.all(deletePromises);

          assert.ok(results.every((r) => r === true));
        } finally {
          await store.close();
        }
      }));

    it('should handle concurrent deletion of same chat (one succeeds)', () =>
      withSqlServerContainer(async (container) => {
        const store = new SqlServerContextStore({
          pool: container.connectionString,
        });
        try {
          await store.upsertChat({ id: 'race-chat', userId: 'alice' });

          const deletePromises = Array.from({ length: 5 }, () =>
            store.deleteChat('race-chat'),
          );

          const results = await Promise.all(deletePromises);

          const successCount = results.filter((r) => r === true).length;
          const failCount = results.filter((r) => r === false).length;

          assert.strictEqual(
            successCount,
            1,
            'Exactly one delete should succeed',
          );
          assert.strictEqual(failCount, 4, 'Other deletes should return false');

          const chat = await store.getChat('race-chat');
          assert.strictEqual(chat, undefined);
        } finally {
          await store.close();
        }
      }));

    it('should not affect concurrent reads of other chats', () =>
      withSqlServerContainer(async (container) => {
        const store = new SqlServerContextStore({
          pool: container.connectionString,
        });
        try {
          for (let i = 0; i < 5; i++) {
            const engine = new ContextEngine({
              store,
              chatId: `reader-chat-${i}`,
              userId: 'alice',
            });
            engine.set(user(`Message for chat ${i}`));
            await engine.save();
          }

          const operations = [
            store.deleteChat('reader-chat-0'),
            store.deleteChat('reader-chat-1'),
            store.getChat('reader-chat-2'),
            store.getChat('reader-chat-3'),
            store.deleteChat('reader-chat-4'),
          ];

          const results = await Promise.all(operations);

          assert.strictEqual(results[0], true);
          assert.strictEqual(results[1], true);
          assert.strictEqual(results[4], true);

          assert.ok(results[2]);
          assert.strictEqual(
            (results[2] as { id: string }).id,
            'reader-chat-2',
          );
          assert.ok(results[3]);
          assert.strictEqual(
            (results[3] as { id: string }).id,
            'reader-chat-3',
          );
        } finally {
          await store.close();
        }
      }));
  });
});
