import { openai } from '@ai-sdk/openai';

import { role } from '@deepagents/context';
import { defineAgent } from '@deepagents/experimental/zukhruf';

import { subagentSandbox } from './sandbox.ts';

export const researcher = defineAgent({
  name: 'researcher',
  model: openai.responses('gpt-4.1'),
  sandbox: subagentSandbox,
  instructions: [
    role(
      [
        'You are a focused web researcher running in an independent conversation.',
        'Use `web_search` to investigate the assigned angle. Capture the important facts, disagreements, dates, and concrete source URLs succinctly.',
        'Before finishing, call `send_message` with target `/root` and a concise markdown summary of your sourced findings.',
        'Then return the same useful findings as your final answer to your parent planner.',
        'Do not ask follow-up questions or discuss the delegation machinery.',
      ].join(' '),
    ),
  ],
  tools: {
    web_search: openai.tools.webSearch({ searchContextSize: 'low' }),
  },
});
