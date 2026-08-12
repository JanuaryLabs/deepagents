import type { Tool, ToolSet } from 'ai';
import { tool } from 'ai';
import cronstrue from 'cronstrue';
import { z } from 'zod';

import type { AgentToolContext } from '../collaboration/agent-tool-context.ts';
import type { SchedulingCoordinator } from './coordinator.ts';

const nonBlank = z.string().refine((value) => value.trim().length > 0, {
  message: 'must not be blank',
});

const cronCreateInput = z
  .object({
    cron: z.string().trim().min(1),
    prompt: nonBlank,
    recurring: z.boolean().optional(),
  })
  .strict();
const cronOutput = z
  .object({
    id: z.string().length(8),
    humanSchedule: z.string(),
    recurring: z.boolean(),
  })
  .strict();
const cronListOutput = z
  .object({
    jobs: z.array(
      z
        .object({
          id: z.string().length(8),
          cron: z.string(),
          humanSchedule: z.string(),
          prompt: z.string(),
          recurring: z.boolean().optional(),
        })
        .strict(),
    ),
  })
  .strict();
const cronDeleteInput = z.object({ id: z.string().length(8) }).strict();
const cronDeleteOutput = z.object({ id: z.string().length(8) }).strict();
const scheduleWakeupInput = z.union([
  z.object({ stop: z.literal(true) }).strict(),
  z
    .object({
      delaySeconds: z.number().finite(),
      reason: nonBlank,
      prompt: nonBlank,
    })
    .strict(),
]);
const scheduleWakeupOutput = z
  .object({
    scheduledFor: z.number(),
    clampedDelaySeconds: z.number(),
    wasClamped: z.boolean(),
    stopped: z.boolean().optional(),
    cancelledWakeups: z.number().int().nonnegative().optional(),
  })
  .strict();

export function createSchedulingTools(
  coordinator: SchedulingCoordinator,
  namespace?: string,
): ToolSet {
  const tools: ToolSet = {
    CronCreate: tool<
      z.infer<typeof cronCreateInput>,
      z.infer<typeof cronOutput>,
      AgentToolContext
    >({
      description: 'Create a durable fixed cron schedule in this conversation.',
      inputSchema: cronCreateInput,
      outputSchema: cronOutput,
      execute: async (input, { context, toolCallId }) => {
        const definition = await coordinator.createCron(
          context.actor.thread.conversation,
          input,
          toolCallId,
        );
        return {
          id: definition.id,
          humanSchedule: cronstrue.toString(definition.expression, {
            throwExceptionOnParseError: true,
          }),
          recurring: definition.recurring,
        };
      },
    }),
    CronList: tool<
      Record<string, never>,
      z.infer<typeof cronListOutput>,
      AgentToolContext
    >({
      description: 'List durable cron schedules in this conversation.',
      inputSchema: z.object({}).strict(),
      outputSchema: cronListOutput,
      execute: async (_input, { context }) => ({
        jobs: (
          await coordinator.cronJobs(context.actor.thread.conversation)
        ).map((definition) => ({
          id: definition.id,
          cron: definition.expression,
          humanSchedule: cronstrue.toString(definition.expression, {
            throwExceptionOnParseError: true,
          }),
          prompt: definition.prompt,
          ...(!definition.recurring ? { recurring: false } : {}),
        })),
      }),
    }),
    CronDelete: tool<
      z.infer<typeof cronDeleteInput>,
      z.infer<typeof cronDeleteOutput>,
      AgentToolContext
    >({
      description: 'Delete a durable cron schedule in this conversation.',
      inputSchema: cronDeleteInput,
      outputSchema: cronDeleteOutput,
      execute: async ({ id }, { context }) => {
        await coordinator.deleteCron(context.actor.thread.conversation, id);
        return { id };
      },
    }),
    ScheduleWakeup: tool<
      z.infer<typeof scheduleWakeupInput>,
      z.infer<typeof scheduleWakeupOutput>,
      AgentToolContext
    >({
      description:
        'Replace or stop the dynamic one-shot wakeup for this conversation.',
      inputSchema: scheduleWakeupInput,
      outputSchema: scheduleWakeupOutput,
      execute: async (input, { context }) => {
        const conversation = context.actor.thread.conversation;
        if ('stop' in input) {
          return {
            scheduledFor: 0,
            clampedDelaySeconds: 0,
            wasClamped: false,
            stopped: true,
            cancelledWakeups: await coordinator.stopDynamic(conversation),
          };
        }
        return coordinator.scheduleDynamic(conversation, input);
      },
    }),
  };
  return Object.fromEntries(
    Object.entries(tools).map(([name, schedulingTool]) => [
      name,
      configureSchedulingTool(schedulingTool, namespace),
    ]),
  );
}

function configureSchedulingTool(tool: Tool, namespace?: string): Tool {
  return {
    ...tool,
    providerOptions: {
      ...tool.providerOptions,
      ...(namespace === undefined
        ? {}
        : {
            openai: {
              namespace: {
                name: namespace,
                description: 'Tools for scheduling future agent turns.',
              },
            },
          }),
    },
    metadata: {
      ...tool.metadata,
      zukhruf: {
        kind: 'scheduling',
        codeModeExposure: 'direct-model-only',
      },
    },
  };
}
