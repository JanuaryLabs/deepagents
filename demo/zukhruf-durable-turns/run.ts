import { PGlite } from '@electric-sql/pglite';
import { PgBoss, fromPglite } from 'pg-boss';

import { printer } from '@deepagents/agent';
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

const input =
  process.argv.slice(2).join(' ') ||
  'Delegate to the specialist: list the numbers 1 through 20, one per line, each with a one-word note.';

await using resources = new AsyncDisposableStack();

const database = resources.adopt(new PGlite('./zukhruf.queue'), (database) =>
  database.close(),
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
  new SqliteMailboxStore('./zukhruf.mailbox.sqlite'),
);
const streamStore = resources.adopt(
  new SqliteStreamStore('./zukhruf.streams.sqlite'),
  (store) => store.close(),
);
const streams = new StreamManager({
  store: streamStore,
  changeSource: new PollingChangeSource({ reads: streamStore }),
});

const runtime = new AgentRuntime(declaration, {
  store: new SqliteContextStore('./zukhruf.sqlite'),
  streams,
  queue,
  mailboxStore,
});

const conversation = {
  chatId: `cli-${crypto.randomUUID()}`,
  userId: process.env.USER ?? 'local',
};
resources.use(await runtime.work({ concurrency: 4 }));

const statusAbort = new AbortController();
const rootIdleAgain = Promise.withResolvers<void>();
const statusLog = (async () => {
  let rootTurns = 0;
  try {
    for await (const change of runtime.subscribeConversationStatus(
      statusAbort.signal,
    )) {
      const isRoot = change.conversation.chatId === conversation.chatId;
      const flags =
        change.status.type === 'active' && change.status.activeFlags.length > 0
          ? ` [${change.status.activeFlags.join(', ')}]`
          : '';
      console.log(
        `[status] ${isRoot ? '/root' : change.conversation.chatId} ${change.status.type}${flags}`,
      );
      if (!isRoot) continue;
      if (change.status.type === 'active') rootTurns += 1;
      if (change.status.type === 'idle' && rootTurns > 0) {
        rootIdleAgain.resolve();
      }
    }
  } catch (error) {
    if (!(error instanceof Error && error.name === 'AbortError')) throw error;
  }
})();

const first = await runtime.enqueue(conversation, {
  message: {
    id: crypto.randomUUID(),
    role: 'user',
    parts: [{ type: 'text', text: input }],
  },
  trigger: 'submit-message',
});
console.log(
  `\n[root turn ${first.id} enqueued] reading a few chunks, then detaching…\n`,
);

const reader = first.stream.getReader();
let deltas = 0;
while (deltas < 5) {
  const { done, value } = await reader.read();
  if (done) break;
  if (value.type === 'text-delta') {
    process.stdout.write(value.delta);
    deltas += 1;
  }
}
await reader.cancel();
console.log(
  `\n\n[detached after ${deltas} chunks] the root keeps running: it spawns the specialist in a separate chat and waits for its FINAL_ANSWER with wait_agent.\n`,
);

const resumed = await runtime.observe(conversation).resume();
if (!resumed) {
  throw new Error('resume() found no active stream — durability broken');
}
console.log(
  '[reconnected via resume()] replaying the root turn from chunk 0, then tailing to completion:\n',
);
await printer.readableStream(resumed);

await rootIdleAgain.promise;
statusAbort.abort();
await statusLog;
console.log(
  `\n[done] the specialist's FINAL_ANSWER was consumed inside the root turn; root and specialist used independent histories, streams, mailboxes, and queue keys. Root container "sandbox-${conversation.chatId}" remains attached to its chat.\n`,
);
