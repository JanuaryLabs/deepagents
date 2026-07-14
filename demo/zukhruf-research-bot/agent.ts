import { openai } from '@ai-sdk/openai';

import { createFileTelemetry } from '@deepagents/context/telemetry/file';
import { defineAgent } from '@deepagents/experimental/zukhruf';

import instructions from './instructions.ts';
import sandbox from './sandbox.ts';
import { planner } from './subagents/planner.ts';

export default defineAgent({
  name: 'ResearchBot',
  model: openai('gpt-5.6-luna'),
  sandbox,
  instructions,
  subagents: [planner],
  telemetry: {
    integrations: createFileTelemetry({
      includeTimestamp: true,
      path: './telemetry.json',
    }),
  },
});
