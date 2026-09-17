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
import { schedulesCapabilities } from '@deepagents/experimental/zukhruf/schedules';

export default defineStack(async (resources) => {
  const database = resources.use(
    new PGlite(join(import.meta.dirname, 'zukhruf.queue')),
  );
  const boss = resources.adopt(
    new PgBoss({ db: fromPglite(database), backend: 'pglite' }),
    (boss) => boss.stop({ graceful: false }),
  );
  boss.on('error', (error) => console.error('[queue error]', error));
  await boss.start();
  const queue = new PgBossTurnQueue(boss, {
    pollingIntervalSeconds: 0.5,
    schema: 'pgboss',
  });
  await queue.initialize();
  const mailboxStore = resources.use(
    new SqliteMailboxStore(join(import.meta.dirname, 'zukhruf.mailbox.sqlite')),
  );
  const streamStore = new SqliteStreamStore(
    resources.use(
      new DatabaseSync(join(import.meta.dirname, 'zukhruf.streams.sqlite')),
    ),
  );
  return {
    store: new SqliteContextStore(
      resources.use(
        new DatabaseSync(join(import.meta.dirname, 'zukhruf.sqlite')),
      ),
    ),
    streams: new StreamManager({
      store: streamStore,
      changeSource: new PollingChangeSource({ reads: streamStore }),
    }),
    queue,
    mailboxStore,
    bindings: [
      schedulesCapabilities.boss.bind(boss),
      schedulesCapabilities.transaction.bind((operation) =>
        database.transaction((transaction) =>
          operation(fromPglite(transaction)),
        ),
      ),
    ],
  };
});
