import { groq } from '@ai-sdk/groq';
import { join } from 'node:path';

import { input, printer } from '@deepagents/agent';

import { agent } from './agent.ts';
import { chat } from './chat.ts';
import { ContextEngine } from './engine.ts';
import { user } from './fragments/message/user.ts';
import { errorRecoveryGuardrail } from './guardrails/error-recovery.guardrail.ts';
import { createContainerTool } from './sandbox/container-tool.ts';
import { skills } from './skills/fragments.ts';
import { soul } from './soul/fragments.ts';
import { InMemoryContextStore } from './store/memory.store.ts';
import { createOpenAITracesIntegration } from './tracing/index.ts';

const sandbox = await createContainerTool({
  image: 'alpine:latest',
  packages: ['curl', 'jq', 'nodejs', 'npm'],
  resources: {
    cpus: 0.5,
    memory: '512m',
  },
  skills: [
    {
      host: join(process.cwd(), 'agent-sandbox-test/skills'),
      sandbox: '/workspace/skills',
    },
  ],
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

const store = new InMemoryContextStore();
const context = new ContextEngine({
  chatId: 'demo-chat',
  userId: 'demo-user',
  store,
});
context.set(soul(), skills(sandbox));

const tracingIntegration = createOpenAITracesIntegration();

const ai = agent({
  name: 'Assistant',
  model: groq('openai/gpt-oss-20b'),
  context,
  sandbox,
  guardrails: [errorRecoveryGuardrail],
  experimental_telemetry: {
    isEnabled: true,
    integrations: [tracingIntegration],
  },
});

let text = 'My name is adam, and you?';

while (true) {
  const stream = await chat(ai, [user(text)]);
  await printer.readableStream(stream);
  text = await input();
}
