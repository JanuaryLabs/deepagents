import { openai } from '@ai-sdk/openai';

import { defineAgent } from '@deepagents/experimental/zukhruf';

import instructions from './instructions.ts';
import sandbox from './sandbox.ts';

export default defineAgent({
  name: 'general-task',
  description: 'Executes a delegated task using the skills named by Root.',
  model: openai('gpt-5.6-terra'),
  sandbox,
  instructions,
});
