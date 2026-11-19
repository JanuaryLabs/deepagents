import { SqlServer } from '@zukhruf/testing/sqlserver';
import assert from 'node:assert';
import { describe, it } from 'node:test';

import {
  ContextEngine,
  SqlServerContextStore,
  user,
} from '@deepagents/context';

const testSqlServer = new SqlServer({ environment: process.env });

describe('Branching', () => {
  describe('Rewind (Forking)', () => {
    it('should update engine branch name after rewind', async () => {
      await using container = await testSqlServer.database();

      const store = await SqlServerContextStore.create({
        pool: container.connectionString,
      });
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
    });
  });
});
