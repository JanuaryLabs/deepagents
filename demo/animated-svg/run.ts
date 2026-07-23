import { PGlite } from '@electric-sql/pglite';
import { PgBoss, fromPglite } from 'pg-boss';

import { printer } from '@deepagents/agent';
import { SqliteContextStore, SqliteStreamStore } from '@deepagents/context';
import {
  AgentRuntime,
  PgBossTurnQueue,
  SqliteMailboxStore,
} from '@deepagents/experimental/zukhruf';

import declaration from './agent.ts';

const prompt =
  process.argv.slice(2).join(' ') ||
  `Design an animated SVG employee identification card. Size 350x220 (viewBox 0 0 350 220), rounded corners 12px, 2px #e5e7eb stroke, subtle drop shadow.
Background: vertical gradient #dcfce7 (top) to #dbeafe (bottom) with a low-opacity geometric pattern overlay.
Layout: an ~80px left avatar column (60px circle, bg #94a3b8, white 3px border) and a right column with name "Alex Johnson" (18px bold #1f2937), ID "EMP-2024-5847" (14px #6b7280), contact lines (12px #374151), and a "CURRENT PROJECT:" label with value "Digital Transformation Initiative" (12px #059669).
Animations: gentle avatar pulse (scale 1<->1.05 every 3s), 3-4 floating particles (r=2 #10b981), a diagonal shimmer sweep every 8s clipped to the card, and a border pulse (#e5e7eb<->#10b981 on a 6s loop).`;

const database = new PGlite('./animated-svg.queue');
const boss = new PgBoss({
  db: fromPglite(database),
  backend: 'pglite',
});
boss.on('error', (error) => console.error('[queue error]', error));
await boss.start();
const queue = new PgBossTurnQueue(boss, {
  pollingIntervalSeconds: 0.5,
  schema: 'pgboss',
});
await queue.initialize();
const mailboxStore = new SqliteMailboxStore('./animated-svg.mailbox.sqlite');

const runtime = new AgentRuntime(declaration, {
  store: new SqliteContextStore('./animated-svg.sqlite'),
  streamStore: new SqliteStreamStore('./animated-svg.streams.sqlite'),
  queue,
  mailboxStore,
});

const conversation = {
  chatId: 'animated-svg',
  userId: process.env.USER ?? 'local',
};
const worker = await runtime.work();

const turn = await runtime.enqueue(conversation, {
  id: crypto.randomUUID(),
  input: prompt,
});
console.log(
  `\n[turn ${turn.id} enqueued] the worker is generating the animated SVG — streaming below:\n`,
);

await printer.readableStream(turn.stream);

console.log(
  '\n[done] the agent called save_svg → ./animated_svg_output.svg (open it in a browser).\n',
);

await worker[Symbol.asyncDispose]();
await boss.stop({ graceful: false });
mailboxStore.close();
process.exit(0);
