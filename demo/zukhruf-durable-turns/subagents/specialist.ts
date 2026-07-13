import { openai } from '@ai-sdk/openai';

import {
  ContextEngine,
  InMemoryContextStore,
  agent,
  role,
} from '@deepagents/context';

import { subagentSandbox } from './sandbox.ts';

const context = new ContextEngine({
  store: new InMemoryContextStore(),
  chatId: 'durable-turns-specialist',
  userId: 'durable-turns-demo',
});
context.set(
  role(
    [
      'You are a focused analysis and writing specialist.',
      'Complete the standalone task provided by the parent agent.',
      'Return only the useful result; do not discuss delegation or ask follow-up questions.',
    ].join(' '),
  ),
);

export const specialist = agent({
  name: 'SpecialistAgent',
  model: openai('gpt-5.4-mini'),
  context,
  sandbox: subagentSandbox,
});
