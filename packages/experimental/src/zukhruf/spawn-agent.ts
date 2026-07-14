import { tool } from 'ai';
import { z } from 'zod';

import type { AgentToolContext } from './agent-tool-context.ts';

const spawnAgentInputSchema = z.object({
  agent_type: z
    .string()
    .trim()
    .min(1)
    .describe('The name of one available subagent declaration.'),
  task_name: z
    .string()
    .trim()
    .min(1)
    .refine(
      (value) => value !== '.' && value !== '..' && !value.includes('/'),
      'task_name must be one non-empty path segment',
    )
    .describe('One path segment naming this independent agent task.'),
  message: z
    .string()
    .refine((value) => value.trim().length > 0, 'message cannot be empty')
    .describe('The initial task for the spawned agent.'),
});

type SpawnAgentInput = z.infer<typeof spawnAgentInputSchema>;

export const spawnAgentTool = tool<
  SpawnAgentInput,
  { task_name: string; agent_path: string },
  AgentToolContext
>({
  description: ({ context }) => {
    const available = (context.actor.declaration.subagents ?? [])
      .map((subagent) => subagent.name)
      .join(', ');
    return `Spawn an independent subagent. Available agent types: ${available || 'none'}.`;
  },
  inputSchema: spawnAgentInputSchema,
  execute: async ({ agent_type, task_name, message }, { context }) =>
    context.controlPlane.spawn(context.actor, {
      agentType: agent_type,
      taskName: task_name,
      message,
    }),
});
