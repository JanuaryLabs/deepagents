import { openai } from '@ai-sdk/openai';
import { join } from 'node:path';

import { createFileTelemetry } from '@deepagents/context/telemetry/file';
import { defineAgent } from '@deepagents/experimental/zukhruf';

import instructions from './instructions.ts';
import sandbox from './sandbox.ts';

export default defineAgent({
  name: 'SimpleAgent',
  model: openai('gpt-5.6-luna'),
  sandbox,
  instructions,
  telemetry: {
    integrations: createFileTelemetry({
      append: false,
      path: join(import.meta.dirname, 'telemetry.jsonl'),
    }),
  },
});
