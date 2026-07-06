import { PGlite } from '@electric-sql/pglite';
import { PgBoss, fromPglite } from 'pg-boss';

import { printer } from '@deepagents/agent';
import { SqliteContextStore, SqliteStreamStore } from '@deepagents/context';
import {
  PgBossTurnQueue,
  createRuntime,
} from '@deepagents/experimental/zukhruf';

import declaration from './agent.ts';

const query =
  process.argv.slice(2).join(' ') ||
  'What are the most promising approaches to grid-scale energy storage in 2026?';

const boss = new PgBoss({
  db: fromPglite(new PGlite('./zukhruf-research.queue')),
  backend: 'pglite',
});
boss.on('error', (error) => console.error('[queue error]', error));
await boss.start();
const queue = new PgBossTurnQueue(boss, { pollingIntervalSeconds: 0.5 });
await queue.initialize();

const runtime = createRuntime(declaration, {
  store: new SqliteContextStore('./zukhruf-research.sqlite'),
  streamStore: new SqliteStreamStore('./zukhruf-research.streams.sqlite'),
  queue,
});

const conversation = {
  chatId: 'research-cli',
  userId: process.env.USER ?? 'local',
};
const worker = await runtime.work();

const turn = await runtime.enqueue(conversation, {
  id: crypto.randomUUID(),
  input: query,
});
console.log(`\n[turn ${turn.id} enqueued] query: ${query}`);
console.log('reading a few chunks, then detaching mid-research…\n');

const reader = turn.stream.getReader();
let printed = 0;
let seen = 0;
while (seen < 80 && printed < 6) {
  const { done, value } = await reader.read();
  if (done) break;
  seen += 1;
  if (value.type === 'text-delta') {
    process.stdout.write(value.delta);
    printed += 1;
  }
}
await reader.cancel();
console.log(
  `\n\n[detached] the worker keeps planning, searching, and writing while nobody is watching.\n`,
);

const resumed = await runtime.observe(conversation).resume();
if (!resumed) {
  throw new Error('resume() found no active stream — durability broken');
}
console.log(
  '[reconnected via resume()] replaying from chunk 0, then tailing to the finished report:\n',
);
await printer.readableStream(resumed);

console.log('\n[done] the research turn survived a mid-stream detach.\n');

await worker[Symbol.asyncDispose]();
await boss.stop({ graceful: false });
process.exit(0);
