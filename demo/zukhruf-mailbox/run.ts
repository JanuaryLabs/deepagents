import { PGlite } from '@electric-sql/pglite';
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { InMemoryFs } from 'just-bash';
import { PgBoss, fromPglite } from 'pg-boss';

import {
  InMemoryContextStore,
  PollingChangeSource,
  SqliteStreamStore,
  StreamManager,
  createBashTool,
  createVirtualSandbox,
} from '@deepagents/context';
import {
  AgentRuntime,
  MessageDeliveryMode,
  PgBossTurnQueue,
  SqliteMailboxStore,
  type TurnRef,
  createInterAgentCommunication,
  defineAgent,
} from '@deepagents/experimental/zukhruf';

const root = { chatId: 'root', userId: 'demo-user' };
const researcher = { chatId: 'researcher', userId: 'demo-user' };
const promptReceived = Promise.withResolvers<unknown>();

const usage = {
  inputTokens: {
    total: 1,
    noCache: 1,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
} as const;

const model = new MockLanguageModelV4({
  doStream: async ({ prompt }) => {
    const mailboxMessages = findMailboxMessages(prompt);
    promptReceived.resolve(prompt);
    return {
      stream: simulateReadableStream({
        chunks: [
          { type: 'text-start', id: 'answer' },
          {
            type: 'text-delta',
            id: 'answer',
            delta: `Processed ${mailboxMessages.length} mailbox messages in FIFO order.`,
          },
          { type: 'text-end', id: 'answer' },
          {
            type: 'finish',
            finishReason: { unified: 'stop', raw: '' },
            usage,
          },
        ],
      }),
    };
  },
});

const declaration = defineAgent({
  name: 'MailboxResearcher',
  model,
  instructions: [],
  sandbox: async () =>
    createBashTool({
      sandbox: await createVirtualSandbox({ fs: new InMemoryFs() }),
    }),
});

await using resources = new AsyncDisposableStack();

const pglite = resources.adopt(new PGlite(), (pglite) => pglite.close());
const boss = resources.adopt(
  new PgBoss({ db: fromPglite(pglite), backend: 'pglite' }),
  (boss) => boss.stop({ graceful: false }),
);
boss.on('error', (error) => console.error('[queue error]', error));
await boss.start();

const turnQueue = new PgBossTurnQueue(boss, {
  pollingIntervalSeconds: 0.5,
  schema: 'pgboss',
});
await turnQueue.initialize();

const streamStore = resources.adopt(
  new SqliteStreamStore(':memory:'),
  (store) => store.close(),
);
const streams = new StreamManager({
  store: streamStore,
  changeSource: new PollingChangeSource({ reads: streamStore }),
});
const mailboxStore = resources.use(new SqliteMailboxStore(':memory:'));
const runtime = new AgentRuntime(declaration, {
  store: new InMemoryContextStore(),
  streams,
  queue: turnQueue,
  mailboxStore,
});

console.log('\n1. Queue three messages without waking the researcher.');
for (const content of [
  'Collect the market size.',
  'Use primary sources.',
  'Include citations.',
]) {
  await runtime.deliver(
    createInterAgentCommunication({
      author: root,
      recipient: researcher,
      content,
    }),
    MessageDeliveryMode.QueueOnly,
  );
}

const jobsBeforeWake = await boss.findJobs(turnQueue.queue, {
  key: researcher.chatId,
});
console.log({
  pendingMail: await mailboxStore.hasPending(researcher),
  scheduledTurns: jobsBeforeWake.length,
});

console.log('\n2. Deliver one trigger-turn message.');
await runtime.deliver(
  createInterAgentCommunication({
    author: root,
    recipient: researcher,
    content: 'Start the research turn now.',
  }),
  MessageDeliveryMode.TriggerTurn,
);

const jobsAfterWake = await boss.findJobs(turnQueue.queue, {
  key: researcher.chatId,
});
const wake = jobsAfterWake[0]?.data as TurnRef | undefined;
if (!wake || wake.kind !== 'mailbox') {
  throw new Error('expected one mailbox wake turn');
}
console.log({
  scheduledTurns: jobsAfterWake.length,
  wakeKind: wake.kind,
  payloadLivesInMailbox: !('input' in wake),
});

console.log('\n3. Start the worker and inspect the real model prompt.');
resources.use(await runtime.work());
const prompt = await withTimeout(promptReceived.promise, 5_000);
for (const [index, message] of findMailboxMessages(prompt).entries()) {
  console.log(`\n--- model message ${index + 1} ---\n${message}`);
}

await waitForStatus(streamStore, wake.streamId, 'completed');
const history = await runtime.observe(researcher).engine.getMessages();
const mailboxHistory = history.filter(
  (message) =>
    message.role === 'user' &&
    message.parts.some(
      (part) => part.type === 'text' && part.text.startsWith('Message Type:'),
    ),
);

console.log('\n4. Verify consumption and durable history.');
console.log({
  modelVisibleMailboxMessages: findMailboxMessages(prompt).length,
  durableMailboxHistoryItems: mailboxHistory.length,
  pendingAfterTurn: await mailboxStore.hasPending(researcher),
});

function findMailboxMessages(value: unknown): string[] {
  const messages: string[] = [];

  function visit(candidate: unknown): void {
    if (typeof candidate === 'string') {
      if (candidate.startsWith('Message Type:')) messages.push(candidate);
      return;
    }
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item);
      return;
    }
    if (candidate && typeof candidate === 'object') {
      for (const item of Object.values(candidate)) visit(item);
    }
  }

  visit(value);
  return messages;
}

async function waitForStatus(
  store: SqliteStreamStore,
  streamId: string,
  expected: string,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if ((await store.getStreamStatus(streamId)) === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${streamId} to become ${expected}`);
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error('timed out waiting for the model prompt')),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
