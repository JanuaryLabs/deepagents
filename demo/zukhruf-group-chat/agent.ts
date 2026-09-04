import { openai } from '@ai-sdk/openai';

import { defineAgent } from '@deepagents/experimental/zukhruf';

import instructions from './instructions.ts';
import { managerSandbox } from './sandbox.ts';
import { participant } from './subagents/participant/agent.ts';
import { telemetry } from './telemetry.ts';

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
  telemetry: telemetry('manager'),
  subagents: [community, environment, budget],
  instructions,
});
