import { openai } from '@ai-sdk/openai';

import {
  ContextEngine,
  InMemoryContextStore,
  agent,
  role,
} from '@deepagents/context';

import { subagentSandbox } from './sandbox.ts';

/**
 * The research subagent — a normal `agent()` with the OpenAI hosted
 * `web_search` tool. The root wires it via `asTool()`; each call forks this
 * context and runs one search-and-summarize loop.
 */
const context = new ContextEngine({
  store: new InMemoryContextStore(),
  chatId: 'researcher',
  userId: 'research-bot',
});
context.set(
  role(
    'You are a research assistant. Given a search term, search the web and produce a concise summary of the results. Capture the main points succinctly — this feeds a report writer, so keep the essence and drop the fluff. Return only the summary.',
  ),
);

export const researcher = agent({
  name: 'ResearchAgent',
  model: openai.responses('gpt-4.1'),
  context,
  sandbox: subagentSandbox,
  tools: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    web_search: (openai as any).tools.webSearch({ searchContextSize: 'low' }),
  },
});
