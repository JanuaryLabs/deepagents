import { openrouter } from '@openrouter/ai-sdk-provider';

import { defineAgent } from '@deepagents/experimental/zukhruf';

import instructions from './instructions.ts';
import sandbox from './sandbox.ts';

export default defineAgent({
  name: 'animated-svg-generator',
  model: openrouter('deepseek/deepseek-v4-flash'),
  sandbox,
  instructions,
});
