import { PGlite } from '@electric-sql/pglite';
import { PgBoss, fromPglite } from 'pg-boss';

import { printer } from '@deepagents/agent';
import { SqliteContextStore, SqliteStreamStore } from '@deepagents/context';
import {
  PgBossTurnQueue,
  createRuntime,
} from '@deepagents/experimental/zukhruf';

import declaration from './agent.ts';

const input =
  process.argv.slice(2).join(' ') ||
  'Use the specialist to list the numbers 1 through 20, one per line, each with a one-word note.';

const boss = new PgBoss({
  db: fromPglite(new PGlite('./zukhruf.queue')),
  backend: 'pglite',
});
boss.on('error', (error) => console.error('[queue error]', error));
await boss.start();
const queue = new PgBossTurnQueue(boss, { pollingIntervalSeconds: 0.5 });
await queue.initialize();

const runtime = createRuntime(declaration, {
  store: new SqliteContextStore('./zukhruf.sqlite'),
  streamStore: new SqliteStreamStore('./zukhruf.streams.sqlite'),
  queue,
});

const conversation = { chatId: 'cli', userId: process.env.USER ?? 'local' };
const worker = await runtime.work();

const first = await runtime.enqueue(conversation, {
  id: crypto.randomUUID(),
  input,
});
console.log(
  `\n[turn ${first.id} enqueued] reading a few chunks, then detaching…\n`,
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
  `\n\n[detached after ${deltas} chunks] the reader is gone — the worker keeps driving the turn.\n`,
);

const second = await runtime.enqueue(conversation, {
  id: crypto.randomUUID(),
  input: 'Summarize what you just did in one short sentence.',
});
console.log(
  `[turn ${second.id} enqueued mid-turn] same chat, so it waits its turn (strict FIFO).\n`,
);

const resumed = await runtime.observe(conversation).resume();
if (!resumed) {
  throw new Error('resume() found no active stream — durability broken');
}
console.log(
  '[reconnected via resume()] replaying turn 1 from chunk 0, then tailing to completion:\n',
);
await printer.readableStream(resumed);

console.log('\n[turn 1 done] now the queued turn 2 starts — tailing it:\n');
await printer.readableStream(second.stream);
console.log(
  `\n[done] both turns survived the detach; container "sandbox-${conversation.chatId}" is kept for this chat.\n`,
);

await worker[Symbol.asyncDispose]();
await boss.stop({ graceful: false });
process.exit(0);
