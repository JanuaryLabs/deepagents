import { openai } from '@ai-sdk/openai';
import { join } from 'node:path';

import { fileTelemetry } from '@deepagents/devtool-traces';
import { defineAgent } from '@deepagents/experimental/zukhruf';

import instructions from './instructions.ts';
import sandbox from './sandbox.ts';

export default defineAgent({
  name: 'SimpleAgent',
  model: openai('gpt-5.6-luna'),
  sandbox,
  instructions,
  plugins: [
    fileTelemetry({
      append: false,
      path: join(import.meta.dirname, 'telemetry.jsonl'),
    }),
  ],
});
