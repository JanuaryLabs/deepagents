import { openai } from '@ai-sdk/openai';

import { role } from '@deepagents/context';
import { defineAgent } from '@deepagents/experimental/zukhruf';

import { researcher } from './researcher.ts';
import { subagentSandbox } from './sandbox.ts';

export const planner = defineAgent({
  name: 'planner',
  model: openai('gpt-4.1'),
  sandbox: subagentSandbox,
  subagents: [researcher],
  instructions: [
    role(
      [
        'You are a research planner running in an independent conversation.',
        'Given a standalone research query, choose exactly three complementary web-research angles that together answer it well.',
        'Call `spawn_agent` three times with `agent_type` set to `researcher` and task names `source-1`, `source-2`, and `source-3`.',
        'Each message must contain the original query, one assigned angle, and an instruction to send sourced findings directly to the canonical path `/root`.',
        '`spawn_agent` returns immediately. Do not wait for the researchers or invent their findings.',
        'After dispatching all three, return a short summary of the angles you assigned.',
      ].join(' '),
    ),
  ],
});
