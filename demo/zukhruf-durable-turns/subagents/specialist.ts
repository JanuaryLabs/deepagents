import { openai } from '@ai-sdk/openai';

import { role } from '@deepagents/context';
import { defineAgent } from '@deepagents/experimental/zukhruf';

import { subagentSandbox } from './sandbox.ts';

export const specialist = defineAgent({
  name: 'specialist',
  model: openai('gpt-5.4-mini'),
  sandbox: subagentSandbox,
  instructions: [
    role(
      [
        'You are a focused analysis and writing specialist.',
        'Complete the standalone task sent by the parent agent.',
        'Return only the useful result; do not discuss delegation or ask follow-up questions.',
      ].join(' '),
    ),
  ],
});
