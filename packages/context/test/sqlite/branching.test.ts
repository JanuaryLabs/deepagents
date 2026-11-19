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
});
