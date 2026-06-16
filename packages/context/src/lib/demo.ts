import { openai } from '@ai-sdk/openai';

import { input, printer } from '@deepagents/agent';

import { agent } from './agent.ts';
import { chat } from './chat.ts';
import { ContextEngine } from './engine.ts';
import { reminder, user } from './fragments/message/user.ts';
import { afterTurn } from './fragments/reminders/turn-predicates.ts';
import { createBashTool } from './sandbox/bash-tool.ts';
import { createDockerSandbox } from './sandbox/docker-sandbox.ts';
import { SqliteContextStore } from './store/sqlite.store.ts';

const sandbox = await createBashTool({
  sandbox: await createDockerSandbox({
    name: 'demo-sandbox',
    image: 'node:lts-alpine',
    resources: {
      cpus: 0.5,
      memory: '64mb',
    },
  }),
});

let disposed = false;
async function disposeSandbox() {
  if (disposed) return;
  disposed = true;
  await sandbox.sandbox.dispose();
}

function shutdown(fn: () => Promise<void>) {
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(signal, async () => {
      await fn();
      process.exit(0);
    });
  }

  process.on('uncaughtException', async (err) => {
    console.error(err);
    await fn();
    process.exit(1);
  });
}
shutdown(disposeSandbox);

const store = new SqliteContextStore('./demo-context.sqlite');
const context = new ContextEngine({
  chatId: 'demo-chat',
  userId: 'demo-user',
  store,
});
context.set(
  reminder('make sure to list learn about available file system tools', {
    when: afterTurn(1),
    target: 'tool-output',
  }),
);

const ai = agent({
  name: 'Assistant',
  model: openai('gpt-5.4-nano'),
  context,
  sandbox,
});

let text = 'List the files in /tmp using bash, then tell me your name.';
while (true) {
  console.log('Turn: ', await context.getTurnCount());
  await context.continue(user(text));
  const stream = await chat(ai);
  await printer.readableStream(stream);
  text = await input();
}
