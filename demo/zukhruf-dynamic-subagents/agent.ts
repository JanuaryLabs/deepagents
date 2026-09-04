import { openai } from '@ai-sdk/openai';
import { fileURLToPath } from 'node:url';

import { defineAgent } from '@deepagents/experimental/zukhruf';
import { fileAgents } from '@deepagents/experimental/zukhruf/file-agents';

import instructions from './instructions.ts';
import { createWorkspaceSandbox } from './sandbox.ts';

export function createCodingAgent(workspaceDirectory: string) {
  const skillsDirectory = fileURLToPath(new URL('./skills/', import.meta.url));

  return defineAgent({
    name: 'coding-agent',
    description: 'Implements focused changes in an existing repository.',
    model: openai(process.env.OPENAI_MODEL ?? 'gpt-5.6-luna'),
    sandbox: createWorkspaceSandbox({
      workspaceDirectory,
      skillsDirectory,
    }),
    instructions,
    plugins: [
      fileAgents({
        directory: new URL('./subagents/', import.meta.url),
      }),
    ],
  });
}
