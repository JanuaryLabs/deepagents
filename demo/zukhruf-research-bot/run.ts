import { PGlite } from '@electric-sql/pglite';
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

import declaration from './agent.ts';

export const resources = new AsyncDisposableStack();

const database = resources.adopt(
  new PGlite('./zukhruf-research.queue'),
  (database) => database.close(),
);
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
  new SqliteMailboxStore('./zukhruf-research.mailbox.sqlite'),
);
const streamStore = resources.adopt(
  new SqliteStreamStore('./zukhruf-research.streams.sqlite'),
  (store) => store.close(),
);
const streams = new StreamManager({
  store: streamStore,
  changeSource: new PollingChangeSource({ reads: streamStore }),
});
const runtime = new AgentRuntime(declaration, {
  store: new SqliteContextStore('./zukhruf-research.sqlite'),
  streams,
  queue,
  mailboxStore,
});

resources.use(await runtime.work({ concurrency: 4 }));
export default runtime;
