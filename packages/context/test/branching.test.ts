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

describe('Branching', () => {
  describe('Basic Branch Creation', () => {
    it('should create "main" branch by default', async () => {
      const store = new InMemoryContextStore();
      const engine = new ContextEngine({
        userId: 'test-user',
        store,
        chatId: 'test-branch-1',
      });

      // Trigger initialization
      await engine.resolve({ renderer });

      // Verify branch was created
      const branches = await store.listBranches('test-branch-1');
      assert.strictEqual(branches.length, 1);
      assert.strictEqual(branches[0].name, 'main');
      assert.strictEqual(branches[0].isActive, true);
      assert.strictEqual(branches[0].headMessageId, null);
    });

    it('should expose branch name via getter (defaults to main)', async () => {
      const store = new InMemoryContextStore();
      const engine = new ContextEngine({
        userId: 'test-user',
        store,
        chatId: 'test-branch-2',
      });

      // Default branch is always 'main'
      assert.strictEqual(engine.branch, 'main');
    });
  });

  describe('Message Chain (parentId linking)', () => {
    it('should set parentId to null for first message', async () => {
      const store = new InMemoryContextStore();
      const engine = new ContextEngine({
        userId: 'test-user',
        store,
        chatId: 'test-chain-1',
      });

      engine.set(
        user({
          id: 'msg-1',
          role: 'user',
          parts: [{ type: 'text', text: 'Hello' }],
        }),
      );
      await engine.save();

      const msg = await store.getMessage('msg-1');
      assert.ok(msg);
      assert.strictEqual(msg.parentId, null);
    });

    it('should link subsequent messages via parentId', async () => {
      const store = new InMemoryContextStore();
      const engine = new ContextEngine({
        userId: 'test-user',
        store,
        chatId: 'test-chain-2',
      });

      engine.set(
        user({
          id: 'msg-1',
          role: 'user',
          parts: [{ type: 'text', text: 'Hello' }],
        }),
      );
      engine.set(assistantText('Hi!', { id: 'msg-2' }));
      engine.set(
        user({
          id: 'msg-3',
          role: 'user',
          parts: [{ type: 'text', text: 'How are you?' }],
        }),
      );
      await engine.save();

      const msg1 = await store.getMessage('msg-1');
      const msg2 = await store.getMessage('msg-2');
      const msg3 = await store.getMessage('msg-3');

      assert.strictEqual(msg1!.parentId, null);
      assert.strictEqual(msg2!.parentId, 'msg-1');
      assert.strictEqual(msg3!.parentId, 'msg-2');
    });

    it('should update branch headMessageId after save', async () => {
      const store = new InMemoryContextStore();
      const engine = new ContextEngine({
        userId: 'test-user',
        store,
        chatId: 'test-chain-3',
      });

      engine.set(
        user({
          id: 'msg-1',
          role: 'user',
          parts: [{ type: 'text', text: 'Hello' }],
        }),
      );
      engine.set(assistantText('Hi!', { id: 'msg-2' }));
      await engine.save();

      const branch = await store.getBranch('test-chain-3', 'main');
      assert.strictEqual(branch!.headMessageId, 'msg-2');
    });

    it('should return messages in correct order (root to head)', async () => {
      const store = new InMemoryContextStore();
      const engine = new ContextEngine({
        userId: 'test-user',
        store,
        chatId: 'test-chain-4',
      });

      engine.set(user('First'));
      engine.set(assistantText('Second'));
      engine.set(user('Third'));
      await engine.save();

      const { messages } = await engine.resolve({ renderer });

      assert.strictEqual(messages.length, 3);
      // resolve() returns decoded UIMessage objects
      assert.deepStrictEqual(
        messages.map((m: any) => m.parts[0].text),
        ['First', 'Second', 'Third'],
      );
    });
  });

  describe('Rewind (Forking)', () => {
    it('should create new branch pointing to rewind message', async () => {
      const store = new InMemoryContextStore();
      const engine = new ContextEngine({
        userId: 'test-user',
        store,
        chatId: 'test-rewind-1',
      });

      engine.set(
        user({
          id: 'msg-1',
          role: 'user',
          parts: [{ type: 'text', text: 'Hello' }],
        }),
      );
      engine.set(assistantText('Hi!', { id: 'msg-2' }));
      engine.set(
        user({
          id: 'msg-3',
          role: 'user',
          parts: [{ type: 'text', text: 'Wrong path' }],
        }),
      );
      await engine.save();

      // Rewind to msg-2
      const newBranch = await engine.rewind('msg-2');

      assert.ok(newBranch.name.includes('main-v'));
      assert.strictEqual(newBranch.headMessageId, 'msg-2');
      assert.strictEqual(newBranch.isActive, true);
    });

    it('should deactivate old branch after rewind', async () => {
      const store = new InMemoryContextStore();
      const engine = new ContextEngine({
        userId: 'test-user',
        store,
        chatId: 'test-rewind-2',
      });

      engine.set(
        user({
          id: 'msg-1',
          role: 'user',
          parts: [{ type: 'text', text: 'Hello' }],
        }),
      );
      engine.set(assistantText('Hi!', { id: 'msg-2' }));
      await engine.save();

      await engine.rewind('msg-1');

      const branches = await store.listBranches('test-rewind-2');
      const mainBranch = branches.find((b) => b.name === 'main');
      const newBranch = branches.find((b) => b.name !== 'main');

      assert.strictEqual(mainBranch!.isActive, false);
      assert.strictEqual(newBranch!.isActive, true);
    });

    it('should preserve original messages after rewind', async () => {
      const store = new InMemoryContextStore();
      const engine = new ContextEngine({
        userId: 'test-user',
        store,
        chatId: 'test-rewind-3',
      });

      engine.set(
        user({
          id: 'msg-1',
          role: 'user',
          parts: [{ type: 'text', text: 'Hello' }],
        }),
      );
      engine.set(assistantText('Original response', { id: 'msg-2' }));
      await engine.save();

      await engine.rewind('msg-1');

      // Original messages should still exist
      const msg1 = await store.getMessage('msg-1');
      const msg2 = await store.getMessage('msg-2');

      assert.ok(msg1);
      assert.ok(msg2);
      // Assistant messages store UIMessage object in data
      assert.strictEqual(
        (msg2!.data as any).parts[0].text,
        'Original response',
      );
    });

    it('should link new messages to fork point after rewind', async () => {
      const store = new InMemoryContextStore();
      const engine = new ContextEngine({
        userId: 'test-user',
        store,
        chatId: 'test-rewind-4',
      });

      engine.set(
        user({
          id: 'msg-1',
          role: 'user',
          parts: [{ type: 'text', text: 'Hello' }],
        }),
      );
      engine.set(assistantText('Original', { id: 'msg-2' }));
      await engine.save();

      // Rewind to msg-1 (before the assistant response)
      await engine.rewind('msg-1');

      // Add new response on forked branch
      engine.set(assistantText('Better response', { id: 'msg-3' }));
      await engine.save();

      const msg3 = await store.getMessage('msg-3');

      // msg-3 should be child of msg-1, NOT msg-2
      assert.strictEqual(msg3!.parentId, 'msg-1');
    });

    it('should update engine branch name after rewind', async () => {
      const store = new InMemoryContextStore();
      const engine = new ContextEngine({
        userId: 'test-user',
        store,
        chatId: 'test-rewind-5',
      });

      engine.set(
        user({
          id: 'msg-1',
          role: 'user',
          parts: [{ type: 'text', text: 'Hello' }],
        }),
      );
      await engine.save();

      assert.strictEqual(engine.branch, 'main');

      await engine.rewind('msg-1');

      assert.ok(engine.branch.startsWith('main-v'));
    });

    it('should clear pending messages after rewind', async () => {
      const store = new InMemoryContextStore();
      const engine = new ContextEngine({
        userId: 'test-user',
        store,
        chatId: 'test-rewind-6',
      });

      engine.set(
        user({
          id: 'msg-1',
          role: 'user',
          parts: [{ type: 'text', text: 'Hello' }],
        }),
      );
      await engine.save();

      // Add pending message
      engine.set(assistantText('Pending'));

      // Rewind should clear pending
      await engine.rewind('msg-1');

      const { messages } = await engine.resolve({ renderer });
      assert.strictEqual(messages.length, 1); // Only msg-1
    });
  });

  describe('Switch Branch', () => {
    it('should switch active branch', async () => {
      const store = new InMemoryContextStore();
      const engine = new ContextEngine({
        userId: 'test-user',
        store,
        chatId: 'test-switch-1',
      });

      engine.set(
        user({
          id: 'msg-1',
          role: 'user',
          parts: [{ type: 'text', text: 'Hello' }],
        }),
      );
      engine.set(assistantText('Hi!', { id: 'msg-2' }));
      await engine.save();

      // Create a fork
      await engine.rewind('msg-1');

      // Switch back to main
      await engine.switchBranch('main');

      assert.strictEqual(engine.branch, 'main');

      const branch = await store.getBranch('test-switch-1', 'main');
      assert.strictEqual(branch!.isActive, true);
    });

    it('should return different message chains per branch', async () => {
      const store = new InMemoryContextStore();
      const engine = new ContextEngine({
        userId: 'test-user',
        store,
        chatId: 'test-switch-2',
      });

      // Build main branch
      engine.set(
        user({
          id: 'msg-1',
          role: 'user',
          parts: [{ type: 'text', text: 'Hello' }],
        }),
      );
      engine.set(assistantText('Response A', { id: 'msg-2' }));
      await engine.save();

      // Fork and add different response
      await engine.rewind('msg-1');
      engine.set(assistantText('Response B', { id: 'msg-3' }));
      await engine.save();

      // Get messages from forked branch
      const { messages: forkedMessages } = await engine.resolve({ renderer });
      assert.strictEqual(forkedMessages.length, 2);
      assert.strictEqual(
        (forkedMessages[1] as any).parts[0].text,
        'Response B',
      );

      // Switch to main and get its messages
      await engine.switchBranch('main');
      const { messages: mainMessages } = await engine.resolve({ renderer });
      assert.strictEqual(mainMessages.length, 2);
      assert.strictEqual((mainMessages[1] as any).parts[0].text, 'Response A');
    });

    it('should throw when switching to non-existent branch', async () => {
      const store = new InMemoryContextStore();
      const engine = new ContextEngine({
        userId: 'test-user',
        store,
        chatId: 'test-switch-3',
      });

      await engine.resolve({ renderer }); // Initialize

      await assert.rejects(async () => {
        await engine.switchBranch('nonexistent');
      }, /not found/i);
    });
  });

  describe('Multiple Branches', () => {
    it('should support multiple branches in one chat', async () => {
      const store = new InMemoryContextStore();
      const engine = new ContextEngine({
        userId: 'test-user',
        store,
        chatId: 'test-multi-1',
      });

      engine.set(
        user({
          id: 'msg-1',
          role: 'user',
          parts: [{ type: 'text', text: 'Start' }],
        }),
      );
      await engine.save();

      // Create multiple forks
      await engine.rewind('msg-1'); // main-v2
      engine.set(assistantText('Path A'));
      await engine.save();

      await engine.rewind('msg-1'); // main-v3
      engine.set(assistantText('Path B'));
      await engine.save();

      await engine.rewind('msg-1'); // main-v4
      engine.set(assistantText('Path C'));
      await engine.save();

      const branches = await store.listBranches('test-multi-1');
      assert.strictEqual(branches.length, 4); // main + 3 forks
    });

    it('should maintain independent headMessageId per branch', async () => {
      const store = new InMemoryContextStore();
      const engine = new ContextEngine({
        userId: 'test-user',
        store,
        chatId: 'test-multi-2',
      });

      engine.set(
        user({
          id: 'root',
          role: 'user',
          parts: [{ type: 'text', text: 'Root' }],
        }),
      );
      await engine.save();

      // Fork and extend
      await engine.rewind('root');
      engine.set(assistantText('Branch 2 response', { id: 'b2-msg' }));
      await engine.save();

      const branches = await store.listBranches('test-multi-2');
      const mainBranch = branches.find((b) => b.name === 'main');
      const forkBranch = branches.find((b) => b.name !== 'main');

      assert.strictEqual(mainBranch!.headMessageId, 'root');
      assert.strictEqual(forkBranch!.headMessageId, 'b2-msg');
    });

    it('should have only one active branch at a time', async () => {
      const store = new InMemoryContextStore();
      const engine = new ContextEngine({
        userId: 'test-user',
        store,
        chatId: 'test-multi-3',
      });

      engine.set(
        user({
          id: 'msg-1',
          role: 'user',
          parts: [{ type: 'text', text: 'Start' }],
        }),
      );
      await engine.save();

      // Create forks
      await engine.rewind('msg-1');
      await engine.rewind('msg-1');
      await engine.rewind('msg-1');

      const branches = await store.listBranches('test-multi-3');
      const activeBranches = branches.filter((b) => b.isActive);

      assert.strictEqual(activeBranches.length, 1);
    });
  });

  describe('btw (By The Way branching)', () => {
    it('should create a new branch from current head without switching', async () => {
      const store = new InMemoryContextStore();
      const engine = new ContextEngine({
        userId: 'test-user',
        store,
        chatId: 'test-btw-1',
      });

      // Add and save a message
      engine.set(user('What is the weather?'));
      await engine.save();

      // Call btw - should create branch but not switch
      const branchInfo = await engine.btw();

      // Verify branch was created
      assert.ok(branchInfo);
      assert.strictEqual(branchInfo.name, 'main-v2');
      assert.strictEqual(branchInfo.isActive, false);
      assert.strictEqual(branchInfo.messageCount, 1);

      // Verify we're still on main branch
      assert.strictEqual(engine.branch, 'main');

      // Verify both branches exist
      const branches = await store.listBranches('test-btw-1');
      assert.strictEqual(branches.length, 2);
    });

    it('should throw when no messages exist', async () => {
      const store = new InMemoryContextStore();
      const engine = new ContextEngine({
        userId: 'test-user',
        store,
        chatId: 'test-btw-2',
      });

      // Initialize but don't add messages
      await engine.resolve({ renderer });

      // btw should fail - no messages to branch from
      await assert.rejects(
        () => engine.btw(),
        /Cannot create btw branch: no messages in conversation/,
      );
    });

    it('should keep pending messages after btw', async () => {
      const store = new InMemoryContextStore();
      const engine = new ContextEngine({
        userId: 'test-user',
        store,
        chatId: 'test-btw-3',
      });

      // Save a message
      engine.set(user('Saved message'));
      await engine.save();

      // Add pending message
      engine.set(user('Pending message'));

      // Call btw
      await engine.btw();

      // Resolve should still include the pending message
      const { messages } = await engine.resolve({ renderer });
      assert.strictEqual(messages.length, 2);
    });

    it('should create incrementing branch names', async () => {
      const store = new InMemoryContextStore();
      const engine = new ContextEngine({
        userId: 'test-user',
        store,
        chatId: 'test-btw-4',
      });

      engine.set(user('Message'));
      await engine.save();

      const branch1 = await engine.btw();
      const branch2 = await engine.btw();
      const branch3 = await engine.btw();

      assert.strictEqual(branch1.name, 'main-v2');
      assert.strictEqual(branch2.name, 'main-v3');
      assert.strictEqual(branch3.name, 'main-v4');
    });

    it('should allow switching to btw branch and adding messages', async () => {
      const store = new InMemoryContextStore();
      const engine = new ContextEngine({
        userId: 'test-user',
        store,
        chatId: 'test-btw-5',
      });

      // Initial conversation
      engine.set(user('What is the weather?'));
      await engine.save();

      // Create btw branch
      const btwBranch = await engine.btw();

      // Switch to it and add new question
      await engine.switchBranch(btwBranch.name);
      engine.set(user('Also, what time is it?'));
      await engine.save();

      // Verify the branch has 2 messages now
      const branches = await store.listBranches('test-btw-5');
      const mainBranch = branches.find((b) => b.name === 'main');
      const v2Branch = branches.find((b) => b.name === 'main-v2');

      assert.ok(mainBranch);
      assert.ok(v2Branch);

      // Main should still have 1 message, v2 should have 2
      const mainChain = mainBranch.headMessageId
        ? await store.getMessageChain(mainBranch.headMessageId)
        : [];
      const v2Chain = v2Branch.headMessageId
        ? await store.getMessageChain(v2Branch.headMessageId)
        : [];

      assert.strictEqual(mainChain.length, 1);
      assert.strictEqual(v2Chain.length, 2);
    });
  });
});
