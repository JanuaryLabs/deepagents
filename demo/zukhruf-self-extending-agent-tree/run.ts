import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { AgentRuntime, renderTurn } from '@deepagents/experimental/zukhruf';

import root from './agent.ts';
import stack from './stack.ts';

mkdirSync(join(import.meta.dirname, 'workspace'), { recursive: true });
mkdirSync(join(import.meta.dirname, 'skills'), { recursive: true });

const input = process.argv.slice(2).join(' ').trim();
if (!input) {
  throw new Error('Usage: node --env-file=.env run.ts "Describe the task"');
}

const runtime = new AgentRuntime(root);
await using host = await runtime.initialize(stack);
await using worker = await host.work({ concurrency: 4 });

const turn = await host.enqueue(
  { chatId: crypto.randomUUID(), userId: 'demo' },
  {
    trigger: 'submit-message',
    message: {
      id: crypto.randomUUID(),
      role: 'user',
      parts: [{ type: 'text', text: input }],
    },
  },
);
await renderTurn(turn.stream);
