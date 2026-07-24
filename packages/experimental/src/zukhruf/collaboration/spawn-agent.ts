import { tool } from 'ai';
import { z } from 'zod';

import { forkTurnsError, parseForkTurns } from '../control-plane/fork-turns.ts';
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
  fork_turns: z
    .string()
    .trim()
    .default('all')
    .refine((value) => parseForkTurns(value) !== undefined, forkTurnsError)
    .describe(
      'Optional number of parent turns to fork. Defaults to `all`. Use `none`, `all`, or a positive integer string such as `3`.',
    ),
});

type SpawnAgentInput = z.infer<typeof spawnAgentInputSchema>;

const spawnAgentOutputSchema = z.object({ task_name: z.string() }).strict();

export function createSpawnAgentTool(options?: { usageHintText?: string }) {
  return tool<SpawnAgentInput, { task_name: string }, AgentToolContext>({
    description: ({ context }) => {
      const available = (context.actor.declaration.subagents ?? [])
        .map((subagent) => subagent.name)
        .join(', ');
      return [
        `Spawn an independent subagent. Available agent types: ${available || 'none'}.`,
        options?.usageHintText,
      ]
        .filter(Boolean)
        .join(' ');
    },
    inputSchema: spawnAgentInputSchema,
    outputSchema: spawnAgentOutputSchema,
    execute: async (
      { agent_type, task_name, message, fork_turns },
      { context },
    ) => {
      const forkTurns = parseForkTurns(fork_turns);
      if (forkTurns === undefined) throw new Error(forkTurnsError);
      return context.controlPlane.spawn(context.actor, {
        agentType: agent_type,
        taskName: task_name,
        message,
        forkTurns,
      });
    },
  });
}
