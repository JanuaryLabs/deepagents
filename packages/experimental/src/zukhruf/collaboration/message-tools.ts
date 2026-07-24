import { tool } from 'ai';
import { z } from 'zod';

import type { AgentToolContext } from './agent-tool-context.ts';

const agentMessageInputSchema = z.object({
  target: z
    .string()
    .trim()
    .min(1)
    .describe(
      'The canonical /root/... path, or a descendant-relative target name.',
    ),
  message: z.string().trim().min(1).describe('The message or follow-up task.'),
});

type AgentMessageInput = z.infer<typeof agentMessageInputSchema>;
type AgentMessageOutput = string;

export const sendMessageTool = tool<
  AgentMessageInput,
  AgentMessageOutput,
  AgentToolContext
>({
  description:
    'Queue a message for another agent. Address siblings with their canonical /root/... path.',
  inputSchema: agentMessageInputSchema,
  execute: async (input, { context }) => {
    await context.controlPlane.sendMessage(context.actor, input);
    return '';
  },
});

export const followupTaskTool = tool<
  AgentMessageInput,
  AgentMessageOutput,
  AgentToolContext
>({
  description:
    'Send a follow-up task to an existing non-root agent and wake its thread.',
  inputSchema: agentMessageInputSchema,
  execute: async (input, { context }) => {
    await context.controlPlane.followupTask(context.actor, input);
    return '';
  },
});
