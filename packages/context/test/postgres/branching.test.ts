import { Postgres } from '@zukhruf/testing/postgres';
import assert from 'node:assert';
import { describe, it } from 'node:test';

import { ContextEngine, PostgresContextStore, user } from '@deepagents/context';

const testPostgres = new Postgres({ environment: process.env });

describe('Branching', () => {
  describe('Rewind (Forking)', () => {
    it('should update engine branch name after rewind', async () => {
      await using container = await testPostgres.database();

      const store = await PostgresContextStore.create({
        pool: container.pool(),
      });
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
    });
  });
});
