import { tool } from 'ai';
import { z } from 'zod';

import type { AgentToolContext } from './agent-tool-context.ts';

const waitAgentOutputSchema = z
  .object({ message: z.string(), timed_out: z.boolean() })
  .strict();

export function createWaitAgentTool(options: {
  minTimeoutMs: number;
  defaultTimeoutMs: number;
  maxTimeoutMs: number;
}) {
  const waitAgentInputSchema = z.object({
    timeout_ms: z
      .number()
      .int()
      .min(options.minTimeoutMs)
      .max(options.maxTimeoutMs)
      .optional()
      .describe('Maximum time to wait in milliseconds.'),
  });
  type WaitAgentInput = z.infer<typeof waitAgentInputSchema>;

  return tool<
    WaitAgentInput,
    { message: string; timed_out: boolean },
    AgentToolContext
  >({
    description:
      'Wait for pending mail addressed to this agent without consuming it.',
    inputSchema: waitAgentInputSchema,
    outputSchema: waitAgentOutputSchema,
    execute: async ({ timeout_ms }, { abortSignal, context }) => {
      const received = await context.controlPlane.waitForMailbox(
        context.actor,
        {
          timeoutMs: timeout_ms ?? options.defaultTimeoutMs,
          signal: abortSignal,
        },
      );
      return received
        ? { message: 'Wait completed.', timed_out: false }
        : { message: 'Wait timed out.', timed_out: true };
    },
  });
}
