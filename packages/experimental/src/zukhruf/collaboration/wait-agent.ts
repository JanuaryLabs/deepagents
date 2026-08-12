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
      const timeoutMs = Math.max(
        timeout_ms ?? options.defaultTimeoutMs,
        options.minTimeoutMs,
      );
      const received = await context.controlPlane.waitForMailbox(
        context.actor,
        {
          timeoutMs,
          signal: abortSignal,
        },
      );
      const message = received ? 'Wait completed.' : 'Wait timed out.';
      return {
        message:
          timeout_ms !== undefined && timeout_ms < timeoutMs
            ? `${message}\n\nRequested timeout of ${timeout_ms}ms was clamped to the minimum of ${timeoutMs}ms.`
            : message,
        timed_out: !received,
      };
    },
  });
}
