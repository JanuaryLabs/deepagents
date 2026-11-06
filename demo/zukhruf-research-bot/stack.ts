import { PGlite } from '@electric-sql/pglite';
import { open } from '@zukhruf/sqlite-open';
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
  const database = resources.use(new PGlite('./zukhruf-research.queue'));
  const boss = resources.adopt(
    new PgBoss({
      db: fromPglite(database),
      backend: 'pglite',
    }),
    (boss) => boss.stop({ graceful: false }),
  );
  boss.on('error', (error) => console.error('[queue error]', error));
  await boss.start();
  const queue = await PgBossTurnQueue.create(boss, {
    pollingIntervalSeconds: 0.5,
    schema: 'pgboss',
  });
  const mailboxStore = resources.use(
    new SqliteMailboxStore('./zukhruf-research.mailbox.sqlite'),
  );
  const streamStore = new SqliteStreamStore(
    resources.use(open('./zukhruf-research.streams.sqlite')),
  );
  const streams = new StreamManager({
    store: streamStore,
    changeSource: new PollingChangeSource({ reads: streamStore }),
  });
  return {
    store: new SqliteContextStore(
      resources.use(open('./zukhruf-research.sqlite')),
    ),
    streams,
    queue,
    mailboxStore,
  };
});
