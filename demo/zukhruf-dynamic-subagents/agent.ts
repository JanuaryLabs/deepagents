import { openai } from '@ai-sdk/openai';
import { fileURLToPath } from 'node:url';

import { defineAgent } from '@deepagents/experimental/zukhruf';

import instructions from './instructions.ts';
import { createWorkspaceSandbox } from './sandbox.ts';

export function createCodingAgent(workspaceDirectory: string) {
  const skillsDirectory = fileURLToPath(new URL('./skills/', import.meta.url));

  return defineAgent({
    name: 'coding-agent',
    description: 'Implements focused changes in an existing repository.',
    model: openai('gpt-5.6-luna'),
    sandbox: createWorkspaceSandbox({
      workspaceDirectory,
      skillsDirectory,
    }),
    instructions,
    plugins: [
      {
        name: 'coding-team',
        create: () => ({
          agents: [new URL('./subagents/', import.meta.url)],
        }),
      },
    ],
  });
}
