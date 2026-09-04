import { openai } from '@ai-sdk/openai';

import { defineAgent } from '@deepagents/experimental/zukhruf';

import researcher from '../researcher/agent.ts';
import instructions from './instructions.ts';
import sandbox from './sandbox.ts';

export default defineAgent({
  name: 'planner',
  model: openai('gpt-4.1'),
  sandbox,
  subagents: [researcher],
  instructions,
});
