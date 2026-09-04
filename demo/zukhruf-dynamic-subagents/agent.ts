import { openai } from '@ai-sdk/openai';

import { defineAgent } from '@deepagents/experimental/zukhruf';

import instructions from './instructions.ts';
import { createWorkspaceSandbox } from './sandbox.ts';

export function createCodingAgent(workspaceDirectory: string) {
  return defineAgent({
    name: 'coding-agent',
    description: 'Implements focused changes in an existing repository.',
    model: openai('gpt-5.6-luna'),
    sandbox: createWorkspaceSandbox({ workspaceDirectory }),
    instructions,
    skills: ['feature-development'],
    plugins: [
      {
        name: 'coding-team',
        create: () => ({
          agents: [new URL('./subagents/', import.meta.url)],
          skills: [new URL('./skills/feature-development/', import.meta.url)],
        }),
      },
    ],
  });
}
