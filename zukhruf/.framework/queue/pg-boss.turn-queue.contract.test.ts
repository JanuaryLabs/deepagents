import { PGlite } from '@electric-sql/pglite';
import { PgBoss, fromPglite } from 'pg-boss';

import { PgBossTurnQueue } from './pg-boss.turn-queue.ts';
import { turnQueueContract } from './turn-queue.contract.ts';

turnQueueContract('PgBossTurnQueue (pglite)', async () => {
  const pglite = new PGlite();
  const boss = new PgBoss({ db: fromPglite(pglite), backend: 'pglite' });
  boss.on('error', () => {});
  await boss.start();
  const queue = new PgBossTurnQueue(boss, { pollingIntervalSeconds: 0.5 });
  await queue.initialize();
  return {
    queue,
    async [Symbol.asyncDispose]() {
      await boss.stop({ graceful: false });
      await pglite.close();
    },
  };
});
