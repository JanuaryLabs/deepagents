import assert from 'node:assert';
import { describe, it } from 'node:test';

import {
  ContextEngine,
  SqlServerContextStore,
  XmlRenderer,
  assistantText,
  user,
} from '@deepagents/context';
import { withSqlServerContainer } from '@deepagents/test';

const renderer = new XmlRenderer();

describe('Branching', () => {
  describe('Basic Branch Creation', () => {
    it('should create "main" branch by default', async () =>
      await withSqlServerContainer(async (container) => {
        const store = new SqlServerContextStore({
          pool: container.connectionString,
        });
        await store.initialize();
        try {
          const engine = new ContextEngine({
            userId: 'test-user',
            store,
            chatId: 'test-branch-1',
          });

          await engine.resolve({ renderer });

          const branches = await store.listBranches('test-branch-1');
          assert.strictEqual(branches.length, 1);
          assert.strictEqual(branches[0].name, 'main');
          assert.strictEqual(branches[0].isActive, true);
          assert.strictEqual(branches[0].headMessageId, null);
        } finally {
          await store.close();
        }
      }));

    it('should expose branch name via getter (defaults to main)', () =>
      withSqlServerContainer(async (container) => {
        const store = new SqlServerContextStore({
          pool: container.connectionString,
        });
        await store.initialize();
        try {
          const engine = new ContextEngine({
            userId: 'test-user',
            store,
            chatId: 'test-branch-2',
          });

          assert.strictEqual(engine.branch, 'main');
        } finally {
          await store.close();
        }
      }));
  });

  describe('Message Chain (parentId linking)', () => {
    it('should set parentId to null for first message', () =>
      withSqlServerContainer(async (container) => {
        const store = new SqlServerContextStore({
          pool: container.connectionString,
        });
        await store.initialize();
        try {
          const engine = new ContextEngine({
            userId: 'test-user',
            store,
            chatId: 'test-chain-1',
          });

          engine.set(
            user({
              id: 'chain-msg-1',
              role: 'user',
              parts: [{ type: 'text', text: 'Hello' }],
            }),
          );
          await engine.save();

          const msg = await store.getMessage('chain-msg-1');
          assert.ok(msg);
          assert.strictEqual(msg.parentId, null);
        } finally {
          await store.close();
        }
      }));

    it('should link subsequent messages via parentId', () =>
      withSqlServerContainer(async (container) => {
        const store = new SqlServerContextStore({
          pool: container.connectionString,
        });
        await store.initialize();
        try {
          const engine = new ContextEngine({
            userId: 'test-user',
            store,
            chatId: 'test-chain-2',
          });

          engine.set(
            user({
              id: 'chain2-msg-1',
              role: 'user',
              parts: [{ type: 'text', text: 'Hello' }],
            }),
          );
          engine.set(assistantText('Hi!', { id: 'chain2-msg-2' }));
          engine.set(
            user({
              id: 'chain2-msg-3',
              role: 'user',
              parts: [{ type: 'text', text: 'How are you?' }],
            }),
          );
          await engine.save();

          const msg1 = await store.getMessage('chain2-msg-1');
          const msg2 = await store.getMessage('chain2-msg-2');
          const msg3 = await store.getMessage('chain2-msg-3');

          assert.strictEqual(msg1!.parentId, null);
          assert.strictEqual(msg2!.parentId, 'chain2-msg-1');
          assert.strictEqual(msg3!.parentId, 'chain2-msg-2');
        } finally {
          await store.close();
        }
      }));

    it('should update branch headMessageId after save', () =>
      withSqlServerContainer(async (container) => {
        const store = new SqlServerContextStore({
          pool: container.connectionString,
        });
        await store.initialize();
        try {
          const engine = new ContextEngine({
            userId: 'test-user',
            store,
            chatId: 'test-chain-3',
          });

          engine.set(
            user({
              id: 'chain3-msg-1',
              role: 'user',
              parts: [{ type: 'text', text: 'Hello' }],
            }),
          );
          engine.set(assistantText('Hi!', { id: 'chain3-msg-2' }));
          await engine.save();

          const branch = await store.getBranch('test-chain-3', 'main');
          assert.strictEqual(branch!.headMessageId, 'chain3-msg-2');
        } finally {
          await store.close();
        }
      }));

    it('should return messages in correct order (root to head)', () =>
      withSqlServerContainer(async (container) => {
        const store = new SqlServerContextStore({
          pool: container.connectionString,
        });
        await store.initialize();
        try {
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
          assert.deepStrictEqual(
            messages.map((m: any) => m.parts[0].text),
            ['First', 'Second', 'Third'],
          );
        } finally {
          await store.close();
        }
      }));
  });

  describe('Rewind (Forking)', () => {
    it('should create new branch pointing to rewind message', () =>
      withSqlServerContainer(async (container) => {
        const store = new SqlServerContextStore({
          pool: container.connectionString,
        });
        await store.initialize();
        try {
          const engine = new ContextEngine({
            userId: 'test-user',
            store,
            chatId: 'test-rewind-1',
          });

          engine.set(
            user({
              id: 'rw1-msg-1',
              role: 'user',
              parts: [{ type: 'text', text: 'Hello' }],
            }),
          );
          engine.set(assistantText('Hi!', { id: 'rw1-msg-2' }));
          engine.set(
            user({
              id: 'rw1-msg-3',
              role: 'user',
              parts: [{ type: 'text', text: 'Wrong path' }],
            }),
          );
          await engine.save();

          const newBranch = await engine.rewind('rw1-msg-2');

          assert.ok(newBranch.name.includes('main-v'));
          assert.strictEqual(newBranch.headMessageId, 'rw1-msg-2');
          assert.strictEqual(newBranch.isActive, true);
        } finally {
          await store.close();
        }
      }));

    it('should deactivate old branch after rewind', () =>
      withSqlServerContainer(async (container) => {
        const store = new SqlServerContextStore({
          pool: container.connectionString,
        });
        await store.initialize();
        try {
          const engine = new ContextEngine({
            userId: 'test-user',
            store,
            chatId: 'test-rewind-2',
          });

          engine.set(
            user({
              id: 'rw2-msg-1',
              role: 'user',
              parts: [{ type: 'text', text: 'Hello' }],
            }),
          );
          engine.set(assistantText('Hi!', { id: 'rw2-msg-2' }));
          await engine.save();

          await engine.rewind('rw2-msg-1');

          const branches = await store.listBranches('test-rewind-2');
          const mainBranch = branches.find((b) => b.name === 'main');
          const newBranch = branches.find((b) => b.name !== 'main');

          assert.strictEqual(mainBranch!.isActive, false);
          assert.strictEqual(newBranch!.isActive, true);
        } finally {
          await store.close();
        }
      }));

    it('should preserve original messages after rewind', () =>
      withSqlServerContainer(async (container) => {
        const store = new SqlServerContextStore({
          pool: container.connectionString,
        });
        await store.initialize();
        try {
          const engine = new ContextEngine({
            userId: 'test-user',
            store,
            chatId: 'test-rewind-3',
          });

          engine.set(
            user({
              id: 'rw3-msg-1',
              role: 'user',
              parts: [{ type: 'text', text: 'Hello' }],
            }),
          );
          engine.set(assistantText('Original response', { id: 'rw3-msg-2' }));
          await engine.save();

          await engine.rewind('rw3-msg-1');

          const msg1 = await store.getMessage('rw3-msg-1');
          const msg2 = await store.getMessage('rw3-msg-2');

          assert.ok(msg1);
          assert.ok(msg2);
          assert.strictEqual(
            (msg2!.data as any).parts[0].text,
            'Original response',
          );
        } finally {
          await store.close();
        }
      }));

    it('should link new messages to fork point after rewind', () =>
      withSqlServerContainer(async (container) => {
        const store = new SqlServerContextStore({
          pool: container.connectionString,
        });
        await store.initialize();
        try {
          const engine = new ContextEngine({
            userId: 'test-user',
            store,
            chatId: 'test-rewind-4',
          });

          engine.set(
            user({
              id: 'rw4-msg-1',
              role: 'user',
              parts: [{ type: 'text', text: 'Hello' }],
            }),
          );
          engine.set(assistantText('Original', { id: 'rw4-msg-2' }));
          await engine.save();

          await engine.rewind('rw4-msg-1');

          engine.set(assistantText('Better response', { id: 'rw4-msg-3' }));
          await engine.save();

          const msg3 = await store.getMessage('rw4-msg-3');

          assert.strictEqual(msg3!.parentId, 'rw4-msg-1');
        } finally {
          await store.close();
        }
      }));

    it('should update engine branch name after rewind', () =>
      withSqlServerContainer(async (container) => {
        const store = new SqlServerContextStore({
          pool: container.connectionString,
        });
        await store.initialize();
        try {
          const engine = new ContextEngine({
            userId: 'test-user',
            store,
            chatId: 'test-rewind-5',
          });

          engine.set(
            user({
              id: 'rw5-msg-1',
              role: 'user',
              parts: [{ type: 'text', text: 'Hello' }],
            }),
          );
          await engine.save();

          assert.strictEqual(engine.branch, 'main');

          await engine.rewind('rw5-msg-1');

          assert.ok(engine.branch.startsWith('main-v'));
        } finally {
          await store.close();
        }
      }));

    it('should clear pending messages after rewind', () =>
      withSqlServerContainer(async (container) => {
        const store = new SqlServerContextStore({
          pool: container.connectionString,
        });
        await store.initialize();
        try {
          const engine = new ContextEngine({
            userId: 'test-user',
            store,
            chatId: 'test-rewind-6',
          });

          engine.set(
            user({
              id: 'rw6-msg-1',
              role: 'user',
              parts: [{ type: 'text', text: 'Hello' }],
            }),
          );
          await engine.save();

          engine.set(assistantText('Pending'));

          await engine.rewind('rw6-msg-1');

          const { messages } = await engine.resolve({ renderer });
          assert.strictEqual(messages.length, 1);
        } finally {
          await store.close();
        }
      }));

    it('should throw when rewinding to non-existent message', () =>
      withSqlServerContainer(async (container) => {
        const store = new SqlServerContextStore({
          pool: container.connectionString,
        });
        await store.initialize();
        try {
          const engine = new ContextEngine({
            userId: 'test-user',
            store,
            chatId: 'test-rewind-7',
          });

          engine.set(user('Hello'));
          await engine.save();

          await assert.rejects(async () => {
            await engine.rewind('nonexistent-msg-id');
          }, /not found/i);
        } finally {
          await store.close();
        }
      }));
  });

  describe('Switch Branch', () => {
    it('should switch active branch', () =>
      withSqlServerContainer(async (container) => {
        const store = new SqlServerContextStore({
          pool: container.connectionString,
        });
        await store.initialize();
        try {
          const engine = new ContextEngine({
            userId: 'test-user',
            store,
            chatId: 'test-switch-1',
          });

          engine.set(
            user({
              id: 'sw1-msg-1',
              role: 'user',
              parts: [{ type: 'text', text: 'Hello' }],
            }),
          );
          engine.set(assistantText('Hi!', { id: 'sw1-msg-2' }));
          await engine.save();

          await engine.rewind('sw1-msg-1');

          await engine.switchBranch('main');

          assert.strictEqual(engine.branch, 'main');

          const branch = await store.getBranch('test-switch-1', 'main');
          assert.strictEqual(branch!.isActive, true);
        } finally {
          await store.close();
        }
      }));

    it('should return different message chains per branch', () =>
      withSqlServerContainer(async (container) => {
        const store = new SqlServerContextStore({
          pool: container.connectionString,
        });
        await store.initialize();
        try {
          const engine = new ContextEngine({
            userId: 'test-user',
            store,
            chatId: 'test-switch-2',
          });

          engine.set(
            user({
              id: 'sw2-msg-1',
              role: 'user',
              parts: [{ type: 'text', text: 'Hello' }],
            }),
          );
          engine.set(assistantText('Response A', { id: 'sw2-msg-2' }));
          await engine.save();

          await engine.rewind('sw2-msg-1');
          engine.set(assistantText('Response B', { id: 'sw2-msg-3' }));
          await engine.save();

          const { messages: forkedMessages } = await engine.resolve({
            renderer,
          });
          assert.strictEqual(forkedMessages.length, 2);
          assert.strictEqual(
            (forkedMessages[1] as any).parts[0].text,
            'Response B',
          );

          await engine.switchBranch('main');
          const { messages: mainMessages } = await engine.resolve({ renderer });
          assert.strictEqual(mainMessages.length, 2);
          assert.strictEqual(
            (mainMessages[1] as any).parts[0].text,
            'Response A',
          );
        } finally {
          await store.close();
        }
      }));

    it('should throw when switching to non-existent branch', () =>
      withSqlServerContainer(async (container) => {
        const store = new SqlServerContextStore({
          pool: container.connectionString,
        });
        await store.initialize();
        try {
          const engine = new ContextEngine({
            userId: 'test-user',
            store,
            chatId: 'test-switch-3',
          });

          await engine.resolve({ renderer });

          await assert.rejects(async () => {
            await engine.switchBranch('nonexistent');
          }, /not found/i);
        } finally {
          await store.close();
        }
      }));

    it('should clear pending messages when switching', () =>
      withSqlServerContainer(async (container) => {
        const store = new SqlServerContextStore({
          pool: container.connectionString,
        });
        await store.initialize();
        try {
          const engine = new ContextEngine({
            userId: 'test-user',
            store,
            chatId: 'test-switch-4',
          });

          engine.set(
            user({
              id: 'sw4-msg-1',
              role: 'user',
              parts: [{ type: 'text', text: 'Message 1' }],
            }),
          );
          await engine.save();

          await engine.rewind('sw4-msg-1');

          engine.set(user('Pending on fork'));

          await engine.switchBranch('main');

          const { messages } = await engine.resolve({ renderer });
          assert.strictEqual(messages.length, 1);
        } finally {
          await store.close();
        }
      }));
  });

  describe('Multiple Branches', () => {
    it('should support multiple branches in one chat', () =>
      withSqlServerContainer(async (container) => {
        const store = new SqlServerContextStore({
          pool: container.connectionString,
        });
        await store.initialize();
        try {
          const engine = new ContextEngine({
            userId: 'test-user',
            store,
            chatId: 'test-multi-1',
          });

          engine.set(
            user({
              id: 'multi1-msg-1',
              role: 'user',
              parts: [{ type: 'text', text: 'Start' }],
            }),
          );
          await engine.save();

          await engine.rewind('multi1-msg-1');
          engine.set(assistantText('Path A'));
          await engine.save();

          await engine.rewind('multi1-msg-1');
          engine.set(assistantText('Path B'));
          await engine.save();

          await engine.rewind('multi1-msg-1');
          engine.set(assistantText('Path C'));
          await engine.save();

          const branches = await store.listBranches('test-multi-1');
          assert.strictEqual(branches.length, 4);
        } finally {
          await store.close();
        }
      }));

    it('should maintain independent headMessageId per branch', () =>
      withSqlServerContainer(async (container) => {
        const store = new SqlServerContextStore({
          pool: container.connectionString,
        });
        await store.initialize();
        try {
          const engine = new ContextEngine({
            userId: 'test-user',
            store,
            chatId: 'test-multi-2',
          });

          engine.set(
            user({
              id: 'multi2-root',
              role: 'user',
              parts: [{ type: 'text', text: 'Root' }],
            }),
          );
          await engine.save();

          await engine.rewind('multi2-root');
          engine.set(
            assistantText('Branch 2 response', { id: 'multi2-b2-msg' }),
          );
          await engine.save();

          const branches = await store.listBranches('test-multi-2');
          const mainBranch = branches.find((b) => b.name === 'main');
          const forkBranch = branches.find((b) => b.name !== 'main');

          assert.strictEqual(mainBranch!.headMessageId, 'multi2-root');
          assert.strictEqual(forkBranch!.headMessageId, 'multi2-b2-msg');
        } finally {
          await store.close();
        }
      }));

    it('should have only one active branch at a time', () =>
      withSqlServerContainer(async (container) => {
        const store = new SqlServerContextStore({
          pool: container.connectionString,
        });
        await store.initialize();
        try {
          const engine = new ContextEngine({
            userId: 'test-user',
            store,
            chatId: 'test-multi-3',
          });

          engine.set(
            user({
              id: 'multi3-msg-1',
              role: 'user',
              parts: [{ type: 'text', text: 'Start' }],
            }),
          );
          await engine.save();

          await engine.rewind('multi3-msg-1');
          await engine.rewind('multi3-msg-1');
          await engine.rewind('multi3-msg-1');

          const branches = await store.listBranches('test-multi-3');
          const activeBranches = branches.filter((b) => b.isActive);

          assert.strictEqual(activeBranches.length, 1);
        } finally {
          await store.close();
        }
      }));
  });

  describe('btw (By The Way branching)', () => {
    it('should create new branch from current head without switching', () =>
      withSqlServerContainer(async (container) => {
        const store = new SqlServerContextStore({
          pool: container.connectionString,
        });
        await store.initialize();
        try {
          const engine = new ContextEngine({
            userId: 'test-user',
            store,
            chatId: 'test-btw-1',
          });

          engine.set(user('What is the weather?'));
          await engine.save();

          const branchInfo = await engine.btw();

          assert.ok(branchInfo);
          assert.strictEqual(branchInfo.name, 'main-v2');
          assert.strictEqual(branchInfo.isActive, false);
          assert.strictEqual(branchInfo.messageCount, 1);

          assert.strictEqual(engine.branch, 'main');

          const branches = await store.listBranches('test-btw-1');
          assert.strictEqual(branches.length, 2);
        } finally {
          await store.close();
        }
      }));

    it('should throw when no messages exist', () =>
      withSqlServerContainer(async (container) => {
        const store = new SqlServerContextStore({
          pool: container.connectionString,
        });
        await store.initialize();
        try {
          const engine = new ContextEngine({
            userId: 'test-user',
            store,
            chatId: 'test-btw-2',
          });

          await engine.resolve({ renderer });

          await assert.rejects(
            () => engine.btw(),
            /Cannot create btw branch: no messages in conversation/,
          );
        } finally {
          await store.close();
        }
      }));

    it('should keep pending messages after btw', () =>
      withSqlServerContainer(async (container) => {
        const store = new SqlServerContextStore({
          pool: container.connectionString,
        });
        await store.initialize();
        try {
          const engine = new ContextEngine({
            userId: 'test-user',
            store,
            chatId: 'test-btw-3',
          });

          engine.set(user('Saved message'));
          await engine.save();

          engine.set(user('Pending message'));

          await engine.btw();

          const { messages } = await engine.resolve({ renderer });
          assert.strictEqual(messages.length, 2);
        } finally {
          await store.close();
        }
      }));

    it('should create incrementing branch names', () =>
      withSqlServerContainer(async (container) => {
        const store = new SqlServerContextStore({
          pool: container.connectionString,
        });
        await store.initialize();
        try {
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
        } finally {
          await store.close();
        }
      }));

    it('should allow switching to btw branch and adding messages', () =>
      withSqlServerContainer(async (container) => {
        const store = new SqlServerContextStore({
          pool: container.connectionString,
        });
        await store.initialize();
        try {
          const engine = new ContextEngine({
            userId: 'test-user',
            store,
            chatId: 'test-btw-5',
          });

          engine.set(user('What is the weather?'));
          await engine.save();

          const btwBranch = await engine.btw();

          await engine.switchBranch(btwBranch.name);
          engine.set(user('Also, what time is it?'));
          await engine.save();

          const branches = await store.listBranches('test-btw-5');
          const mainBranch = branches.find((b) => b.name === 'main');
          const v2Branch = branches.find((b) => b.name === 'main-v2');

          assert.ok(mainBranch);
          assert.ok(v2Branch);

          const mainChain = mainBranch.headMessageId
            ? await store.getMessageChain(mainBranch.headMessageId)
            : [];
          const v2Chain = v2Branch.headMessageId
            ? await store.getMessageChain(v2Branch.headMessageId)
            : [];

          assert.strictEqual(mainChain.length, 1);
          assert.strictEqual(v2Chain.length, 2);
        } finally {
          await store.close();
        }
      }));
  });
});
