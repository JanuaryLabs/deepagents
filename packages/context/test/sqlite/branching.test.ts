import { Sqlite } from '@zukhruf/testing/sqlite';
import assert from 'node:assert';
import { describe, it } from 'node:test';

import { ContextEngine, SqliteContextStore, user } from '@deepagents/context';

const sqlite = new Sqlite();

describe('Branching', () => {
  describe('Rewind (Forking)', () => {
    it('should update engine branch name after rewind', async () => {
      await using database = await sqlite.database();
      const store = new SqliteContextStore(database.connection);
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
      const reopened = new ContextEngine({
        userId: 'test-user',
        store,
        chatId: 'test-rewind-5',
      });
      await reopened.getMessages();
      assert.strictEqual(reopened.branch, engine.branch);
    });
  });

  describe('Active branch', () => {
    it('keeps the original branch active when activating another branch fails', async () => {
      await using database = await sqlite.database();
      const store = new SqliteContextStore(database.connection);
      await store.createChat({ id: 'chat-switch', userId: 'test-user' });
      await store.createBranch({
        id: 'branch-alt',
        chatId: 'chat-switch',
        name: 'alt',
        headMessageId: null,
        isActive: false,
        createdAt: Date.now(),
      });
      database.connection.exec(`
        CREATE TRIGGER refuse_alt_activation
        BEFORE UPDATE OF isActive ON branches
        WHEN NEW.id = 'branch-alt' AND NEW.isActive = 1
        BEGIN
          SELECT RAISE(ABORT, 'activation refused');
        END
      `);

      await assert.rejects(
        store.setActiveBranch('chat-switch', 'branch-alt'),
        /activation refused/,
      );

      const branches = await store.listBranches('chat-switch');
      assert.deepStrictEqual(
        branches
          .filter((branch) => branch.isActive)
          .map((branch) => branch.name),
        ['main'],
      );
    });
  });
});
