import { openai } from '@ai-sdk/openai';
import { join } from 'node:path';

import { fileTelemetry } from '@deepagents/devtool-traces';
import { defineAgent } from '@deepagents/experimental/zukhruf';
import { uploads } from '@deepagents/experimental/zukhruf/uploads';

import instructions from './instructions.ts';
import sandbox from './sandbox.ts';

export const traceTelemetry = fileTelemetry({
  path: join(import.meta.dirname, 'telemetry.jsonl'),
});
export const imageUploads = uploads({ directory: '/workspace/.uploads' });

export default defineAgent({
  name: 'SimpleAgent',
  model: openai('gpt-5.6-luna'),
  sandbox,
  instructions,
  plugins: [imageUploads, traceTelemetry],
});
