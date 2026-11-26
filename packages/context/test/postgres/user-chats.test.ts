import { describe, it } from '@zukhruf/parameterized-test';
import { Postgres } from '@zukhruf/testing/postgres';
import assert from 'node:assert';

import {
  ContextEngine,
  PostgresContextStore,
  XmlRenderer,
  assistantText,
  user,
} from '@deepagents/context';

import { buildSandbox } from '../helpers/build-sandbox.ts';

const testPostgres = new Postgres({ environment: process.env });

const renderer = new XmlRenderer();

describe('User Chat Management', () => {
  describe('Listing Chats by User', () => {
    it('should list only chats belonging to specific user', async () => {
      await using container = await testPostgres.database();

      const store = await PostgresContextStore.create({
        pool: container.pool(),
      });
      const aliceChat1 = new ContextEngine({
        store,
        chatId: 'alice-list-1',
        userId: 'alice-list',
      });
      await aliceChat1.resolve({
        renderer,
        sandbox: await buildSandbox(),
      });

      const aliceChat2 = new ContextEngine({
        store,
        chatId: 'alice-list-2',
        userId: 'alice-list',
      });
      await aliceChat2.resolve({
        renderer,
        sandbox: await buildSandbox(),
      });

      const bobChat = new ContextEngine({
        store,
        chatId: 'bob-list-1',
        userId: 'bob-list',
      });
      await bobChat.resolve({
        renderer,
        sandbox: await buildSandbox(),
      });

      const aliceChats = await store.listChats({ userId: 'alice-list' });
      assert.strictEqual(aliceChats.length, 2);
      assert.ok(aliceChats.every((c) => c.userId === 'alice-list'));

      const bobChats = await store.listChats({ userId: 'bob-list' });
      assert.strictEqual(bobChats.length, 1);
      assert.strictEqual(bobChats[0].userId, 'bob-list');
    });

    it('should return empty array for user with no chats', async () => {
      await using container = await testPostgres.database();

      const store = await PostgresContextStore.create({
        pool: container.pool(),
      });
      const noChats = await store.listChats({
        userId: 'nonexistent-user-xyz',
      });
      assert.strictEqual(noChats.length, 0);
    });
  });

  describe('Multi-User Conversations', () => {
    it('should isolate conversation history per user', async () => {
      await using container = await testPostgres.database();

      const store = await PostgresContextStore.create({
        pool: container.pool(),
      });
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
    });

    it('should include userId in ChatInfo when listing', async () => {
      await using container = await testPostgres.database();

      const store = await PostgresContextStore.create({
        pool: container.pool(),
      });
      await new ContextEngine({
        store,
        chatId: 'chatinfo-test',
        userId: 'user-abc-info',
      }).resolve({ renderer, sandbox: await buildSandbox() });

      const chats = await store.listChats({ userId: 'user-abc-info' });
      assert.strictEqual(chats[0].userId, 'user-abc-info');
    });
  });

  describe('Security & Data Integrity', () => {
    it('should handle userId with special characters', async () => {
      await using container = await testPostgres.database();

      const store = await PostgresContextStore.create({
        pool: container.pool(),
      });
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
    });

    it('should handle userId with unicode characters', async () => {
      await using container = await testPostgres.database();

      const store = await PostgresContextStore.create({
        pool: container.pool(),
      });
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
    });
  });

  describe('Edge Cases', () => {
    it('should handle very long userId strings', async () => {
      await using container = await testPostgres.database();

      const store = await PostgresContextStore.create({
        pool: container.pool(),
      });
      const longUserId = 'u'.repeat(200);

      await store.upsertChat({ id: 'long-user-chat', userId: longUserId });

      const chats = await store.listChats({ userId: longUserId });
      assert.strictEqual(chats.length, 1);
      assert.strictEqual(chats[0].userId, longUserId);
    });

    it('should handle pagination correctly with userId filter', async () => {
      await using container = await testPostgres.database();

      const store = await PostgresContextStore.create({
        pool: container.pool(),
      });
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
    });
  });

  describe('Concurrent Operations', () => {
    const users = [
      'conc-user-a',
      'conc-user-b',
      'conc-user-c',
      'conc-user-d',
      'conc-user-e',
    ];

    void it.each(users, (userId) =>
      it(`should give ${userId} its own 5 chats when chats for different users are created concurrently`, async () => {
        await using container = await testPostgres.database();

        const store = await PostgresContextStore.create({
          pool: container.pool(),
        });
        const createPromises = users.flatMap((owner, userIndex) =>
          Array.from({ length: 5 }, (_, i) =>
            store.upsertChat({
              id: `multi-conc-${owner}-${i}`,
              userId: owner,
              title: `Chat ${userIndex}-${i}`,
            }),
          ),
        );

        await Promise.all(createPromises);

        const userChats = await store.listChats({ userId });
        assert.strictEqual(
          userChats.length,
          5,
          `User ${userId} should have 5 chats`,
        );
        assert.ok(userChats.every((c) => c.userId === userId));
      }),
    );
  });
});

describe('Message Upsert', () => {
  it('should update FTS/tsvector index on upsert', async () => {
    await using container = await testPostgres.database();

    const store = await PostgresContextStore.create({
      pool: container.pool(),
    });
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

    results = await store.searchMessages('upsert-fts-chat', 'original');
    assert.strictEqual(results.length, 0);

    results = await store.searchMessages('upsert-fts-chat', 'updated');
    assert.strictEqual(results.length, 1);
  });
});
