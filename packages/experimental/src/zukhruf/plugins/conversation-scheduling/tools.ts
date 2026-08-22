import type { ToolSet } from 'ai';
import { tool } from 'ai';
import cronstrue from 'cronstrue';
import { z } from 'zod';

import type { AgentPluginToolContext } from '../../runtime/agent-runtime.ts';
import type { ConversationScheduler } from './conversation-scheduler.ts';

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
    id: z.uuid(),
    humanSchedule: z.string(),
    nextRunAt: z.number(),
    timezone: z.string(),
    recurring: z.boolean(),
    warning: z.string().optional(),
  })
  .strict();
const cronListOutput = z
  .object({
    jobs: z.array(
      z
        .object({
          id: z.uuid(),
          cron: z.string(),
          humanSchedule: z.string(),
          nextRunAt: z.number(),
          timezone: z.string(),
          prompt: z.string(),
          recurring: z.boolean().optional(),
        })
        .strict(),
    ),
  })
  .strict();
const cronDeleteInput = z.object({ id: z.uuid() }).strict();
const cronDeleteOutput = z.object({ id: z.uuid() }).strict();
const scheduleWakeupInput = z.union([
  z.object({ stop: z.literal(true) }).strict(),
  z
    .object({
      delaySeconds: z.number().finite().min(60).max(3_600),
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

function calendarYearWarning(definition: {
  createdAt: number;
  nextRunAt: number;
  recurring: boolean;
  timezone: string;
}): { warning?: string } {
  if (definition.recurring) return {};
  const year = new Intl.DateTimeFormat('en', {
    calendar: 'iso8601',
    timeZone: definition.timezone,
    year: 'numeric',
  });
  const createdYear = year.format(definition.createdAt);
  const nextYear = year.format(definition.nextRunAt);
  if (createdYear === nextYear) return {};
  return {
    warning: `This one-shot cron resolves in calendar year ${nextYear}, not ${createdYear}. Confirm that year is intended.`,
  };
}

export function createSchedulingTools(
  conversationScheduler: ConversationScheduler,
) {
  return {
    CronCreate: tool<
      z.infer<typeof cronCreateInput>,
      z.infer<typeof cronOutput>,
      AgentPluginToolContext
    >({
      description: 'Create a durable fixed cron schedule in this conversation.',
      inputSchema: cronCreateInput,
      outputSchema: cronOutput,
      metadata: schedulingToolMetadata,
      execute: async (input, { context, toolCallId }) => {
        const definition = await conversationScheduler.createCron(
          context.conversation,
          input,
          toolCallId,
        );
        return {
          id: definition.id,
          humanSchedule: cronstrue.toString(definition.expression, {
            throwExceptionOnParseError: true,
          }),
          nextRunAt: definition.nextRunAt,
          timezone: definition.timezone,
          recurring: definition.recurring,
          ...calendarYearWarning(definition),
        };
      },
    }),
    CronList: tool<
      Record<string, never>,
      z.infer<typeof cronListOutput>,
      AgentPluginToolContext
    >({
      description: 'List durable cron schedules in this conversation.',
      inputSchema: z.object({}).strict(),
      outputSchema: cronListOutput,
      metadata: schedulingToolMetadata,
      execute: async (_input, { context }) => {
        return {
          jobs: (
            await conversationScheduler.cronJobs(context.conversation)
          ).map((definition) => ({
            id: definition.id,
            cron: definition.expression,
            humanSchedule: cronstrue.toString(definition.expression, {
              throwExceptionOnParseError: true,
            }),
            nextRunAt: definition.nextRunAt,
            timezone: definition.timezone,
            prompt: definition.prompt,
            ...(!definition.recurring ? { recurring: false } : {}),
          })),
        };
      },
    }),
    CronDelete: tool<
      z.infer<typeof cronDeleteInput>,
      z.infer<typeof cronDeleteOutput>,
      AgentPluginToolContext
    >({
      description: 'Delete a durable cron schedule in this conversation.',
      inputSchema: cronDeleteInput,
      outputSchema: cronDeleteOutput,
      metadata: schedulingToolMetadata,
      execute: async ({ id }, { context }) => {
        await conversationScheduler.deleteCron(context.conversation, id);
        return { id };
      },
    }),
    ScheduleWakeup: tool<
      z.infer<typeof scheduleWakeupInput>,
      z.infer<typeof scheduleWakeupOutput>,
      AgentPluginToolContext
    >({
      description:
        'Replace or stop the dynamic one-shot wakeup for this conversation.',
      inputSchema: scheduleWakeupInput,
      outputSchema: scheduleWakeupOutput,
      metadata: schedulingToolMetadata,
      execute: async (input, { context }) => {
        const conversation = context.conversation;
        if ('stop' in input) {
          return {
            scheduledFor: 0,
            clampedDelaySeconds: 0,
            wasClamped: false,
            stopped: true,
            cancelledWakeups:
              await conversationScheduler.stopDynamic(conversation),
          };
        }
        return conversationScheduler.scheduleDynamic(conversation, input);
      },
    }),
  } satisfies ToolSet;
}
