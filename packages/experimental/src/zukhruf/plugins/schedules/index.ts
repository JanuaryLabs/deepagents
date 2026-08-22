import { isToolUIPart } from 'ai';
import type { JobPollingOptions } from 'pg-boss';

import type {
  AgentPluginHost,
  AgentRuntimePlugin,
} from '../../runtime/agent-runtime.ts';
import {
  type CreateScheduledTaskInput,
  type ScheduledExecutionObservation,
  type ScheduledRun,
  type ScheduledTask,
  ScheduledTasks,
  type ScheduledTasksOptions,
  type UpdateScheduledTaskInput,
} from './scheduled-tasks.ts';

export * from './schedule-files.ts';
export * from './scheduled-tasks.ts';

type ExecutionConfig = Record<string, never>;

export type ScheduleControl = Pick<
  ScheduledTasks<ExecutionConfig>,
  | 'create'
  | 'get'
  | 'list'
  | 'listRuns'
  | 'getRun'
  | 'pause'
  | 'resume'
  | 'update'
  | 'runNow'
  | 'archive'
  | 'purge'
  | 'cancelRun'
  | 'markReviewed'
  | 'archiveRun'
>;

export type ScheduleSource = (schedules: ScheduleControl) => Promise<void>;

export interface SchedulesOptions extends Omit<
  ScheduledTasksOptions<ExecutionConfig>,
  'executor'
> {
  workerOptions?: JobPollingOptions;
  sources?: readonly ScheduleSource[];
}

export type Schedules = AgentRuntimePlugin & ScheduleControl;

/** Install durable standalone schedules into one AgentRuntime. */
export function schedules(options: SchedulesOptions): Schedules {
  return new SchedulesPlugin(options);
}

class SchedulesPlugin implements Schedules {
  readonly name = 'schedules';
  readonly #scheduled: ScheduledTasks<ExecutionConfig>;
  readonly #sources: readonly ScheduleSource[] | undefined;
  readonly #workerOptions: JobPollingOptions | undefined;
  #host?: AgentPluginHost;
  #initialization?: Promise<void>;

  constructor({ sources, workerOptions, ...options }: SchedulesOptions) {
    this.#sources = sources;
    this.#workerOptions = workerOptions;
    this.#scheduled = new ScheduledTasks({
      ...options,
      executor: {
        launch: (input) => this.#launch(input),
        inspect: (input) => this.#inspect(input),
        cancel: (input) => this.#cancel(input),
      },
    });
  }

  initialize(host: AgentPluginHost): Promise<void> {
    if (this.#host && this.#host !== host) {
      throw new Error(
        'schedules plugin cannot be shared by AgentRuntime instances',
      );
    }
    this.#host = host;
    if (!this.#initialization) this.#initialization = this.#initialize();
    return this.#initialization;
  }

  work(host: AgentPluginHost): Promise<AsyncDisposable> {
    if (this.#host !== host) {
      throw new Error(
        'schedules plugin must be initialized before work starts',
      );
    }
    return this.#scheduled.work(this.#workerOptions);
  }

  create(
    ownerId: string,
    input: CreateScheduledTaskInput<ExecutionConfig>,
  ): Promise<ScheduledTask<ExecutionConfig>> {
    return this.#scheduled.create(ownerId, input);
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

  update(
    ownerId: string,
    taskId: string,
    input: UpdateScheduledTaskInput<ExecutionConfig>,
  ): Promise<ScheduledTask<ExecutionConfig>> {
    return this.#scheduled.update(ownerId, taskId, input);
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

  async #initialize(): Promise<void> {
    await this.#scheduled.initialize();
    if (!this.#sources) return;
    for (const source of this.#sources) await source(this);
  }

  async #launch({
    runId,
    ownerId,
    prompt,
  }: {
    runId: string;
    ownerId: string;
    prompt: string;
    executionConfig: ExecutionConfig;
  }): Promise<{ executionId: string }> {
    await this.#requiredHost().enqueue(
      { chatId: runId, userId: ownerId },
      { id: runId, input: prompt },
    );
    return { executionId: runId };
  }

  async #inspect({
    ownerId,
    executionId,
  }: {
    ownerId: string;
    executionId: string;
  }): Promise<ScheduledExecutionObservation> {
    const observation = this.#requiredHost().observe({
      chatId: executionId,
      userId: ownerId,
    });
    const execution = await observation.status();
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
        .at(-1)
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
    ownerId,
    executionId,
  }: {
    ownerId: string;
    executionId: string;
  }): Promise<void> {
    await this.#requiredHost()
      .observe({ chatId: executionId, userId: ownerId })
      .cancel();
  }

  #requiredHost(): AgentPluginHost {
    if (!this.#host) throw new Error('schedules plugin is not initialized');
    return this.#host;
  }
}
