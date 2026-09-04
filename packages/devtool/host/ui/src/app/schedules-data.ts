import {
  type UseMutationResult,
  skipToken,
  useMutation,
  useQuery,
} from '@tanstack/react-query';

import type {
  ScheduledRunView,
  ScheduledTaskView,
} from '@deepagents/experimental/zukhruf/schedules/http';

import { queryClient } from './runtime-data.ts';

export type { ScheduledRunView, ScheduledTaskView };

export type ScheduleTargetInput = ScheduledTaskView['target'];

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
      ? ({ signal }) => read<ScheduledTaskView[]>(`${href}/tasks`, { signal })
      : skipToken,
  });
}

export function usePendingReview(href: string | undefined) {
  return useQuery({
    queryKey: ['schedules', 'inbox', href],
    queryFn: href
      ? ({ signal }) =>
          read<ScheduledRunView[]>(`${href}/runs/inbox`, { signal })
      : skipToken,
  });
}

export function useTaskRuns(href: string | undefined, taskId?: string) {
  return useQuery({
    queryKey: ['schedules', 'task-runs', href, taskId],
    queryFn:
      href && taskId
        ? ({ signal }) =>
            read<ScheduledRunView[]>(`${href}/tasks/${taskId}/runs`, { signal })
        : skipToken,
  });
}

export function useScheduledRun(href: string | undefined, runId?: string) {
  return useQuery({
    queryKey: ['schedules', 'run', href, runId],
    queryFn:
      href && runId
        ? ({ signal }) =>
            read<ScheduledRunView>(`${href}/runs/${runId}`, { signal })
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
      return write<ScheduledTaskView>(`${href}/tasks`, {
        body: command.definition,
        idempotencyKey: crypto.randomUUID(),
        method: 'POST',
      });
    case 'update':
      return write<ScheduledTaskView>(`${href}/tasks/${command.taskId}`, {
        body: command.definition,
        method: 'PATCH',
      });
    case 'pause':
    case 'resume':
    case 'archive':
      return write<ScheduledTaskView>(
        `${href}/tasks/${command.taskId}/${command.kind}`,
        { method: 'POST' },
      );
    case 'run':
      return write<ScheduledRunView>(`${href}/tasks/${command.taskId}/run`, {
        idempotencyKey: crypto.randomUUID(),
        method: 'POST',
      });
    case 'purge':
      return write<undefined>(`${href}/tasks/${command.taskId}`, {
        method: 'DELETE',
      });
    case 'cancel':
    case 'review':
      return write<ScheduledRunView>(
        `${href}/runs/${command.runId}/${command.kind}`,
        { method: 'POST' },
      );
  }
}

async function read<T>(url: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) throw await scheduleError(response);
  return response.json() as Promise<T>;
}

async function write<T>(
  url: string,
  options: {
    body?: unknown;
    idempotencyKey?: string;
    method: 'POST' | 'PATCH' | 'DELETE';
  },
): Promise<T> {
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
  return response.status === 204
    ? (undefined as T)
    : (response.json() as Promise<T>);
}

async function scheduleError(response: Response): Promise<Error> {
  const body = (await response.json().catch(() => undefined)) as
    { error?: string } | undefined;
  return new Error(body?.error ?? `Request failed: ${response.status}`);
}
