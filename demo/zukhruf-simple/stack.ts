import { PGlite } from '@electric-sql/pglite';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PgBoss, fromPglite } from 'pg-boss';

import {
  PollingChangeSource,
  SqliteContextStore,
  SqliteStreamStore,
  StreamManager,
} from '@deepagents/context';
import {
  PgBossTurnQueue,
  SqliteMailboxStore,
  defineStack,
} from '@deepagents/experimental/zukhruf';

export default defineStack(async (resources) => {
  const database = resources.use(new PGlite());
  const boss = resources.adopt(
    new PgBoss({
      db: fromPglite(database),
      backend: 'pglite',
    }),
    (boss) => boss.stop({ graceful: false }),
  );
  boss.on('error', (error) => console.error('[queue error]', error));
  await boss.start();
  const queue = new PgBossTurnQueue(boss, {
    pollingIntervalSeconds: 0.5,
    schema: 'pgboss',
  });
  await queue.initialize();
  const streamStore = new SqliteStreamStore(
    resources.use(new DatabaseSync(join(import.meta.dirname, 'simple.sqlite'))),
  );
  const mailboxStore = resources.use(new SqliteMailboxStore(':memory:'));
  return {
    store: new SqliteContextStore(
      resources.use(
        new DatabaseSync(join(import.meta.dirname, 'simple.context.sqlite')),
      ),
    ),
    streams: new StreamManager({
      store: streamStore,
      changeSource: new PollingChangeSource({ reads: streamStore }),
    }),
    queue,
    mailboxStore,
  };
});
