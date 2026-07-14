import { PGlite } from '@electric-sql/pglite';
import { PgBoss, fromPglite } from 'pg-boss';

import { printer } from '@deepagents/agent';
import { SqliteContextStore, SqliteStreamStore } from '@deepagents/context';
import {
  AgentRuntime,
  PgBossTurnQueue,
  SqliteApprovalMutex,
  SqliteMailboxStore,
} from '@deepagents/experimental/zukhruf';

import declaration from './agent.ts';

const input =
  process.argv.slice(2).join(' ') ||
  'Delegate to the specialist: list the numbers 1 through 20, one per line, each with a one-word note.';

const boss = new PgBoss({
  db: fromPglite(new PGlite('./zukhruf.queue')),
  backend: 'pglite',
});
boss.on('error', (error) => console.error('[queue error]', error));
await boss.start();
const queue = new PgBossTurnQueue(boss, { pollingIntervalSeconds: 0.5 });
await queue.initialize();
const mailboxStore = new SqliteMailboxStore('./zukhruf.mailbox.sqlite');
const approvalMutex = new SqliteApprovalMutex('./zukhruf.approvals.sqlite');

const runtime = new AgentRuntime(declaration, {
  store: new SqliteContextStore('./zukhruf.sqlite'),
  streamStore: new SqliteStreamStore('./zukhruf.streams.sqlite'),
  queue,
  mailboxStore,
  approvalMutex,
});

const conversation = {
  chatId: `cli-${crypto.randomUUID()}`,
  userId: process.env.USER ?? 'local',
};
const worker = await runtime.work({ concurrency: 4 });

const first = await runtime.enqueue(conversation, {
  id: crypto.randomUUID(),
  input,
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
  `\n\n[detached after ${deltas} chunks] the root keeps running, and spawn_agent can start the specialist in a separate chat.\n`,
);

const resumed = await runtime.observe(conversation).resume();
if (!resumed) {
  throw new Error('resume() found no active stream — durability broken');
}
console.log(
  '[reconnected via resume()] replaying the root turn from chunk 0, then tailing to completion:\n',
);
await printer.readableStream(resumed);

console.log(
  '\n[root turn done] waiting for the independently queued specialist FINAL_ANSWER…\n',
);
await waitForSpecialistCompletion();

const second = await runtime.enqueue(conversation, {
  id: crypto.randomUUID(),
  input: 'Summarize the specialist FINAL_ANSWER in one short sentence.',
});
console.log(
  `[root turn ${second.id} enqueued] it drains the durable child completion before sampling:\n`,
);
await printer.readableStream(second.stream);
console.log(
  `\n[done] root and specialist used independent histories, streams, mailboxes, and queue keys. Root container "sandbox-${conversation.chatId}" remains attached to its chat.\n`,
);

await worker[Symbol.asyncDispose]();
await boss.stop({ graceful: false });
mailboxStore.close();
approvalMutex.close();
process.exit(0);

async function waitForSpecialistCompletion(): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (await mailboxStore.hasPending(conversation)) return;

    const history = await runtime.observe(conversation).engine.getMessages();
    if (
      history.some((message) => {
        if (!isRecord(message.metadata)) return false;
        const communication = message.metadata.interAgentCommunication;
        return isRecord(communication) && communication.type === 'FINAL_ANSWER';
      })
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('timed out waiting for the specialist FINAL_ANSWER');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
