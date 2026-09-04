import { PGlite } from '@electric-sql/pglite';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

const __dirname = dirname(fileURLToPath(import.meta.url));

export const resources = new AsyncDisposableStack();

const database = resources.adopt(new PGlite(), (database) => database.close());
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
const streamStore = resources.adopt(
  new SqliteStreamStore(join(__dirname, 'simple.sqlite')),
  (store) => store.close(),
);
const mailboxStore = resources.use(new SqliteMailboxStore(':memory:'));
const runtime = new AgentRuntime(declaration, {
  store: new SqliteContextStore(join(__dirname, 'simple.context.sqlite')),
  streams: new StreamManager({
    store: streamStore,
    changeSource: new PollingChangeSource({ reads: streamStore }),
  }),
  queue,
  mailboxStore,
});

resources.use(await runtime.work());
export default runtime;
