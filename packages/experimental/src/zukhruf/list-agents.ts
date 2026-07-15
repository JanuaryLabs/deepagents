import { tool } from 'ai';
import { z } from 'zod';

import {
  type ListedAgent,
  listedAgentSchema,
} from './agent-status-projector.ts';
import type { AgentToolContext } from './agent-tool-context.ts';

const listAgentsInputSchema = z.object({
  path_prefix: z
    .string()
    .trim()
    .min(1)
    .describe(
      'Task-path prefix without a trailing slash. Omit to list the whole tree.',
    )
    .optional(),
});

type ListAgentsInput = z.infer<typeof listAgentsInputSchema>;

const listAgentsOutputSchema = z
  .object({ agents: z.array(listedAgentSchema) })
  .strict();

export const listAgentsTool = tool<
  ListAgentsInput,
  { agents: ListedAgent[] },
  AgentToolContext
>({
  description:
    'List live agents in the current root thread tree. Optionally filter by task-path prefix.',
  inputSchema: listAgentsInputSchema,
  outputSchema: listAgentsOutputSchema,
  execute: async ({ path_prefix }, { context }) =>
    context.controlPlane.listAgents(context.actor, path_prefix),
});
