import { parseArgs } from 'node:util';

import { AgentRuntime, renderTurn } from '@deepagents/experimental/zukhruf';

import { createCodingAgent } from './agent.ts';
import stack from './stack.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    workspace: { type: 'string', short: 'C' },
  },
});
const input = positionals.join(' ').trim();
if (!input) {
  throw new Error(
    'Usage: node run.ts --workspace /path/to/repo "Describe the feature"',
  );
}
if (!process.env.OPENAI_API_KEY) {
  throw new Error('OPENAI_API_KEY is required');
}

const root = createCodingAgent(values.workspace ?? process.cwd());
const runtime = new AgentRuntime(root);
await using host = await runtime.initialize(stack);
await using worker = await host.work({ concurrency: 4 });

const turn = await host.enqueue(
  { chatId: crypto.randomUUID(), userId: process.env.USER ?? 'demo' },
  {
    message: {
      id: crypto.randomUUID(),
      role: 'user',
      parts: [{ type: 'text', text: input }],
    },
    trigger: 'submit-message',
  },
);
await renderTurn(turn.stream);
