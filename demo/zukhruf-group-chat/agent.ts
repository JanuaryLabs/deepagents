import { openai } from '@ai-sdk/openai';
import { join } from 'node:path';

import { fileTelemetry } from '@deepagents/devtool/traces';
import { defineAgent } from '@deepagents/experimental/zukhruf';

import { groupChatHostDirectory } from './environment.ts';
import instructions from './instructions.ts';
import { managerSandbox } from './sandbox.ts';
import { participant } from './subagents/participant/agent.ts';

const community = participant(
  'community',
  'Evaluate accessibility, likely resident feedback, equity, and usage patterns.',
);
const environment = participant(
  'environment',
  'Evaluate ecological impact, sustainability, native vegetation, and environmental constraints.',
);
const budget = participant(
  'budget',
  'Evaluate construction cost, maintenance, staffing, delivery risk, and long-term operations.',
);

export default defineAgent({
  name: 'group-chat-manager',
  model: openai('gpt-5.6-terra'),
  sandbox: managerSandbox,
  plugins: [
    fileTelemetry({
      path: join(groupChatHostDirectory, 'telemetry.jsonl'),
    }),
  ],
  subagents: [community, environment, budget],
  instructions,
});
