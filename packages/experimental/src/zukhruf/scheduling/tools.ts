import type { ToolSet } from 'ai';
import { tool } from 'ai';
import cronstrue from 'cronstrue';
import { z } from 'zod';

import type { SchedulingToolContext } from '../collaboration/agent-tool-context.ts';

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

const schedulingToolMetadata = {
  zukhruf: {
    kind: 'scheduling',
    codeModeExposure: 'direct-model-only',
  },
};

export const schedulingTools = {
  CronCreate: tool<
    z.infer<typeof cronCreateInput>,
    z.infer<typeof cronOutput>,
    SchedulingToolContext
  >({
    description: 'Create a durable fixed cron schedule in this conversation.',
    inputSchema: cronCreateInput,
    outputSchema: cronOutput,
    metadata: schedulingToolMetadata,
    execute: async (input, { context, toolCallId }) => {
      const definition = await context.schedulingCoordinator.createCron(
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
    SchedulingToolContext
  >({
    description: 'List durable cron schedules in this conversation.',
    inputSchema: z.object({}).strict(),
    outputSchema: cronListOutput,
    metadata: schedulingToolMetadata,
    execute: async (_input, { context }) => {
      return {
        jobs: (
          await context.schedulingCoordinator.cronJobs(
            context.actor.thread.conversation,
          )
        ).map((definition) => ({
          id: definition.id,
          cron: definition.expression,
          humanSchedule: cronstrue.toString(definition.expression, {
            throwExceptionOnParseError: true,
          }),
          prompt: definition.prompt,
          ...(!definition.recurring ? { recurring: false } : {}),
        })),
      };
    },
  }),
  CronDelete: tool<
    z.infer<typeof cronDeleteInput>,
    z.infer<typeof cronDeleteOutput>,
    SchedulingToolContext
  >({
    description: 'Delete a durable cron schedule in this conversation.',
    inputSchema: cronDeleteInput,
    outputSchema: cronDeleteOutput,
    metadata: schedulingToolMetadata,
    execute: async ({ id }, { context }) => {
      await context.schedulingCoordinator.deleteCron(
        context.actor.thread.conversation,
        id,
      );
      return { id };
    },
  }),
  ScheduleWakeup: tool<
    z.infer<typeof scheduleWakeupInput>,
    z.infer<typeof scheduleWakeupOutput>,
    SchedulingToolContext
  >({
    description:
      'Replace or stop the dynamic one-shot wakeup for this conversation.',
    inputSchema: scheduleWakeupInput,
    outputSchema: scheduleWakeupOutput,
    metadata: schedulingToolMetadata,
    execute: async (input, { context }) => {
      const conversation = context.actor.thread.conversation;
      if ('stop' in input) {
        return {
          scheduledFor: 0,
          clampedDelaySeconds: 0,
          wasClamped: false,
          stopped: true,
          cancelledWakeups:
            await context.schedulingCoordinator.stopDynamic(conversation),
        };
      }
      return context.schedulingCoordinator.scheduleDynamic(conversation, input);
    },
  }),
} satisfies ToolSet;
