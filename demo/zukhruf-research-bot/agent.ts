import { openai } from '@ai-sdk/openai';

import { fileTelemetry } from '@deepagents/devtool-traces';
import { defineAgent } from '@deepagents/experimental/zukhruf';

import instructions from './instructions.ts';
import sandbox from './sandbox.ts';
import { planner } from './subagents/planner.ts';

export const traceTelemetry = fileTelemetry({
  includeTimestamp: true,
  path: './telemetry.json',
});

export default defineAgent({
  name: 'ResearchBot',
  model: openai('gpt-5.6-luna'),
  sandbox,
  instructions,
  subagents: [planner],
  plugins: [traceTelemetry],
});
