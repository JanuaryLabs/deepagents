import { isToolUIPart } from 'ai';
import type { JobPollingOptions, PgBoss } from 'pg-boss';
import { z } from 'zod';

import type { ConversationId } from '../../mailbox/types.ts';
import {
  AgentPluginCapability,
  type AgentPluginDefinition,
  type AgentPluginHost,
  type AgentPluginInitialization,
} from '../../runtime/agent-runtime.ts';
import {
  type CreateScheduledTaskInput,
  type ScheduledExecutionObservation,
  type ScheduledRun,
  type ScheduledTask,
  type ScheduledTaskTransaction,
  ScheduledTasks,
  ScheduledTasksError,
  type ScheduledTasksOptions,
  type UpdateScheduledTaskInput,
} from './scheduled-tasks.ts';

export * from './schedule-files.ts';
export * from './scheduled-tasks.ts';

/**
 * Distinguishes host-owned Scheduled Tasks from the Conversation Schedule
 * origin written by `conversationScheduling()`.
 */
export const SCHEDULED_TASK_ORIGIN = 'scheduled-task';

export type ScheduleTarget =
  | { kind: 'new-conversation' }
  | { kind: 'existing-conversation'; chatId: string };

export interface ScheduleExecutionConfig {
  /** Omit to run each occurrence in its own fresh conversation. */
  target?: ScheduleTarget;
}

type ExecutionConfig = ScheduleExecutionConfig;

/** Persisted execution configs, as `normalizeExecutionConfig` writes them. */
const executionConfigSchema = z.object({
  target: z
    .discriminatedUnion('kind', [
      z.object({ kind: z.literal('new-conversation') }),
      z.object({
        kind: z.literal('existing-conversation'),
        chatId: z.string(),
      }),
    ])
    .optional(),
}) satisfies z.ZodType<ExecutionConfig>;

export type ScheduleControl = Pick<
  ScheduledTasks<ExecutionConfig>,
  | 'create'
  | 'get'
  | 'list'
  | 'listRuns'
  | 'getRun'
  | 'listPendingReview'
  | 'pause'
  | 'resume'
  | 'subscribeChanges'
  | 'update'
  | 'runNow'
  | 'archive'
  | 'purge'
  | 'cancelRun'
  | 'markReviewed'
  | 'archiveRun'
>;

export type ScheduleSource = (schedules: ScheduleControl) => Promise<void>;

export interface SchedulesOptions extends Pick<
  ScheduledTasksOptions<ExecutionConfig>,
  'queue' | 'queueOptions' | 'reconciliationIntervalMs'
> {
  workerOptions?: JobPollingOptions;
  sources?: readonly ScheduleSource[];
}

export const schedulesCapabilities = {
  boss: new AgentPluginCapability<PgBoss>('schedules.boss'),
  transaction: new AgentPluginCapability<ScheduledTaskTransaction>(
    'schedules.transaction',
  ),
} as const;

export type Schedules = AgentPluginInitialization & ScheduleControl;

/** Install durable schedules that run in fresh or existing conversations. */
export function schedules(
  options: SchedulesOptions,
): AgentPluginDefinition<Schedules> {
  return {
    name: 'schedules',
    capabilities: [
      schedulesCapabilities.boss,
      schedulesCapabilities.transaction,
    ],
    create: (bindings) => {
      const boss = bindings.get(schedulesCapabilities.boss);
      const transaction = bindings.get(schedulesCapabilities.transaction);
      return {
        initialize: (host) =>
          RunningSchedules.start(host, { ...options, boss, transaction }),
      };
    },
  };
}

class RunningSchedules implements Schedules {
  readonly #host: AgentPluginHost;
  readonly #scheduled: ScheduledTasks<ExecutionConfig>;
  readonly #workerOptions: JobPollingOptions | undefined;

  static async start(
    host: AgentPluginHost,
    {
      sources,
      ...options
    }: SchedulesOptions &
      Pick<ScheduledTasksOptions<ExecutionConfig>, 'boss' | 'transaction'>,
  ): Promise<RunningSchedules> {
    const running = new RunningSchedules(host, options);
    await running.#scheduled.initialize();
    for (const source of sources ?? []) await source(running);
    return running;
  }

