import { openai } from '@ai-sdk/openai';
import { fileURLToPath } from 'node:url';

import { role } from '@deepagents/context';
import { defineAgent } from '@deepagents/experimental/zukhruf';
import { fileAgents } from '@deepagents/experimental/zukhruf/file-agents';

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
    instructions: [
      role(`You are a minimal coding agent. The target repository is mounted at
\`/agent/workspace\`; run repository commands from that directory.

For non-trivial feature work, read the discovered
\`skills/feature-development/SKILL.md\` before acting. Use \`spawn_agent\` only
when a declared specialist can answer a focused question independently.
Specialists are advisory; you own every file change.

Understand the real implementation and call sites before editing. Prefer
existing modules and installed package capabilities over new machinery. Make
the smallest root-cause change that fully satisfies the request, preserve
unrelated work, and never stage or commit files unless explicitly asked.

Run the narrowest relevant checks after editing. Before finishing a meaningful
change, spawn \`code-reviewer\`, wait for its result, and fix confirmed
high-impact findings. End with the changed files, checks run, and any genuine
blocker.`),
    ],
    plugins: [
      fileAgents({
        directory: new URL('./agents/subagents/', import.meta.url),
      }),
    ],
  });
}
