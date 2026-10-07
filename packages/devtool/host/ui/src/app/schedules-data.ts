import {
  type UseMutationResult,
  skipToken,
  useMutation,
  useQuery,
} from '@tanstack/react-query';
import { z } from 'zod';

import type {
  ScheduledRunView,
  ScheduledTaskView,
} from '@deepagents/experimental/zukhruf/schedules/http';

import { queryClient } from './runtime-data.ts';

export type { ScheduledRunView, ScheduledTaskView };

export type ScheduleTargetInput = ScheduledTaskView['target'];

const scheduleTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('new-conversation') }),
  z.object({ kind: z.literal('existing-conversation'), chatId: z.string() }),
]);

const scheduledTaskSchema: z.ZodType<ScheduledTaskView> = z.object({
  id: z.string(),
  name: z.string(),
  prompt: z.string(),
  recurrence: z.string(),
  timezone: z.string(),
  target: scheduleTargetSchema,
  status: z.enum(['active', 'paused', 'completed', 'archived']),
  nextRunAt: z.number().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
  archivedAt: z.number().nullable(),
});

const scheduledRunSchema: z.ZodType<ScheduledRunView> = z.object({
  id: z.string(),
  taskId: z.string(),
  trigger: z.enum(['scheduled', 'manual']),
  occurrenceAt: z.number(),
  prompt: z.string(),
  target: scheduleTargetSchema,
  status: z.enum([
    'dispatching',
    'running',
    'completed',
    'failed',
    'cancelled',
  ]),
  reviewStatus: z.enum(['pending_review', 'reviewed', 'archived']).nullable(),
  conversation: z.object({ chatId: z.string(), turnId: z.string() }).nullable(),
  startedAt: z.number().nullable(),
  finishedAt: z.number().nullable(),
  error: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

/** Body of a failed Zukhruf request: `{ error, cause }`. */
const errorBodySchema = z.object({ error: z.string() });

export interface ScheduleDefinitionInput {
  name: string;
  prompt: string;
  recurrence: string;
  timezone: string;
  target: ScheduleTargetInput;
}

export function useScheduledTasks(href: string | undefined) {
  return useQuery({
    queryKey: ['schedules', 'tasks', href],
    queryFn: href
      ? ({ signal }) =>
          read(`${href}/tasks`, { signal }, z.array(scheduledTaskSchema))
      : skipToken,
  });
}

export function usePendingReview(href: string | undefined) {
  return useQuery({
    queryKey: ['schedules', 'inbox', href],
    queryFn: href
      ? ({ signal }) =>
          read(`${href}/runs/inbox`, { signal }, z.array(scheduledRunSchema))
      : skipToken,
  });
}

export function useTaskRuns(href: string | undefined, taskId?: string) {
  return useQuery({
    queryKey: ['schedules', 'task-runs', href, taskId],
    queryFn:
      href && taskId
        ? ({ signal }) =>
            read(
              `${href}/tasks/${taskId}/runs`,
              { signal },
              z.array(scheduledRunSchema),
            )
        : skipToken,
  });
}

export function useScheduledRun(href: string | undefined, runId?: string) {
  return useQuery({
    queryKey: ['schedules', 'run', href, runId],
    queryFn:
      href && runId
        ? ({ signal }) =>
            read(`${href}/runs/${runId}`, { signal }, scheduledRunSchema)
        : skipToken,
  });
}

export type ScheduleCommand =
  | { kind: 'create'; definition: ScheduleDefinitionInput }
  | {
      kind: 'update';
      taskId: string;
      definition: Partial<ScheduleDefinitionInput>;
    }
  | { kind: 'pause' | 'resume' | 'archive' | 'run'; taskId: string }
  | { kind: 'purge'; taskId: string }
  | { kind: 'cancel' | 'review'; runId: string };

export type ScheduleMutation = UseMutationResult<
  ScheduledTaskView | ScheduledRunView | undefined,
  Error,
  ScheduleCommand
>;

/** Every lifecycle command shares one mutation so the workspace has one error surface. */
export function useScheduleCommand(href: string | undefined): ScheduleMutation {
  return useMutation({
    mutationFn: async (command: ScheduleCommand) => {
      if (!href) throw new Error('Scheduled tasks are unavailable');
      return send(href, command);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['schedules'] }),
  });
}

async function send(href: string, command: ScheduleCommand) {
  switch (command.kind) {
    case 'create':
      return write(
        `${href}/tasks`,
        {
          body: command.definition,
          idempotencyKey: crypto.randomUUID(),
          method: 'POST',
        },
        scheduledTaskSchema,
      );
    case 'update':
      return write(
        `${href}/tasks/${command.taskId}`,
        { body: command.definition, method: 'PATCH' },
        scheduledTaskSchema,
      );
    case 'pause':
    case 'resume':
    case 'archive':
      return write(
        `${href}/tasks/${command.taskId}/${command.kind}`,
        { method: 'POST' },
        scheduledTaskSchema,
      );
    case 'run':
      return write(
        `${href}/tasks/${command.taskId}/run`,
        { idempotencyKey: crypto.randomUUID(), method: 'POST' },
        scheduledRunSchema,
      );
    case 'purge':
      // 204 No Content.
      await request(`${href}/tasks/${command.taskId}`, { method: 'DELETE' });
      return undefined;
    case 'cancel':
    case 'review':
      return write(
        `${href}/runs/${command.runId}/${command.kind}`,
        { method: 'POST' },
        scheduledRunSchema,
      );
  }
}

async function read<T>(
  url: string,
  init: RequestInit,
  schema: z.ZodType<T>,
): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) throw await scheduleError(response);
  return schema.parse(await response.json());
}

async function write<T>(
  url: string,
  options: RequestOptions,
  schema: z.ZodType<T>,
): Promise<T> {
  const response = await request(url, options);
  return schema.parse(await response.json());
}

interface RequestOptions {
  body?: unknown;
  idempotencyKey?: string;
  method: 'POST' | 'PATCH' | 'DELETE';
}

async function request(url: string, options: RequestOptions) {
  const headers = new Headers();
  if (options.body) headers.set('content-type', 'application/json');
  if (options.idempotencyKey) {
    headers.set('idempotency-key', options.idempotencyKey);
  }
  const response = await fetch(url, {
    body: options.body ? JSON.stringify(options.body) : undefined,
    headers,
    method: options.method,
  });
  if (!response.ok) throw await scheduleError(response);
  return response;
}

async function scheduleError(response: Response): Promise<Error> {
  const body = errorBodySchema.safeParse(
    await response.json().catch(() => undefined),
  );
  return new Error(
    body.success ? body.data.error : `Request failed: ${response.status}`,
  );
}
