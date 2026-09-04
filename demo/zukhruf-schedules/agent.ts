import { openai } from '@ai-sdk/openai';
import { join } from 'node:path';

import { fileTelemetry } from '@deepagents/devtool-traces';
import { defineAgent } from '@deepagents/experimental/zukhruf';
import { schedules } from '@deepagents/experimental/zukhruf/schedules';

import instructions from './instructions.ts';
import sandbox from './sandbox.ts';

export const scheduled = schedules({
  queue: 'scheduled-tasks',
  reconciliationIntervalMs: 5_000,
  workerOptions: { pollingIntervalSeconds: 0.5 },
});
export const traceTelemetry = fileTelemetry({
  path: join(import.meta.dirname, 'telemetry.jsonl'),
});
export default defineAgent({
  name: 'scheduled-assistant',
  model: openai('gpt-5.6-luna'),
  sandbox,
  instructions,
  plugins: [scheduled, traceTelemetry],
});
