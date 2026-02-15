import {
  type UIMessage,
  extractReasoningMiddleware,
  generateId,
  wrapLanguageModel,
} from 'ai';
import { join } from 'node:path';

import { input, last, lmstudio, minimax, printer } from '@deepagents/agent';

import { agent } from './agent.ts';
import { ContextEngine } from './engine.ts';
import { assistant, message } from './fragments.ts';
import { errorRecoveryGuardrail } from './guardrails/error-recovery.guardrail.ts';
import { createContainerTool } from './sandbox/container-tool.ts';
import { skills } from './skills/fragments.ts';
import { soul } from './soul/fragments.ts';
import { InMemoryContextStore } from './store/memory.store.ts';

const { bash, sandbox } = await createContainerTool({
  image: 'alpine:latest',
  packages: ['curl', 'jq', 'nodejs', 'npm'],
  resources: {
    cpus: 0.5,
    memory: '512m',
  },
  mounts: [
    {
      hostPath: join(process.cwd(), 'agent-sandbox-test'),
      containerPath: '/workspace',
      readOnly: false,
    },
  ],
});

let disposed = false;
async function disposeSandbox() {
  if (disposed) return;
  disposed = true;
  await sandbox.dispose();
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

const messages: UIMessage[] = [
  {
    id: generateId(),
    role: 'user',
    parts: [{ type: 'text', text: 'My name is adam, and you?' }],
  },
];
const store = new InMemoryContextStore();
const context = new ContextEngine({
  chatId: 'demo-chat',
  userId: 'demo-user',
  store,
});
context.set(
  soul(),
  skills({
    paths: [
      {
        host: join(process.cwd(), 'agent-sandbox-test/skills'),
        sandbox: '/workspace/skills',
      },
    ],
  }),
);
shutdown(disposeSandbox);

while (true) {
  const userMsg = messages.at(-1);
  if (userMsg) {
    context.set(message(userMsg));
    await context.save();
  }

  const ai = agent({
    name: 'Assistant',
    // model: wrapLanguageModel({
    //   model: minimax('MiniMax-M2.5'),
    //   middleware: extractReasoningMiddleware({ tagName: 'think' }),
    // }),
    model: lmstudio('liquid/lfm2.5-1.2b'),
    // model: groq('moonshotai/kimi-k2-instruct-0905'),
    context: context,
    tools: { bash },
    guardrails: [errorRecoveryGuardrail],
  });

  const result = await ai.stream({});
  const stream = result.toUIMessageStream({
    sendStart: true,
    sendFinish: true,
    sendReasoning: true,
    sendSources: true,
    originalMessages: messages,
    generateMessageId: generateId,
    onFinish: async ({ responseMessage }) => {
      context.set(assistant(responseMessage));
      await context.save();

      const messageUsage = await result.totalUsage;
      await context.trackUsage(messageUsage);
      const chatUsage = context.chat?.metadata?.usage as
        | Record<string, number>
        | undefined;

      console.log(
        `[Usage] Message: ${messageUsage.inputTokens ?? 0} in, ${messageUsage.outputTokens ?? 0} out, ${messageUsage.totalTokens ?? 0} total` +
          ` | Chat: ${chatUsage?.inputTokens ?? 0} in, ${chatUsage?.outputTokens ?? 0} out, ${chatUsage?.totalTokens ?? 0} total`,
      );
    },
  });
  await printer.readableStream(stream);
  await last(stream);
  messages.push({
    id: generateId(),
    role: 'user',
    parts: [{ type: 'text', text: await input() }],
  });
}
