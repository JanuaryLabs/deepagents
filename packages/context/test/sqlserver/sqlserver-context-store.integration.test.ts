import sql from 'mssql';
import assert from 'node:assert';
import { describe, it } from 'node:test';

import { SqlServerContextStore } from '@deepagents/context';
import { waitForFtsReady, withSqlServerContainer } from '@deepagents/test';

/**
 * Integration tests for SQL Server ContextStore.
 *
 * These tests require Docker to be installed and running.
 * Tests are skipped gracefully if Docker is not available.
 */
describe('SQL Server ContextStore Integration', () => {
  // ==========================================================================
  // Chat Operations
  // ==========================================================================

  describe('Chat Operations', () => {
    it('should create a chat with auto timestamps', () =>
      withSqlServerContainer(async (container) => {
        const store = new SqlServerContextStore({
          pool: container.connectionString,
        });
        await store.initialize();
        try {
          const beforeCreate = Date.now();

          await store.createChat({
            id: 'chat-create-1',
            userId: 'user-1',
            title: 'Test Chat',
            metadata: { key: 'value' },
          });

          const chat = await store.getChat('chat-create-1');

          assert.ok(chat);
          assert.strictEqual(chat.id, 'chat-create-1');
          assert.strictEqual(chat.userId, 'user-1');
          assert.strictEqual(chat.title, 'Test Chat');
          assert.deepStrictEqual(chat.metadata, { key: 'value' });
          assert.ok(chat.createdAt >= beforeCreate);
          assert.ok(chat.updatedAt >= beforeCreate);
        } finally {
          await store.close();
        }
      }));

    it('should upsert chat idempotently', () =>
      withSqlServerContainer(async (container) => {
        const store = new SqlServerContextStore({
          pool: container.connectionString,
        });
        await store.initialize();
        try {
          const result1 = await store.upsertChat({
            id: 'chat-upsert-1',
            userId: 'user-1',
            title: 'First Title',
          });

          assert.strictEqual(result1.id, 'chat-upsert-1');
          assert.strictEqual(result1.title, 'First Title');

          // Upsert again - should return existing chat
          const result2 = await store.upsertChat({
            id: 'chat-upsert-1',
            userId: 'user-1',
            title: 'Second Title', // This should NOT update
          });

          assert.strictEqual(result2.id, 'chat-upsert-1');
          assert.strictEqual(result2.title, 'First Title'); // Original title preserved
          assert.strictEqual(result2.createdAt, result1.createdAt);
        } finally {
          await store.close();
        }
      }));

    it('should return undefined for non-existent chat', () =>
      withSqlServerContainer(async (container) => {
        const store = new SqlServerContextStore({
          pool: container.connectionString,
        });
        await store.initialize();
        try {
          const chat = await store.getChat('non-existent-chat');
          assert.strictEqual(chat, undefined);
        } finally {
          await store.close();
        }
      }));

    it('should update chat title and metadata', () =>
      withSqlServerContainer(async (container) => {
        const store = new SqlServerContextStore({
          pool: container.connectionString,
        });
        await store.initialize();
        try {
          await store.createChat({
            id: 'chat-update-1',
            userId: 'user-1',
            title: 'Original Title',
          });

          const original = await store.getChat('chat-update-1');
          assert.ok(original, 'Chat should exist after creation');

          const updated = await store.updateChat('chat-update-1', {
            title: 'Updated Title',
            metadata: { newKey: 'newValue' },
          });

          assert.strictEqual(updated.title, 'Updated Title');
          assert.deepStrictEqual(updated.metadata, { newKey: 'newValue' });
          assert.ok(
            updated.updatedAt >= original.createdAt,
            `updatedAt (${updated.updatedAt}) should be >= createdAt (${original.createdAt})`,
          );
        } finally {
          await store.close();
        }
      }));

    it('should list chats with pagination', () =>
      withSqlServerContainer(async (container) => {
        const store = new SqlServerContextStore({
          pool: container.connectionString,
        });
        await store.initialize();
        try {
          // Create multiple chats
          for (let i = 0; i < 5; i++) {
            await store.createChat({
              id: `chat-list-${i}`,
              userId: 'user-pagination',
            });
          }

          const page1 = await store.listChats({
            userId: 'user-pagination',
            limit: 2,
            offset: 0,
          });
          assert.strictEqual(page1.length, 2);

          const page2 = await store.listChats({
            userId: 'user-pagination',
            limit: 2,
            offset: 2,
          });
          assert.strictEqual(page2.length, 2);

          const page3 = await store.listChats({
            userId: 'user-pagination',
            limit: 2,
            offset: 4,
          });
          assert.strictEqual(page3.length, 1);
        } finally {
          await store.close();
        }
      }));

    it('should list chats filtered by userId', () =>
      withSqlServerContainer(async (container) => {
        const store = new SqlServerContextStore({
          pool: container.connectionString,
        });
        await store.initialize();
        try {
          await store.createChat({ id: 'chat-filter-alice', userId: 'alice' });
          await store.createChat({ id: 'chat-filter-bob', userId: 'bob' });

          const aliceChats = await store.listChats({ userId: 'alice' });
          const bobChats = await store.listChats({ userId: 'bob' });

          assert.ok(aliceChats.some((c) => c.id === 'chat-filter-alice'));
          assert.ok(!aliceChats.some((c) => c.id === 'chat-filter-bob'));
          assert.ok(bobChats.some((c) => c.id === 'chat-filter-bob'));
        } finally {
          await store.close();
        }
      }));

    it('should delete chat and return true', () =>
      withSqlServerContainer(async (container) => {
        const store = new SqlServerContextStore({
          pool: container.connectionString,
        });
        await store.initialize();
        try {
          await store.createChat({ id: 'chat-delete-1', userId: 'user-1' });

          const result = await store.deleteChat('chat-delete-1');
          assert.strictEqual(result, true);

          const chat = await store.getChat('chat-delete-1');
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
        await store.initialize();
        try {
          const result = await store.deleteChat('non-existent');
          assert.strictEqual(result, false);
        } finally {
          await store.close();
        }
      }));

    it('should respect userId constraint on delete', () =>
      withSqlServerContainer(async (container) => {
        const store = new SqlServerContextStore({
          pool: container.connectionString,
        });
        await store.initialize();
        try {
          await store.createChat({ id: 'chat-delete-user', userId: 'owner' });

          // Try to delete with wrong userId
          const wrongResult = await store.deleteChat('chat-delete-user', {
            userId: 'not-owner',
          });
          assert.strictEqual(wrongResult, false);

          // Chat should still exist
          const chat = await store.getChat('chat-delete-user');
          assert.ok(chat);

          // Delete with correct userId
          const correctResult = await store.deleteChat('chat-delete-user', {
            userId: 'owner',
          });
          assert.strictEqual(correctResult, true);
        } finally {
          await store.close();
        }
      }));
  });

  // ==========================================================================
  // Message Operations
  // ==========================================================================

  describe('Message Operations', () => {
    it('should add and retrieve a message', () =>
      withSqlServerContainer(async (container) => {
        const store = new SqlServerContextStore({
          pool: container.connectionString,
        });
        await store.initialize();
        try {
          await store.createChat({ id: 'chat-msg-1', userId: 'user-1' });

          await store.addMessage({
            id: 'msg-1',
            chatId: 'chat-msg-1',
            parentId: null,
            name: 'user',
            type: 'message',
            data: { text: 'Hello, world!' },
            createdAt: Date.now(),
          });

          const message = await store.getMessage('msg-1');

          assert.ok(message);
          assert.strictEqual(message.id, 'msg-1');
          assert.strictEqual(message.chatId, 'chat-msg-1');
          assert.strictEqual(message.parentId, null);
          assert.strictEqual(message.name, 'user');
          assert.deepStrictEqual(message.data, { text: 'Hello, world!' });
        } finally {
          await store.close();
        }
      }));

    it('should return undefined for non-existent message', () =>
      withSqlServerContainer(async (container) => {
        const store = new SqlServerContextStore({
          pool: container.connectionString,
        });
        await store.initialize();
        try {
          const message = await store.getMessage('non-existent-msg');
          assert.strictEqual(message, undefined);
        } finally {
          await store.close();
        }
      }));

    it('should build message chain with parentId linking', () =>
      withSqlServerContainer(async (container) => {
        const store = new SqlServerContextStore({
          pool: container.connectionString,
        });
        await store.initialize();
        try {
          await store.createChat({ id: 'chat-chain-1', userId: 'user-1' });

          const now = Date.now();
          await store.addMessage({
            id: 'chain-msg-1',
            chatId: 'chat-chain-1',
            parentId: null,
            name: 'user',
            data: 'First message',
            createdAt: now,
          });

          await store.addMessage({
            id: 'chain-msg-2',
            chatId: 'chat-chain-1',
            parentId: 'chain-msg-1',
            name: 'assistant',
            data: 'Second message',
            createdAt: now + 1,
          });

          await store.addMessage({
            id: 'chain-msg-3',
            chatId: 'chat-chain-1',
            parentId: 'chain-msg-2',
            name: 'user',
            data: 'Third message',
            createdAt: now + 2,
          });

          const chain = await store.getMessageChain('chain-msg-3');

          assert.strictEqual(chain.length, 3);
          assert.strictEqual(chain[0].id, 'chain-msg-1'); // Root first
          assert.strictEqual(chain[1].id, 'chain-msg-2');
          assert.strictEqual(chain[2].id, 'chain-msg-3'); // Head last
        } finally {
          await store.close();
        }
      }));

    it('should reject self-reference parentId', () =>
      withSqlServerContainer(async (container) => {
        const store = new SqlServerContextStore({
          pool: container.connectionString,
        });
        await store.initialize();
        try {
          await store.createChat({ id: 'chat-self-ref', userId: 'user-1' });

          await assert.rejects(
            async () =>
              store.addMessage({
                id: 'self-ref-msg',
                chatId: 'chat-self-ref',
                parentId: 'self-ref-msg', // Self-reference
                name: 'user',
                data: 'Should fail',
                createdAt: Date.now(),
              }),
            /cannot be its own parent/i,
          );
        } finally {
          await store.close();
        }
      }));

    it('should check if message has children', () =>
      withSqlServerContainer(async (container) => {
        const store = new SqlServerContextStore({
          pool: container.connectionString,
        });
        await store.initialize();
        try {
          await store.createChat({ id: 'chat-children', userId: 'user-1' });

          await store.addMessage({
            id: 'parent-msg',
            chatId: 'chat-children',
            parentId: null,
            name: 'user',
            data: 'Parent',
            createdAt: Date.now(),
          });

          // No children yet
          const hasChildrenBefore = await store.hasChildren('parent-msg');
          assert.strictEqual(hasChildrenBefore, false);

          await store.addMessage({
            id: 'child-msg',
            chatId: 'chat-children',
            parentId: 'parent-msg',
            name: 'assistant',
            data: 'Child',
            createdAt: Date.now(),
          });

          // Now has children
          const hasChildrenAfter = await store.hasChildren('parent-msg');
          assert.strictEqual(hasChildrenAfter, true);
        } finally {
          await store.close();
        }
      }));

    it('should get messages from active branch', () =>
      withSqlServerContainer(async (container) => {
        const store = new SqlServerContextStore({
          pool: container.connectionString,
        });
        await store.initialize();
        try {
          await store.createChat({
            id: 'chat-active-branch',
            userId: 'user-1',
          });

          const branch = await store.getActiveBranch('chat-active-branch');
          assert.ok(branch);

          await store.addMessage({
            id: 'branch-msg-1',
            chatId: 'chat-active-branch',
            parentId: null,
            name: 'user',
            data: 'Message 1',
            createdAt: Date.now(),
          });

          await store.updateBranchHead(branch.id, 'branch-msg-1');

          const messages = await store.getMessages('chat-active-branch');
          assert.strictEqual(messages.length, 1);
          assert.strictEqual(messages[0].id, 'branch-msg-1');
        } finally {
          await store.close();
        }
      }));

    it('should throw error when getting messages for non-existent chat', () =>
      withSqlServerContainer(async (container) => {
        const store = new SqlServerContextStore({
          pool: container.connectionString,
        });
        await store.initialize();
        try {
          await assert.rejects(
            async () => store.getMessages('non-existent-chat'),
            /not found/i,
          );
        } finally {
          await store.close();
        }
      }));
  });

  // ==========================================================================
  // Branch Operations
  // ==========================================================================

  describe('Branch Operations', () => {
    it('should create main branch automatically with chat', () =>
      withSqlServerContainer(async (container) => {
        const store = new SqlServerContextStore({
          pool: container.connectionString,
        });
        await store.initialize();
        try {
          await store.createChat({ id: 'chat-auto-branch', userId: 'user-1' });

          const branch = await store.getBranch('chat-auto-branch', 'main');

          assert.ok(branch);
          assert.strictEqual(branch.name, 'main');
          assert.strictEqual(branch.isActive, true);
          assert.strictEqual(branch.headMessageId, null);
        } finally {
          await store.close();
        }
      }));

    it('should create and retrieve a branch', () =>
      withSqlServerContainer(async (container) => {
        const store = new SqlServerContextStore({
          pool: container.connectionString,
        });
        await store.initialize();
        try {
          await store.createChat({
            id: 'chat-branch-create',
            userId: 'user-1',
          });

          await store.createBranch({
            id: 'branch-1',
            chatId: 'chat-branch-create',
            name: 'feature-branch',
            headMessageId: null,
            isActive: false,
            createdAt: Date.now(),
          });

          const branch = await store.getBranch(
            'chat-branch-create',
            'feature-branch',
          );

          assert.ok(branch);
          assert.strictEqual(branch.name, 'feature-branch');
          assert.strictEqual(branch.isActive, false);
        } finally {
          await store.close();
        }
      }));

    it('should get active branch', () =>
      withSqlServerContainer(async (container) => {
        const store = new SqlServerContextStore({
          pool: container.connectionString,
        });
        await store.initialize();
        try {
          await store.createChat({ id: 'chat-active-get', userId: 'user-1' });

          const activeBranch = await store.getActiveBranch('chat-active-get');

          assert.ok(activeBranch);
          assert.strictEqual(activeBranch.isActive, true);
          assert.strictEqual(activeBranch.name, 'main');
        } finally {
          await store.close();
        }
      }));

    it('should set active branch and deactivate others', () =>
      withSqlServerContainer(async (container) => {
        const store = new SqlServerContextStore({
          pool: container.connectionString,
        });
        await store.initialize();
        try {
          await store.createChat({
            id: 'chat-switch-branch',
            userId: 'user-1',
          });

          // Create a second branch
          await store.createBranch({
            id: 'branch-alt',
            chatId: 'chat-switch-branch',
            name: 'alt-branch',
            headMessageId: null,
            isActive: false,
            createdAt: Date.now(),
          });

          // Switch to alt-branch
          await store.setActiveBranch('chat-switch-branch', 'branch-alt');

          const mainBranch = await store.getBranch(
            'chat-switch-branch',
            'main',
          );
          const altBranch = await store.getBranch(
            'chat-switch-branch',
            'alt-branch',
          );

          assert.strictEqual(mainBranch?.isActive, false);
          assert.strictEqual(altBranch?.isActive, true);
        } finally {
          await store.close();
        }
      }));

    it('should update branch head', () =>
      withSqlServerContainer(async (container) => {
        const store = new SqlServerContextStore({
          pool: container.connectionString,
        });
        await store.initialize();
        try {
          await store.createChat({ id: 'chat-head-update', userId: 'user-1' });

          await store.addMessage({
            id: 'head-msg-1',
            chatId: 'chat-head-update',
            parentId: null,
            name: 'user',
            data: 'Message',
            createdAt: Date.now(),
          });

          const branch = await store.getActiveBranch('chat-head-update');
          assert.ok(branch);

          await store.updateBranchHead(branch.id, 'head-msg-1');

          const updatedBranch = await store.getActiveBranch('chat-head-update');
          assert.strictEqual(updatedBranch?.headMessageId, 'head-msg-1');
        } finally {
          await store.close();
        }
      }));

    it('should list branches with message counts', () =>
      withSqlServerContainer(async (container) => {
        const store = new SqlServerContextStore({
          pool: container.connectionString,
        });
        await store.initialize();
        try {
          await store.createChat({
            id: 'chat-list-branches',
            userId: 'user-1',
          });

          // Add messages to main branch
          await store.addMessage({
            id: 'list-msg-1',
            chatId: 'chat-list-branches',
            parentId: null,
            name: 'user',
            data: 'Message 1',
            createdAt: Date.now(),
          });

          await store.addMessage({
            id: 'list-msg-2',
            chatId: 'chat-list-branches',
            parentId: 'list-msg-1',
            name: 'assistant',
            data: 'Message 2',
            createdAt: Date.now(),
          });

          const mainBranch = await store.getActiveBranch('chat-list-branches');
          assert.ok(mainBranch);
          await store.updateBranchHead(mainBranch.id, 'list-msg-2');

          // Create another branch with no messages
          await store.createBranch({
            id: 'empty-branch',
            chatId: 'chat-list-branches',
            name: 'empty',
            headMessageId: null,
            isActive: false,
            createdAt: Date.now(),
          });

          const branches = await store.listBranches('chat-list-branches');

          assert.strictEqual(branches.length, 2);

          const main = branches.find((b) => b.name === 'main');
          const empty = branches.find((b) => b.name === 'empty');

          assert.strictEqual(main?.messageCount, 2);
          assert.strictEqual(empty?.messageCount, 0);
        } finally {
          await store.close();
        }
      }));
  });

  // ==========================================================================
  // Checkpoint Operations
  // ==========================================================================

  describe('Checkpoint Operations', () => {
    it('should create and retrieve a checkpoint', () =>
      withSqlServerContainer(async (container) => {
        const store = new SqlServerContextStore({
          pool: container.connectionString,
        });
        await store.initialize();
        try {
          await store.createChat({ id: 'chat-checkpoint-1', userId: 'user-1' });

          await store.addMessage({
            id: 'checkpoint-msg-1',
            chatId: 'chat-checkpoint-1',
            parentId: null,
            name: 'user',
            data: 'Message',
            createdAt: Date.now(),
          });

          await store.createCheckpoint({
            id: 'cp-1',
            chatId: 'chat-checkpoint-1',
            name: 'before-change',
            messageId: 'checkpoint-msg-1',
            createdAt: Date.now(),
          });

          const checkpoint = await store.getCheckpoint(
            'chat-checkpoint-1',
            'before-change',
          );

          assert.ok(checkpoint);
          assert.strictEqual(checkpoint.name, 'before-change');
          assert.strictEqual(checkpoint.messageId, 'checkpoint-msg-1');
        } finally {
          await store.close();
        }
      }));

    it('should return undefined for non-existent checkpoint', () =>
      withSqlServerContainer(async (container) => {
        const store = new SqlServerContextStore({
          pool: container.connectionString,
        });
        await store.initialize();
        try {
          await store.createChat({
            id: 'chat-no-checkpoint',
            userId: 'user-1',
          });

          const checkpoint = await store.getCheckpoint(
            'chat-no-checkpoint',
            'non-existent',
          );
          assert.strictEqual(checkpoint, undefined);
        } finally {
          await store.close();
        }
      }));

    it('should upsert checkpoint on conflict', () =>
      withSqlServerContainer(async (container) => {
        const store = new SqlServerContextStore({
          pool: container.connectionString,
        });
        await store.initialize();
        try {
          await store.createChat({
            id: 'chat-checkpoint-upsert',
            userId: 'user-1',
          });

          await store.addMessage({
            id: 'upsert-msg-1',
            chatId: 'chat-checkpoint-upsert',
            parentId: null,
            name: 'user',
            data: 'First',
            createdAt: Date.now(),
          });

          await store.addMessage({
            id: 'upsert-msg-2',
            chatId: 'chat-checkpoint-upsert',
            parentId: 'upsert-msg-1',
            name: 'user',
            data: 'Second',
            createdAt: Date.now(),
          });

          // Create checkpoint pointing to first message
          await store.createCheckpoint({
            id: 'cp-upsert-1',
            chatId: 'chat-checkpoint-upsert',
            name: 'my-checkpoint',
            messageId: 'upsert-msg-1',
            createdAt: Date.now(),
          });

          // Upsert with same name but different messageId
          await store.createCheckpoint({
            id: 'cp-upsert-2',
            chatId: 'chat-checkpoint-upsert',
            name: 'my-checkpoint',
            messageId: 'upsert-msg-2',
            createdAt: Date.now(),
          });

          const checkpoint = await store.getCheckpoint(
            'chat-checkpoint-upsert',
            'my-checkpoint',
          );

          assert.strictEqual(checkpoint?.messageId, 'upsert-msg-2');
        } finally {
          await store.close();
        }
      }));

    it('should list checkpoints ordered by createdAt descending', () =>
      withSqlServerContainer(async (container) => {
        const store = new SqlServerContextStore({
          pool: container.connectionString,
        });
        await store.initialize();
        try {
          await store.createChat({
            id: 'chat-list-checkpoints',
            userId: 'user-1',
          });

          await store.addMessage({
            id: 'list-cp-msg',
            chatId: 'chat-list-checkpoints',
            parentId: null,
            name: 'user',
            data: 'Message',
            createdAt: Date.now(),
          });

          const now = Date.now();

          await store.createCheckpoint({
            id: 'cp-list-1',
            chatId: 'chat-list-checkpoints',
            name: 'first',
            messageId: 'list-cp-msg',
            createdAt: now,
          });

          await store.createCheckpoint({
            id: 'cp-list-2',
            chatId: 'chat-list-checkpoints',
            name: 'second',
            messageId: 'list-cp-msg',
            createdAt: now + 1000,
          });

          await store.createCheckpoint({
            id: 'cp-list-3',
            chatId: 'chat-list-checkpoints',
            name: 'third',
            messageId: 'list-cp-msg',
            createdAt: now + 2000,
          });

          const checkpoints = await store.listCheckpoints(
            'chat-list-checkpoints',
          );

          assert.strictEqual(checkpoints.length, 3);
          assert.strictEqual(checkpoints[0].name, 'third'); // Most recent first
          assert.strictEqual(checkpoints[1].name, 'second');
          assert.strictEqual(checkpoints[2].name, 'first');
        } finally {
          await store.close();
        }
      }));

    it('should delete a checkpoint', () =>
      withSqlServerContainer(async (container) => {
        const store = new SqlServerContextStore({
          pool: container.connectionString,
        });
        await store.initialize();
        try {
          await store.createChat({
            id: 'chat-delete-checkpoint',
            userId: 'user-1',
          });

          await store.addMessage({
            id: 'delete-cp-msg',
            chatId: 'chat-delete-checkpoint',
            parentId: null,
            name: 'user',
            data: 'Message',
            createdAt: Date.now(),
          });

          await store.createCheckpoint({
            id: 'cp-to-delete',
            chatId: 'chat-delete-checkpoint',
            name: 'temp-checkpoint',
            messageId: 'delete-cp-msg',
            createdAt: Date.now(),
          });

          await store.deleteCheckpoint(
            'chat-delete-checkpoint',
            'temp-checkpoint',
          );

          const checkpoint = await store.getCheckpoint(
            'chat-delete-checkpoint',
            'temp-checkpoint',
          );
          assert.strictEqual(checkpoint, undefined);
        } finally {
          await store.close();
        }
      }));
  });

  // ==========================================================================
  // Search Operations (CONTAINSTABLE)
  // ==========================================================================

  describe('Search Operations', () => {
    it('should search messages by keyword', () =>
      withSqlServerContainer(async (container) => {
        const store = new SqlServerContextStore({
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

          // Wait for full-text index to populate (SQL Server FTS is async)
          await waitForFtsReady(container.connectionString);

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

    it('should return ranked results', () =>
      withSqlServerContainer(async (container) => {
        const store = new SqlServerContextStore({
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

          // Wait for full-text index to populate (SQL Server FTS is async)
          await waitForFtsReady(container.connectionString);

          const results = await store.searchMessages('chat-rank', 'settings');

          assert.ok(results.length > 0);

          // Results should have a rank
          assert.ok(results.every((r) => typeof r.rank === 'number'));
        } finally {
          await store.close();
        }
      }));

    it('should return snippets', () =>
      withSqlServerContainer(async (container) => {
        const store = new SqlServerContextStore({
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

          // Wait for full-text index to populate (SQL Server FTS is async)
          await waitForFtsReady(container.connectionString);

          const results = await store.searchMessages(
            'chat-snippet',
            'configure',
          );

          assert.ok(results.length > 0);
          assert.ok(results[0].snippet);
        } finally {
          await store.close();
        }
      }));

    it('should filter by roles', () =>
      withSqlServerContainer(async (container) => {
        const store = new SqlServerContextStore({
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

          // Wait for full-text index to populate (SQL Server FTS is async)
          await waitForFtsReady(container.connectionString);

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
      withSqlServerContainer(async (container) => {
        const store = new SqlServerContextStore({
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

          // Wait for full-text index to populate (SQL Server FTS is async)
          await waitForFtsReady(container.connectionString);

          const results = await store.searchMessages('chat-limit', 'quick', {
            limit: 2,
          });

          assert.ok(results.length <= 2);
        } finally {
          await store.close();
        }
      }));

    it('should return empty array for no matches', () =>
      withSqlServerContainer(async (container) => {
        const store = new SqlServerContextStore({
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

  // ==========================================================================
  // Graph Visualization
  // ==========================================================================

  describe('Graph Visualization', () => {
    it('should return complete graph data', () =>
      withSqlServerContainer(async (container) => {
        const store = new SqlServerContextStore({
          pool: container.connectionString,
        });
        await store.initialize();
        try {
          await store.createChat({ id: 'chat-graph', userId: 'user-1' });

          // Add messages
          await store.addMessage({
            id: 'graph-msg-1',
            chatId: 'chat-graph',
            parentId: null,
            name: 'user',
            data: 'First message',
            createdAt: Date.now(),
          });

          await store.addMessage({
            id: 'graph-msg-2',
            chatId: 'chat-graph',
            parentId: 'graph-msg-1',
            name: 'assistant',
            data: 'Second message',
            createdAt: Date.now(),
          });

          // Update branch head
          const branch = await store.getActiveBranch('chat-graph');
          await store.updateBranchHead(branch!.id, 'graph-msg-2');

          // Add checkpoint
          await store.createCheckpoint({
            id: 'graph-cp-1',
            chatId: 'chat-graph',
            name: 'checkpoint-1',
            messageId: 'graph-msg-1',
            createdAt: Date.now(),
          });

          const graph = await store.getGraph('chat-graph');

          assert.strictEqual(graph.chatId, 'chat-graph');
          assert.strictEqual(graph.nodes.length, 2);
          assert.strictEqual(graph.branches.length, 1);
          assert.strictEqual(graph.checkpoints.length, 1);

          // Check node structure
          const node1 = graph.nodes.find((n) => n.id === 'graph-msg-1');
          assert.ok(node1);
          assert.strictEqual(node1.role, 'user');
          assert.strictEqual(node1.parentId, null);

          const node2 = graph.nodes.find((n) => n.id === 'graph-msg-2');
          assert.ok(node2);
          assert.strictEqual(node2.parentId, 'graph-msg-1');

          // Check branch structure
          assert.strictEqual(graph.branches[0].name, 'main');
          assert.strictEqual(graph.branches[0].isActive, true);

          // Check checkpoint structure
          assert.strictEqual(graph.checkpoints[0].name, 'checkpoint-1');
          assert.strictEqual(graph.checkpoints[0].messageId, 'graph-msg-1');
        } finally {
          await store.close();
        }
      }));

    it('should truncate long content in graph nodes', () =>
      withSqlServerContainer(async (container) => {
        const store = new SqlServerContextStore({
          pool: container.connectionString,
        });
        await store.initialize();
        try {
          await store.createChat({ id: 'chat-graph-long', userId: 'user-1' });

          const longContent = 'A'.repeat(100);

          await store.addMessage({
            id: 'graph-long-msg',
            chatId: 'chat-graph-long',
            parentId: null,
            name: 'user',
            data: longContent,
            createdAt: Date.now(),
          });

          const graph = await store.getGraph('chat-graph-long');
          const node = graph.nodes[0];

          assert.ok(node.content.length <= 53); // 50 chars + "..."
          assert.ok(node.content.endsWith('...'));
        } finally {
          await store.close();
        }
      }));
  });

  // ==========================================================================
  // SQL Server-Specific Tests
  // ==========================================================================

  describe('SQL Server-Specific', () => {
    describe('NVARCHAR(MAX) JSON Metadata', () => {
      it('should store and retrieve complex nested metadata', () =>
        withSqlServerContainer(async (container) => {
          const store = new SqlServerContextStore({
            pool: container.connectionString,
          });
          await store.initialize();
          try {
            const metadata = {
              nested: { deep: { value: 123 } },
              array: [1, 2, 3],
              boolean: true,
              nullValue: null,
            };

            await store.createChat({
              id: 'chat-json-nested',
              userId: 'user-1',
              metadata,
            });

            const chat = await store.getChat('chat-json-nested');
            assert.deepStrictEqual(chat?.metadata, metadata);
          } finally {
            await store.close();
          }
        }));
    });

    describe('BIT to Boolean Conversion', () => {
      it('should return native boolean for isActive', () =>
        withSqlServerContainer(async (container) => {
          const store = new SqlServerContextStore({
            pool: container.connectionString,
          });
          await store.initialize();
          try {
            await store.createChat({ id: 'chat-bit-test', userId: 'user-1' });

            const branch = await store.getActiveBranch('chat-bit-test');

            assert.strictEqual(typeof branch?.isActive, 'boolean');
            assert.strictEqual(branch?.isActive, true);
          } finally {
            await store.close();
          }
        }));

      it('should return native boolean for hasChildren', () =>
        withSqlServerContainer(async (container) => {
          const store = new SqlServerContextStore({
            pool: container.connectionString,
          });
          await store.initialize();
          try {
            await store.createChat({
              id: 'chat-bit-children',
              userId: 'user-1',
            });

            await store.addMessage({
              id: 'bit-parent',
              chatId: 'chat-bit-children',
              parentId: null,
              name: 'user',
              data: 'Parent',
              createdAt: Date.now(),
            });

            const hasChildren = await store.hasChildren('bit-parent');

            assert.strictEqual(typeof hasChildren, 'boolean');
            assert.strictEqual(hasChildren, false);
          } finally {
            await store.close();
          }
        }));
    });

    describe('Connection Pool', () => {
      it('should handle concurrent operations', () =>
        withSqlServerContainer(async (container) => {
          const store = new SqlServerContextStore({
            pool: container.connectionString,
          });
          await store.initialize();
          try {
            await store.createChat({ id: 'chat-concurrent', userId: 'user-1' });

            // Run multiple operations concurrently
            const operations = Array.from({ length: 10 }, (_, i) =>
              store.addMessage({
                id: `concurrent-msg-${i}`,
                chatId: 'chat-concurrent',
                parentId: null,
                name: 'user',
                data: `Message ${i}`,
                createdAt: Date.now() + i,
              }),
            );

            await Promise.all(operations);

            // Verify all messages were created
            for (let i = 0; i < 10; i++) {
              const msg = await store.getMessage(`concurrent-msg-${i}`);
              assert.ok(msg);
            }
          } finally {
            await store.close();
          }
        }));
    });

    describe('Cascade Delete', () => {
      it('should cascade delete messages when chat is deleted', () =>
        withSqlServerContainer(async (container) => {
          const store = new SqlServerContextStore({
            pool: container.connectionString,
          });
          await store.initialize();
          try {
            await store.createChat({ id: 'chat-cascade', userId: 'user-1' });

            await store.addMessage({
              id: 'cascade-msg',
              chatId: 'chat-cascade',
              parentId: null,
              name: 'user',
              data: 'Message',
              createdAt: Date.now(),
            });

            // Verify message exists
            const msgBefore = await store.getMessage('cascade-msg');
            assert.ok(msgBefore);

            // Delete chat
            await store.deleteChat('chat-cascade');

            // Message should be cascade deleted
            const msgAfter = await store.getMessage('cascade-msg');
            assert.strictEqual(msgAfter, undefined);
          } finally {
            await store.close();
          }
        }));
    });
  });

  // ==========================================================================
  // Pool Injection
  // ==========================================================================

  describe('Pool Injection', () => {
    it('should accept a pre-existing connected ConnectionPool', () =>
      withSqlServerContainer(async (container) => {
        const pool = new sql.ConnectionPool(container.connectionString);
        await pool.connect();
        try {
          const store = new SqlServerContextStore({ pool });
          await store.initialize();
          try {
            await store.createChat({
              id: 'chat-pool-inject',
              userId: 'user-1',
              title: 'Pool Injection Test',
            });

            const chat = await store.getChat('chat-pool-inject');
            assert.ok(chat);
            assert.strictEqual(chat.id, 'chat-pool-inject');
          } finally {
            await store.close();
          }

          assert.strictEqual(pool.connected, true);
        } finally {
          await pool.close();
        }
      }));

    it('should not close external pool on store.close()', () =>
      withSqlServerContainer(async (container) => {
        const pool = new sql.ConnectionPool(container.connectionString);
        await pool.connect();
        try {
          const store = new SqlServerContextStore({ pool });
          await store.initialize();
          await store.createChat({
            id: 'chat-no-close',
            userId: 'user-1',
          });

          await store.close();

          assert.strictEqual(pool.connected, true);

          const request = pool.request();
          const result = await request.query('SELECT 1 AS val');
          assert.strictEqual(result.recordset[0].val, 1);
        } finally {
          await pool.close();
        }
      }));

    it('should allow two store instances to share the same pool', () =>
      withSqlServerContainer(async (container) => {
        const pool = new sql.ConnectionPool(container.connectionString);
        await pool.connect();
        try {
          const store1 = new SqlServerContextStore({ pool });
          await store1.initialize();
          const store2 = new SqlServerContextStore({ pool });
          await store2.initialize();

          await store1.createChat({
            id: 'chat-shared-1',
            userId: 'user-1',
          });

          const chat = await store2.getChat('chat-shared-1');
          assert.ok(chat);
          assert.strictEqual(chat.id, 'chat-shared-1');

          await store1.close();
          await store2.close();

          assert.strictEqual(pool.connected, true);
        } finally {
          await pool.close();
        }
      }));
  });

  // ==========================================================================
  // Schema Support
  // ==========================================================================

  describe('Schema Support', () => {
    it('should create tables in a custom schema', () =>
      withSqlServerContainer(async (container) => {
        const store = new SqlServerContextStore({
          pool: container.connectionString,
          schema: 'custom_schema',
        });
        await store.initialize();
        try {
          await store.createChat({
            id: 'chat-custom-schema',
            userId: 'user-1',
            title: 'Custom Schema Chat',
          });

          const chat = await store.getChat('chat-custom-schema');
          assert.ok(chat);
          assert.strictEqual(chat.title, 'Custom Schema Chat');

          const pool = new sql.ConnectionPool(container.connectionString);
          await pool.connect();
          try {
            const result = await pool.request().query(`
              SELECT TABLE_SCHEMA, TABLE_NAME
              FROM INFORMATION_SCHEMA.TABLES
              WHERE TABLE_SCHEMA = 'custom_schema'
            `);
            assert.ok(result.recordset.length > 0);
            assert.ok(
              result.recordset.every(
                (r: { TABLE_SCHEMA: string }) =>
                  r.TABLE_SCHEMA === 'custom_schema',
              ),
            );
          } finally {
            await pool.close();
          }
        } finally {
          await store.close();
        }
      }));

    it('should isolate two stores with different schemas', async () =>
      await withSqlServerContainer(async (container) => {
        const storeA = new SqlServerContextStore({
          pool: container.connectionString,
          schema: 'schema_a',
        });
        await storeA.initialize();
        const storeB = new SqlServerContextStore({
          pool: container.connectionString,
          schema: 'schema_b',
        });
        await storeB.initialize();

        try {
          await storeA.createChat({
            id: 'chat-iso',
            userId: 'user-1',
            title: 'Schema A Chat',
          });

          await storeB.createChat({
            id: 'chat-iso',
            userId: 'user-1',
            title: 'Schema B Chat',
          });

          const chatA = await storeA.getChat('chat-iso');
          const chatB = await storeB.getChat('chat-iso');

          assert.ok(chatA);
          assert.ok(chatB);
          assert.strictEqual(chatA.title, 'Schema A Chat');
          assert.strictEqual(chatB.title, 'Schema B Chat');
        } finally {
          await storeA.close();
          await storeB.close();
        }
      }));

    it('should create schema in sys.schemas', async () =>
      await withSqlServerContainer(async (container) => {
        const store = new SqlServerContextStore({
          pool: container.connectionString,
          schema: 'ddl_created_schema',
        });
        await store.initialize();
        try {
          const pool = new sql.ConnectionPool(container.connectionString);
          await pool.connect();
          try {
            const result = await pool.request().query(`
              SELECT name FROM sys.schemas WHERE name = 'ddl_created_schema'
            `);
            assert.strictEqual(result.recordset.length, 1);
            assert.strictEqual(result.recordset[0].name, 'ddl_created_schema');
          } finally {
            await pool.close();
          }
        } finally {
          await store.close();
        }
      }));

    it('should handle idempotent initialization', async () =>
      await withSqlServerContainer(async (container) => {
        const store = new SqlServerContextStore({
          pool: container.connectionString,
          schema: 'idempotent_schema',
        });
        await store.initialize();
        await store.initialize();
        try {
          const chat = await store.createChat({ id: 'c1', userId: 'u1' });
          assert.ok(chat);
        } finally {
          await store.close();
        }
      }));
  });
});
