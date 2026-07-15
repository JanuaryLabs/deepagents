import { tool } from 'ai';
import { z } from 'zod';

import type { AgentToolContext } from './agent-tool-context.ts';

const MIN_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 3_600_000;
const DEFAULT_TIMEOUT_MS = 30_000;

const waitAgentInputSchema = z.object({
  timeout_ms: z
    .number()
    .int()
    .min(MIN_TIMEOUT_MS)
    .max(MAX_TIMEOUT_MS)
    .optional()
    .describe('Maximum time to wait in milliseconds.'),
});

type WaitAgentInput = z.infer<typeof waitAgentInputSchema>;

export const waitAgentTool = tool<
  WaitAgentInput,
  { message: string; timed_out: boolean },
  AgentToolContext
>({
  description:
    'Wait for pending mail addressed to this agent without consuming it.',
  inputSchema: waitAgentInputSchema,
  execute: async ({ timeout_ms }, { abortSignal, context }) => {
    const received = await context.controlPlane.waitForMailbox(context.actor, {
      timeoutMs: timeout_ms ?? DEFAULT_TIMEOUT_MS,
      signal: abortSignal,
    });
    return received
      ? { message: 'Wait completed.', timed_out: false }
      : { message: 'Wait timed out.', timed_out: true };
  },
});
