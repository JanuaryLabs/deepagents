import { openai } from '@ai-sdk/openai';

import { defineAgent } from '@deepagents/experimental/zukhruf';

import instructions from './instructions.ts';
import sandbox from './sandbox.ts';

export default defineAgent({
  name: 'skill-authority',
  description: 'Creates, validates, and publishes missing reusable skills.',
  model: openai('gpt-5.6-terra'),
  sandbox,
  instructions,
});
