import { openai } from '@ai-sdk/openai';

import { defineAgent } from '@deepagents/experimental/zukhruf';

import instructions from './instructions.ts';
import sandbox from './sandbox.ts';

export default defineAgent({
  name: 'researcher',
  model: openai.responses('gpt-4.1'),
  sandbox,
  instructions,
  tools: {
    web_search: openai.tools.webSearch({ searchContextSize: 'low' }),
  },
});
