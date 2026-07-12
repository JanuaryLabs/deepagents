import { openai } from '@ai-sdk/openai';

import { input, printer } from '@deepagents/agent';

import { agent } from './agent.ts';
import { chat } from './chat.ts';
import { ContextEngine } from './engine.ts';
import { user } from './fragments/message/user.ts';
import { afterTurn, once, or, reminder } from './fragments/reminders/index.ts';
import { createBashTool } from './sandbox/bash-tool.ts';
import { createMicrosandboxSandbox } from './sandbox/microsandbox-sandbox.ts';
import { SqliteContextStore } from './store/sqlite.store.ts';
import { createFileTelemetry } from './telemetry/file/file-telemetry.ts';

await using backend = await createMicrosandboxSandbox({
  image: 'node:lts-alpine',
});
const sandbox = await createBashTool({
  sandbox: backend,
});

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.once(signal, async () => {
    await backend[Symbol.asyncDispose]();
    process.exit(0);
  });
}

const context = new ContextEngine({
  chatId: 'demo-chat',
  userId: 'demo-user',
  store: new SqliteContextStore('./demo-context.sqlite'),
});
context.set(
  reminder('make sure to list learn about available file system tools', {
    when: or(afterTurn(1), once('just-once')),
    target: 'tool-output',
  }),
);

const ai = agent({
  name: 'Assistant',
  model: openai('gpt-5.6-luna'),
  context,
  sandbox,
  telemetry: {
    integrations: createFileTelemetry({
      includeTimestamp: true,
      path: './telemetry.json',
    }),
  },
});

let text = 'List the files in /tmp using bash, then tell me your name.';
while (true) {
  console.log('Turn: ', await context.getTurnCount());
  await context.continue(user(text));
  const stream = await chat(ai);
  await printer.readableStream(stream);
  text = await input();
}
