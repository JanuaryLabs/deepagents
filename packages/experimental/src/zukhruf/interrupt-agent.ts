import { tool } from 'ai';
import { z } from 'zod';

import {
  type ListedAgentStatus,
  listedAgentStatusSchema,
} from './agent-status-projector.ts';
import type { AgentToolContext } from './agent-tool-context.ts';

const interruptAgentInputSchema = z.object({
  target: z
    .string()
    .trim()
    .min(1)
    .describe(
      'The canonical /root/... path, or a descendant-relative target name.',
    ),
});

type InterruptAgentInput = z.infer<typeof interruptAgentInputSchema>;

const interruptAgentOutputSchema = z
  .object({ previous_status: listedAgentStatusSchema })
  .strict();

export const interruptAgentTool = tool<
  InterruptAgentInput,
  { previous_status: ListedAgentStatus },
  AgentToolContext
>({
  description:
    "Interrupt an agent's current turn, if any, and return its previous status. The agent remains available for messages and follow-up tasks.",
  inputSchema: interruptAgentInputSchema,
  outputSchema: interruptAgentOutputSchema,
  execute: async (input, { context }) =>
    context.controlPlane.interruptAgent(context.actor, input),
});
