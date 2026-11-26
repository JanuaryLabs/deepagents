import { describe, it } from '@zukhruf/parameterized-test';
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
    describe('Delete Chat', () => {
      describe('Basic Deletion', () => {
        it('should delete an existing chat and return true', async () => {
          await using opened = await storeCase.open();
          const { store } = opened;
          const engine = new ContextEngine({
            store,
            chatId: 'chat-to-delete',
            userId: 'alice',
          });
          await engine.resolve({
            renderer,
            sandbox: await buildSandbox(),
          });

          const result = await store.deleteChat('chat-to-delete');

          assert.strictEqual(result, true);
          const chat = await store.getChat('chat-to-delete');
          assert.strictEqual(chat, undefined);
        });

        it('should return false when deleting non-existent chat', async () => {
          await using opened = await storeCase.open();
          const { store } = opened;
          const result = await store.deleteChat('non-existent-chat-12345');

          assert.strictEqual(result, false);
        });

        it('should return false when deleting already-deleted chat', async () => {
          await using opened = await storeCase.open();
          const { store } = opened;
          const engine = new ContextEngine({
            store,
            chatId: 'chat-double-delete',
            userId: 'alice',
          });
          await engine.resolve({
            renderer,
            sandbox: await buildSandbox(),
          });

          const firstResult = await store.deleteChat('chat-double-delete');
          assert.strictEqual(firstResult, true);

          const secondResult = await store.deleteChat('chat-double-delete');
          assert.strictEqual(secondResult, false);
        });
      });

      describe('Cascading Deletes', () => {
        it('should delete all messages when chat is deleted', async () => {
          await using opened = await storeCase.open();
          const { store } = opened;
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
        });

        it('should delete all branches when chat is deleted', async () => {
          await using opened = await storeCase.open();
          const { store } = opened;
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
        });

        it('should delete all checkpoints when chat is deleted', async () => {
          await using opened = await storeCase.open();
          const { store } = opened;
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
        });

        it('should handle chat with multiple branches', async () => {
          await using opened = await storeCase.open();
          const { store } = opened;
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
        });

        it('should handle chat with deep message chains (50+ messages)', async () => {
          await using opened = await storeCase.open();
          const { store } = opened;
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
        });
      });

      describe('User Authorization', () => {
        it('should delete chat when userId matches', async () => {
          await using opened = await storeCase.open();
          const { store } = opened;
          const engine = new ContextEngine({
            store,
            chatId: 'alice-chat-auth',
            userId: 'alice',
          });
          await engine.resolve({
            renderer,
            sandbox: await buildSandbox(),
          });

          const result = await store.deleteChat('alice-chat-auth', {
            userId: 'alice',
          });

          assert.strictEqual(result, true);
          const chat = await store.getChat('alice-chat-auth');
          assert.strictEqual(chat, undefined);
        });

        it('should return false when userId does not match', async () => {
          await using opened = await storeCase.open();
          const { store } = opened;
          const engine = new ContextEngine({
            store,
            chatId: 'alice-only-chat',
            userId: 'alice',
          });
          await engine.resolve({
            renderer,
            sandbox: await buildSandbox(),
          });

          const result = await store.deleteChat('alice-only-chat', {
            userId: 'bob',
          });

          assert.strictEqual(result, false);

          const chat = await store.getChat('alice-only-chat');
          assert.ok(chat);
          assert.strictEqual(chat.userId, 'alice');
        });

        it('should delete any chat when userId not provided (admin mode)', async () => {
          await using opened = await storeCase.open();
          const { store } = opened;
          const engine = new ContextEngine({
            store,
            chatId: 'any-user-chat',
            userId: 'someuser',
          });
          await engine.resolve({
            renderer,
            sandbox: await buildSandbox(),
          });

          const result = await store.deleteChat('any-user-chat');

          assert.strictEqual(result, true);
          const chat = await store.getChat('any-user-chat');
          assert.strictEqual(chat, undefined);
        });

        it('should not delete other users chats', async () => {
          await using opened = await storeCase.open();
          const { store } = opened;
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
        });

        it(`should handle ${storeCase.userIdComparison} userId comparison`, async () => {
          await using opened = await storeCase.open();
          const { store } = opened;
          const chatId = `${storeCase.userIdComparison}-chat`;
          const engine = new ContextEngine({
            store,
            chatId,
            userId: 'Alice',
          });
          await engine.resolve({
            renderer,
            sandbox: await buildSandbox(),
          });

          if (storeCase.userIdComparison === 'case-sensitive') {
            const result1 = await store.deleteChat(chatId, {
              userId: 'alice',
            });
            assert.strictEqual(result1, false);

            const result2 = await store.deleteChat(chatId, {
              userId: 'ALICE',
            });
            assert.strictEqual(result2, false);

            const result3 = await store.deleteChat(chatId, {
              userId: 'Alice',
            });
            assert.strictEqual(result3, true);
          } else {
            const result = await store.deleteChat(chatId, {
              userId: 'alice',
            });
            assert.strictEqual(result, true);
          }
        });
      });

      describe('Edge Cases', () => {
        it('should handle deleting chat with no messages', async () => {
          await using opened = await storeCase.open();
          const { store } = opened;
          const engine = new ContextEngine({
            store,
            chatId: 'empty-chat',
            userId: 'alice',
          });
          await engine.resolve({
            renderer,
            sandbox: await buildSandbox(),
          });

          const result = await store.deleteChat('empty-chat');

          assert.strictEqual(result, true);
          const chat = await store.getChat('empty-chat');
          assert.strictEqual(chat, undefined);
        });
      });

      describe('Concurrent Operations', () => {
        it('should handle concurrent deletion of same chat (one succeeds)', async () => {
          await using opened = await storeCase.open();
          const { store } = opened;
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
        });
      });
    });
  }),
);
