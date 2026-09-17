import { PGlite } from '@electric-sql/pglite';
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
  const database = resources.use(new PGlite('./animated-svg.queue'));
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
  const mailboxStore = resources.use(
    new SqliteMailboxStore('./animated-svg.mailbox.sqlite'),
  );
  const streamStore = new SqliteStreamStore(
    resources.use(new DatabaseSync('./animated-svg.streams.sqlite')),
  );
  const streams = new StreamManager({
    store: streamStore,
    changeSource: new PollingChangeSource({ reads: streamStore }),
  });

  return {
    store: new SqliteContextStore(
      resources.use(new DatabaseSync('./animated-svg.sqlite')),
    ),
    streams,
    queue,
    mailboxStore,
  };
});
