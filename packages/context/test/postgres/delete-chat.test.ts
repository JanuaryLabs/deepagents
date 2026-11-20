import { Postgres } from '@zukhruf/testing/postgres';
import assert from 'node:assert';
import { describe, it } from 'node:test';

import { ContextEngine, PostgresContextStore, user } from '@deepagents/context';

const testPostgres = new Postgres({ environment: process.env });

describe('Delete Chat', () => {
  describe('Basic Deletion', () => {
    it('should not affect other chats when deleting one', async () => {
      await using container = await testPostgres.database();

      const store = await PostgresContextStore.create({
        pool: container.pool(),
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
    });
  });

  describe('Edge Cases', () => {
    it('should handle chatId with special characters', async () => {
      await using container = await testPostgres.database();

      const store = await PostgresContextStore.create({
        pool: container.pool(),
      });
      try {
        const specialIds = [
          'chat-with-dashes-pg',
          'chat_with_underscores_pg',
          'chat.with.dots.pg',
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
    });

    it('should handle very long chatId', async () => {
      await using container = await testPostgres.database();

      const store = await PostgresContextStore.create({
        pool: container.pool(),
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
    });
  });

  describe('Concurrent Operations', () => {
    it('should handle concurrent deletion of different chats', async () => {
      await using container = await testPostgres.database();

      const store = await PostgresContextStore.create({
        pool: container.pool(),
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
    });

    it('should not affect concurrent reads of other chats', async () => {
      await using container = await testPostgres.database();

      const store = await PostgresContextStore.create({
        pool: container.pool(),
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
        ] as const;

        const results = await Promise.all(operations);

        assert.strictEqual(results[0], true);
        assert.strictEqual(results[1], true);
        assert.strictEqual(results[4], true);

        assert.ok(results[2]);
        assert.strictEqual(results[2].id, 'reader-chat-2');
        assert.ok(results[3]);
        assert.strictEqual(results[3].id, 'reader-chat-3');
      } finally {
        await store.close();
      }
    });
  });
});
