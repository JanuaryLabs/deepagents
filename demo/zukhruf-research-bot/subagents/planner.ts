import { openai } from '@ai-sdk/openai';

import {
  ContextEngine,
  InMemoryContextStore,
  agent,
  role,
} from '@deepagents/context';

import { subagentSandbox } from './sandbox.ts';

/**
 * The planner subagent — a normal `agent()`. Its context is seeded with its
 * system role; when the root wires it via `asTool()`, each call `fork()`s this
 * context (carrying the role) and appends the query as a user message.
 */
const context = new ContextEngine({
  store: new InMemoryContextStore(),
  chatId: 'planner',
  userId: 'research-bot',
});
context.set(
  role(
    'You are a research planner. Given a query, produce a set of web searches that together best answer it. Output between 5 and 10 searches, each as a line with the search term and why it matters.',
  ),
);

export const planner = agent({
  name: 'PlannerAgent',
  model: openai('gpt-4.1'),
  context,
  sandbox: subagentSandbox,
});
