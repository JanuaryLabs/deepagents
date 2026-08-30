import { PGlite } from '@electric-sql/pglite';
import { join } from 'node:path';
import { PgBoss, fromPglite } from 'pg-boss';

import {
  PollingChangeSource,
  SqliteContextStore,
  SqliteStreamStore,
  StreamManager,
} from '@deepagents/context';
import {
  AgentRuntime,
  PgBossTurnQueue,
  SqliteMailboxStore,
} from '@deepagents/experimental/zukhruf';
import { schedulesCapabilities } from '@deepagents/experimental/zukhruf/schedules';

import declaration from './agent.ts';

export const resources = new AsyncDisposableStack();

const database = resources.adopt(
  new PGlite(join(import.meta.dirname, 'zukhruf.queue')),
  (database) => database.close(),
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
const streamStore = resources.adopt(
  new SqliteStreamStore(join(import.meta.dirname, 'zukhruf.streams.sqlite')),
  (store) => store.close(),
);
const runtime = new AgentRuntime(declaration, {
  store: new SqliteContextStore(join(import.meta.dirname, 'zukhruf.sqlite')),
  streams: new StreamManager({
    store: streamStore,
    changeSource: new PollingChangeSource({ reads: streamStore }),
  }),
  queue,
  mailboxStore,
  bindings: [
    schedulesCapabilities.boss.bind(boss),
    schedulesCapabilities.transaction.bind((operation) =>
      database.transaction((transaction) => operation(fromPglite(transaction))),
    ),
  ],
});

resources.use(await runtime.work());
export default runtime;
