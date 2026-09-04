import { openai } from '@ai-sdk/openai';

import { defineAgent } from '@deepagents/experimental/zukhruf';

import { telemetry } from '../../telemetry.ts';
import { participantInstructions } from './instructions.ts';
import sandbox from './sandbox.ts';

export function participant(name: string, expertise: string) {
  return defineAgent({
    name,
    model: openai('gpt-5.6-luna'),
    sandbox,
    telemetry: telemetry(name),
    instructions: participantInstructions(name, expertise),
  });
}
