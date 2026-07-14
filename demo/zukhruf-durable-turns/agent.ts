import { openai } from '@ai-sdk/openai';

import { defineAgent } from '@deepagents/experimental/zukhruf';

import instructions from './instructions.ts';
import sandbox from './sandbox.ts';
import { specialist } from './subagents/specialist.ts';

export default defineAgent({
  name: 'DurableTurnsAgent',
  model: openai('gpt-5.4-mini'),
  sandbox,
  instructions,
  subagents: [specialist],
});