  private constructor(
    host: AgentPluginHost,
    {
      workerOptions,
      ...options
    }: Omit<SchedulesOptions, 'sources'> &
      Pick<ScheduledTasksOptions<ExecutionConfig>, 'boss' | 'transaction'>,
  ) {
    this.#host = host;
    this.#workerOptions = workerOptions;
    this.#scheduled = new ScheduledTasks({
      ...options,
      executionConfigSchema,
      executor: {
        launch: (input) => this.#launch(input),
        inspect: (input) => this.#inspect(input),
        cancel: (input) => this.#cancel(input),
      },
    });
  }

  work(): Promise<AsyncDisposable> {
    return this.#scheduled.work(this.#workerOptions);
  }

  async create(
    ownerId: string,
    input: CreateScheduledTaskInput<ExecutionConfig>,
  ): Promise<ScheduledTask<ExecutionConfig>> {
    const executionConfig = normalizeExecutionConfig(input.executionConfig);
    await this.#assertTarget(ownerId, executionConfig);
    return this.#scheduled.create(ownerId, { ...input, executionConfig });
  }

  get(
    ownerId: string,
    taskId: string,
  ): Promise<ScheduledTask<ExecutionConfig>> {
    return this.#scheduled.get(ownerId, taskId);
  }

  list(ownerId: string): Promise<ScheduledTask<ExecutionConfig>[]> {
    return this.#scheduled.list(ownerId);
  }

  listRuns(
    ownerId: string,
    taskId: string,
  ): Promise<ScheduledRun<ExecutionConfig>[]> {
    return this.#scheduled.listRuns(ownerId, taskId);
  }

  getRun(
    ownerId: string,
    runId: string,
  ): Promise<ScheduledRun<ExecutionConfig>> {
    return this.#scheduled.getRun(ownerId, runId);
  }

  listPendingReview(ownerId: string): Promise<ScheduledRun<ExecutionConfig>[]> {
    return this.#scheduled.listPendingReview(ownerId);
  }

  subscribeChanges(ownerId: string, signal: AbortSignal) {
    return this.#scheduled.subscribeChanges(ownerId, signal);
  }

  pause(
    ownerId: string,
    taskId: string,
  ): Promise<ScheduledTask<ExecutionConfig>> {
    return this.#scheduled.pause(ownerId, taskId);
  }

  resume(
    ownerId: string,
    taskId: string,
  ): Promise<ScheduledTask<ExecutionConfig>> {
    return this.#scheduled.resume(ownerId, taskId);
  }

  async update(
    ownerId: string,
    taskId: string,
    input: UpdateScheduledTaskInput<ExecutionConfig>,
  ): Promise<ScheduledTask<ExecutionConfig>> {
    if (input.executionConfig === undefined) {
      return this.#scheduled.update(ownerId, taskId, input);
    }
    const executionConfig = normalizeExecutionConfig(input.executionConfig);
    await this.#assertTarget(ownerId, executionConfig);
    return this.#scheduled.update(ownerId, taskId, {
      ...input,
      executionConfig,
    });
  }

  runNow(
    ownerId: string,
    taskId: string,
    idempotencyKey: string,
  ): Promise<ScheduledRun<ExecutionConfig>> {
    return this.#scheduled.runNow(ownerId, taskId, idempotencyKey);
  }

  archive(
    ownerId: string,
    taskId: string,
  ): Promise<ScheduledTask<ExecutionConfig>> {
    return this.#scheduled.archive(ownerId, taskId);
  }

  purge(ownerId: string, taskId: string): Promise<void> {
    return this.#scheduled.purge(ownerId, taskId);
  }

  cancelRun(
    ownerId: string,
    runId: string,
  ): Promise<ScheduledRun<ExecutionConfig>> {
    return this.#scheduled.cancelRun(ownerId, runId);
  }

  markReviewed(
    ownerId: string,
    runId: string,
  ): Promise<ScheduledRun<ExecutionConfig>> {
    return this.#scheduled.markReviewed(ownerId, runId);
  }

  archiveRun(
    ownerId: string,
    runId: string,
  ): Promise<ScheduledRun<ExecutionConfig>> {
    return this.#scheduled.archiveRun(ownerId, runId);
  }

  async conversationDeleting({
    chatId,
    userId,
  }: ConversationId): Promise<void> {
    for (const { id, executionConfig } of await this.#scheduled.list(userId)) {
      if (
        executionConfig.target?.kind === 'existing-conversation' &&
        executionConfig.target.chatId === chatId
      ) {
        await this.#scheduled.archive(userId, id);
      }
    }
  }

  async #launch({
    runId,
    taskId,
    ownerId,
    trigger,
    occurrenceAt,
    prompt,
    executionConfig,
  }: {
    runId: string;
    taskId: string;
    ownerId: string;
    trigger: 'scheduled' | 'manual';
    occurrenceAt: number;
    prompt: string;
    executionConfig: ExecutionConfig;
  }): Promise<{ executionId: string }> {
    const conversation = executionConversation(runId, ownerId, executionConfig);
    if (
      executionConfig.target?.kind === 'existing-conversation' &&
      !(await this.#host.conversationExists(conversation))
    ) {
      throw new Error(
        `Scheduled target conversation "${conversation.chatId}" was not found`,
      );
    }
    const execution = await this.#host.enqueue(conversation, {
      message: {
        id: runId,
        role: 'user',
        parts: [{ type: 'text', text: prompt }],
        metadata: {
          zukhruf: {
            origin: SCHEDULED_TASK_ORIGIN,
            scheduledTask: { taskId, runId, trigger, occurrenceAt },
          },
        },
      },
      trigger: 'submit-message',
    });
    return { executionId: execution.id };
  }

  async #inspect({
    runId,
    ownerId,
    executionId,
    executionConfig,
  }: {
    runId: string;
    ownerId: string;
    executionId: string;
    executionConfig: ExecutionConfig;
  }): Promise<ScheduledExecutionObservation> {
    const observation = this.#host.observe(
      executionConversation(runId, ownerId, executionConfig),
    );
    const execution = await observation.status(executionId);
    if (!execution) {
      throw new Error(`Scheduled execution "${executionId}" was not found`);
    }
    if (execution.status === 'queued' || execution.status === 'running') {
      return { status: execution.status, startedAt: execution.startedAt };
    }
    if (execution.finishedAt === null) {
      throw new Error(
        `Scheduled execution "${executionId}" is terminal without a finish time`,
      );
    }
    if (
      execution.status === 'completed' &&
      (await observation.engine.getMessages())
        .find(
          (message) =>
            message.role === 'assistant' && message.id === executionId,
        )
        ?.parts.some(
          (part) => isToolUIPart(part) && part.state === 'approval-requested',
        )
    ) {
      return {
        status: 'failed',
        startedAt: execution.startedAt,
        finishedAt: execution.finishedAt,
        error: 'Scheduled execution requires interactive tool approval',
        title: null,
        summary: null,
      };
    }
    return {
      status: execution.status,
      startedAt: execution.startedAt,
      finishedAt: execution.finishedAt,
      error: execution.error,
      title: null,
      summary: null,
    };
  }

  async #cancel({
    runId,
    ownerId,
    executionId,
    executionConfig,
  }: {
    runId: string;
    ownerId: string;
    executionId: string;
    executionConfig: ExecutionConfig;
  }): Promise<void> {
    await this.#host
      .observe(executionConversation(runId, ownerId, executionConfig))
      .cancel(executionId);
  }

  async #assertTarget(
    ownerId: string,
    executionConfig: ExecutionConfig,
  ): Promise<void> {
    if (executionConfig.target?.kind !== 'existing-conversation') return;
    const conversation = {
      chatId: executionConfig.target.chatId,
      userId: ownerId,
    };
    if (await this.#host.conversationExists(conversation)) return;
    throw new ScheduledTasksError(
      'invalid-input',
      'task',
      `Scheduled target conversation "${conversation.chatId}" was not found`,
    );
  }
}

function executionConversation(
  runId: string,
  ownerId: string,
  executionConfig: ExecutionConfig,
) {
  const normalized = normalizeExecutionConfig(executionConfig);
  return {
    chatId:
      normalized.target?.kind === 'existing-conversation'
        ? normalized.target.chatId
        : runId,
    userId: ownerId,
  };
}

function normalizeExecutionConfig(
  value: ScheduleExecutionConfig,
): ScheduleExecutionConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ScheduledTasksError(
      'invalid-input',
      'task',
      'Schedule execution config must be an object',
    );
  }
  if (Object.keys(value).some((key) => key !== 'target')) {
    throw new ScheduledTasksError(
      'invalid-input',
      'task',
      'Schedule execution config contains an unknown field',
    );
  }
  const { target } = value;
  if (!target || target.kind === 'new-conversation') return {};
  if (target.kind !== 'existing-conversation') {
    throw new ScheduledTasksError(
      'invalid-input',
      'task',
      'Schedule target kind is invalid',
    );
  }
  const chatId = target.chatId.trim();
  if (!chatId) {
    throw new ScheduledTasksError(
      'invalid-input',
      'task',
      'Schedule target chatId cannot be empty',
    );
  }
  return { target: { kind: 'existing-conversation', chatId } };
}
