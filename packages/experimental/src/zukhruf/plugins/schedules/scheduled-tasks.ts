import { CronExpressionParser } from 'cron-parser';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type {
  Db,
  JobPollingOptions,
  JobWithMetadata,
  PgBoss,
  Queue,
} from 'pg-boss';
import rrulePackage from 'rrule';

import { pgBossNotifications } from '../../queue/pg-boss-notifications.ts';

const { rrulestr } = rrulePackage;

export const SCHEDULE_CHANGES_CHANNEL = 'zukhruf_schedule_changes';

const DDL = `
  CREATE TABLE IF NOT EXISTS zukhruf_scheduled_tasks (
    id uuid PRIMARY KEY,
    owner_id text NOT NULL,
    idempotency_key text NOT NULL,
    name text NOT NULL,
    prompt text NOT NULL,
    recurrence text NOT NULL,
    timezone text NOT NULL,
    execution_config jsonb NOT NULL,
    status text NOT NULL CHECK (status IN ('active', 'paused', 'completed', 'archived')),
    generation integer NOT NULL,
    next_run_at bigint,
    next_wake_id uuid,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL,
    archived_at bigint,
    UNIQUE (owner_id, idempotency_key),
    CHECK ((next_run_at IS NULL) = (next_wake_id IS NULL))
  );

  CREATE INDEX IF NOT EXISTS zukhruf_scheduled_tasks_owner
    ON zukhruf_scheduled_tasks (owner_id, created_at, id);

  CREATE TABLE IF NOT EXISTS zukhruf_scheduled_runs (
    id uuid PRIMARY KEY,
    task_id uuid NOT NULL REFERENCES zukhruf_scheduled_tasks(id) ON DELETE CASCADE,
    owner_id text NOT NULL,
    trigger text NOT NULL CHECK (trigger IN ('scheduled', 'manual')),
    idempotency_key text,
    occurrence_at bigint NOT NULL,
    prompt text NOT NULL,
    execution_config jsonb NOT NULL,
    status text NOT NULL CHECK (status IN ('dispatching', 'running', 'completed', 'failed', 'cancelled')),
    review_status text CHECK (review_status IN ('pending_review', 'reviewed', 'archived')),
    external_execution_id text,
    dispatch_job_id uuid NOT NULL,
    reconciliation_job_id uuid,
    next_check_at bigint,
    started_at bigint,
    finished_at bigint,
    title text,
    summary text,
    error text,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL
  );

  CREATE UNIQUE INDEX IF NOT EXISTS zukhruf_scheduled_runs_occurrence
    ON zukhruf_scheduled_runs (task_id, occurrence_at)
    WHERE trigger = 'scheduled';

  CREATE UNIQUE INDEX IF NOT EXISTS zukhruf_scheduled_runs_manual
    ON zukhruf_scheduled_runs (task_id, idempotency_key)
    WHERE trigger = 'manual';

  CREATE INDEX IF NOT EXISTS zukhruf_scheduled_runs_task
    ON zukhruf_scheduled_runs (owner_id, task_id, occurrence_at DESC, id);

  CREATE INDEX IF NOT EXISTS zukhruf_scheduled_runs_pending_review
    ON zukhruf_scheduled_runs (owner_id, finished_at DESC, id)
    WHERE review_status = 'pending_review';

  CREATE OR REPLACE FUNCTION zukhruf_publish_schedule_change()
  RETURNS trigger AS $$
  BEGIN
    IF TG_TABLE_NAME = 'zukhruf_scheduled_tasks' THEN
      PERFORM pg_notify(
        '${SCHEDULE_CHANGES_CHANNEL}',
        json_build_object(
          'resource', 'schedule-task',
          'ownerId', COALESCE(NEW.owner_id, OLD.owner_id),
          'id', COALESCE(NEW.id, OLD.id)
        )::text
      );
    ELSE
      PERFORM pg_notify(
        '${SCHEDULE_CHANGES_CHANNEL}',
        json_build_object(
          'resource', 'schedule-run',
          'ownerId', COALESCE(NEW.owner_id, OLD.owner_id),
          'id', COALESCE(NEW.id, OLD.id),
          'taskId', COALESCE(NEW.task_id, OLD.task_id)
        )::text
      );
    END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END;
  $$ LANGUAGE plpgsql;

  CREATE OR REPLACE TRIGGER zukhruf_scheduled_tasks_changed
    AFTER INSERT OR UPDATE OR DELETE ON zukhruf_scheduled_tasks
    FOR EACH ROW EXECUTE FUNCTION zukhruf_publish_schedule_change();

  CREATE OR REPLACE TRIGGER zukhruf_scheduled_runs_changed
    AFTER INSERT OR UPDATE OR DELETE ON zukhruf_scheduled_runs
    FOR EACH ROW EXECUTE FUNCTION zukhruf_publish_schedule_change();
`;

export type ScheduledTaskStatus =
  'active' | 'paused' | 'completed' | 'archived';
export type ScheduledRunStatus =
  'dispatching' | 'running' | 'completed' | 'failed' | 'cancelled';
export type ScheduledRunReviewStatus =
  'pending_review' | 'reviewed' | 'archived';

export type ScheduledTasksErrorCode =
  'invalid-input' | 'not-found' | 'conflict';
export type ScheduledTasksResource = 'task' | 'run';

/** Domain rejection a transport can categorise without matching messages. */
export class ScheduledTasksError extends Error {
  override readonly name = 'ScheduledTasksError';
  readonly code: ScheduledTasksErrorCode;
  readonly resource: ScheduledTasksResource;

  constructor(
    code: ScheduledTasksErrorCode,
    resource: ScheduledTasksResource,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.code = code;
    this.resource = resource;
  }
}

export interface ScheduledTask<ExecutionConfig extends object> {
  id: string;
  ownerId: string;
  idempotencyKey: string;
  name: string;
  prompt: string;
  recurrence: string;
  timezone: string;
  executionConfig: ExecutionConfig;
  status: ScheduledTaskStatus;
  generation: number;
  nextRunAt: number | null;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
}

export interface ScheduledRun<ExecutionConfig extends object> {
  id: string;
  taskId: string;
  ownerId: string;
  trigger: 'scheduled' | 'manual';
  occurrenceAt: number;
  prompt: string;
  executionConfig: ExecutionConfig;
  status: ScheduledRunStatus;
  reviewStatus: ScheduledRunReviewStatus | null;
  externalExecutionId: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  title: string | null;
  summary: string | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

export type ScheduledExecutionObservation =
  | {
      status: 'queued';
      startedAt: number | null;
    }
  | {
      status: 'running';
      startedAt: number | null;
    }
  | {
      status: 'completed' | 'failed' | 'cancelled';
      startedAt: number | null;
      finishedAt: number;
      error: string | null;
      title: string | null;
      summary: string | null;
    };

export interface ScheduledExecutionAdapter<ExecutionConfig extends object> {
  /** Repeated calls with the same run ID must return the same execution. */
  launch(input: {
    runId: string;
    taskId: string;
    ownerId: string;
    trigger: 'scheduled' | 'manual';
    occurrenceAt: number;
    prompt: string;
    executionConfig: ExecutionConfig;
  }): Promise<{ executionId: string }>;
  inspect(input: {
    runId: string;
    ownerId: string;
    executionId: string;
    executionConfig: ExecutionConfig;
  }): Promise<ScheduledExecutionObservation>;
  /** Cancellation must be safe to repeat. */
  cancel(input: {
    runId: string;
    ownerId: string;
    executionId: string;
    executionConfig: ExecutionConfig;
  }): Promise<void>;
}

export interface CreateScheduledTaskInput<ExecutionConfig extends object> {
  idempotencyKey: string;
  name: string;
  prompt: string;
  recurrence: string;
  timezone: string;
  executionConfig: ExecutionConfig;
}

export interface UpdateScheduledTaskInput<ExecutionConfig extends object> {
  name?: string;
  prompt?: string;
  recurrence?: string;
  timezone?: string;
  executionConfig?: ExecutionConfig;
}

export type ScheduledChange =
  | { type: 'reset' }
  | { type: 'change'; resource: 'schedule-task'; id: string }
  | {
      type: 'change';
      resource: 'schedule-run';
      id: string;
      taskId: string;
    };

export interface ScheduledTaskTransaction {
  <T>(operation: (database: Db) => Promise<T>): Promise<T>;
}

export interface ScheduledTasksOptions<ExecutionConfig extends object> {
  boss: PgBoss;
  queue: string;
  queueOptions?: Omit<Queue, 'name'>;
  reconciliationIntervalMs: number;
  transaction: ScheduledTaskTransaction;
  executor: ScheduledExecutionAdapter<ExecutionConfig>;
}

interface OccurrenceJob {
  kind: 'occurrence';
  ownerId: string;
  taskId: string;
  occurrenceAt: number;
  generation: number;
}

interface DispatchJob {
  kind: 'dispatch';
  ownerId: string;
  runId: string;
}

interface ReconcileJob {
  kind: 'reconcile';
  ownerId: string;
  runId: string;
}

type ScheduledJob = OccurrenceJob | DispatchJob | ReconcileJob;

type TaskRow = {
  id: string;
  owner_id: string;
  idempotency_key: string;
  name: string;
  prompt: string;
  recurrence: string;
  timezone: string;
  execution_config: unknown;
  status: ScheduledTaskStatus;
  generation: number | string;
  next_run_at: number | string | bigint | null;
  next_wake_id: string | null;
  created_at: number | string | bigint;
  updated_at: number | string | bigint;
  archived_at: number | string | bigint | null;
};

type RunRow = {
  id: string;
  task_id: string;
  owner_id: string;
  trigger: 'scheduled' | 'manual';
  idempotency_key: string | null;
  occurrence_at: number | string | bigint;
  prompt: string;
  execution_config: unknown;
  status: ScheduledRunStatus;
  review_status: ScheduledRunReviewStatus | null;
  external_execution_id: string | null;
  dispatch_job_id: string;
  reconciliation_job_id: string | null;
  next_check_at: number | string | bigint | null;
  started_at: number | string | bigint | null;
  finished_at: number | string | bigint | null;
  title: string | null;
  summary: string | null;
  error: string | null;
  created_at: number | string | bigint;
  updated_at: number | string | bigint;
};

/** Durable Scheduled Tasks implementation backed by PostgreSQL and pg-boss. */
export class ScheduledTasks<ExecutionConfig extends object> {
  readonly #boss: PgBoss;
  readonly #database: Db;
  readonly #executor: ScheduledExecutionAdapter<ExecutionConfig>;
  readonly #queue: string;
  readonly #queueOptions: Omit<Queue, 'name'> | undefined;
  readonly #reconciliationIntervalMs: number;
  readonly #transaction: ScheduledTaskTransaction;

  constructor(options: ScheduledTasksOptions<ExecutionConfig>) {
    this.#queue = required(options.queue, 'Scheduled Tasks queue');
    if (
      !Number.isInteger(options.reconciliationIntervalMs) ||
      options.reconciliationIntervalMs < 1
    ) {
      throw new Error(
        'Scheduled Tasks reconciliation interval must be a positive integer',
      );
    }
    this.#boss = options.boss;
    this.#database = options.boss.getDb();
    this.#executor = options.executor;
    this.#queueOptions = options.queueOptions;
    this.#reconciliationIntervalMs = options.reconciliationIntervalMs;
    this.#transaction = options.transaction;
  }

  async initialize(): Promise<void> {
    await this.#database.executeSql(DDL);
    if (this.#queueOptions) {
      await this.#boss.createQueue(this.#queue, this.#queueOptions);
    } else {
      await this.#boss.createQueue(this.#queue);
    }
    // pg-boss resolves queue metadata before honoring a transaction-bound `db`.
    // Prime that public lookup before entering PGlite's single-connection transaction.
    await this.#boss.findJobs(this.#queue, { id: randomUUID() });
  }

  async subscribeChanges(
    ownerId: string,
    signal: AbortSignal,
  ): Promise<AsyncIterable<ScheduledChange>> {
    const owner = required(ownerId, 'Scheduled Task owner');
    const notifications = await pgBossNotifications(
      this.#boss,
      SCHEDULE_CHANGES_CHANNEL,
      parseScheduledChange,
      signal,
    );
    return {
      async *[Symbol.asyncIterator]() {
        for await (const notification of notifications) {
          if (notification.type === 'reset') {
            yield notification;
          } else if (notification.value.ownerId === owner) {
            yield notification.value.change;
          }
        }
      },
    };
  }

  async create(
    ownerId: string,
    input: CreateScheduledTaskInput<ExecutionConfig>,
  ): Promise<ScheduledTask<ExecutionConfig>> {
    const owner = required(ownerId, 'Scheduled Task owner');
    const normalized = normalizeCreate(input);
    const nextRunAt = nextOccurrence(
      normalized.recurrence,
      normalized.timezone,
      Date.now(),
    );
    if (nextRunAt === null) {
      throw new ScheduledTasksError(
        'invalid-input',
        'task',
        'Scheduled Task recurrence has no future occurrence',
      );
    }

    return this.#transaction(async (database) => {
      const existing = await this.#taskByKey(
        database,
        owner,
        normalized.idempotencyKey,
      );
      if (existing) {
        assertSameTask(existing, normalized);
        return existing;
      }

      const id = randomUUID();
      const generation = 1;
      const now = Date.now();
      const wakeId = await this.#sendAt(
        database,
        {
          kind: 'occurrence',
          ownerId: owner,
          taskId: id,
          occurrenceAt: nextRunAt,
          generation,
        },
        nextRunAt,
      );
      const { rows } = await database.executeSql(
        `INSERT INTO zukhruf_scheduled_tasks (
           id, owner_id, idempotency_key, name, prompt, recurrence, timezone,
           execution_config, status, generation, next_run_at, next_wake_id,
           created_at, updated_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8::jsonb,
           'active', $9, $10, $11, $12, $12
         )
         ON CONFLICT (owner_id, idempotency_key) DO NOTHING
         RETURNING *`,
        [
          id,
          owner,
          normalized.idempotencyKey,
          normalized.name,
          normalized.prompt,
          normalized.recurrence,
          normalized.timezone,
          normalized.executionConfigJson,
          generation,
          nextRunAt,
          wakeId,
          now,
        ],
      );
      const inserted = rows[0] as TaskRow | undefined;
      if (inserted) return toTask<ExecutionConfig>(inserted);

      await this.#cancelJob(database, wakeId);
      const concurrent = await this.#taskByKey(
        database,
        owner,
        normalized.idempotencyKey,
      );
      if (!concurrent) throw new Error('Scheduled Task create lost its row');
      assertSameTask(concurrent, normalized);
      return concurrent;
    });
  }

  async get(
    ownerId: string,
    taskId: string,
  ): Promise<ScheduledTask<ExecutionConfig>> {
    return this.#requiredTask(this.#database, ownerId, taskId, false);
  }

  async list(ownerId: string): Promise<ScheduledTask<ExecutionConfig>[]> {
    const { rows } = await this.#database.executeSql(
      `SELECT * FROM zukhruf_scheduled_tasks
        WHERE owner_id = $1
        ORDER BY created_at, id`,
      [required(ownerId, 'Scheduled Task owner')],
    );
    return (rows as TaskRow[]).map(toTask<ExecutionConfig>);
  }

  async listRuns(
    ownerId: string,
    taskId: string,
  ): Promise<ScheduledRun<ExecutionConfig>[]> {
    const { rows } = await this.#database.executeSql(
      `SELECT * FROM zukhruf_scheduled_runs
        WHERE owner_id = $1 AND task_id = $2
        ORDER BY occurrence_at DESC, id`,
      [
        required(ownerId, 'Scheduled Task owner'),
        required(taskId, 'Scheduled Task id'),
      ],
    );
    return (rows as RunRow[]).map(toRun<ExecutionConfig>);
  }

  async getRun(
    ownerId: string,
    runId: string,
  ): Promise<ScheduledRun<ExecutionConfig>> {
    return this.#requiredRun(this.#database, ownerId, runId, false);
  }

  /**
   * Owner-wide review queue. `review_status` is only written when a run reaches
   * a terminal state, so pending runs are exactly the unreviewed terminal ones,
   * including runs whose task has since been archived.
   */
  async listPendingReview(
    ownerId: string,
  ): Promise<ScheduledRun<ExecutionConfig>[]> {
    const { rows } = await this.#database.executeSql(
      `SELECT * FROM zukhruf_scheduled_runs
        WHERE owner_id = $1 AND review_status = 'pending_review'
        ORDER BY finished_at DESC, id`,
      [required(ownerId, 'Scheduled Task owner')],
    );
    return (rows as RunRow[]).map(toRun<ExecutionConfig>);
  }

  async pause(
    ownerId: string,
    taskId: string,
  ): Promise<ScheduledTask<ExecutionConfig>> {
    return this.#transaction(async (database) => {
      const task = await this.#requiredTask(database, ownerId, taskId, true);
      if (task.status === 'paused') return task;
      if (task.status !== 'active') {
        throw new ScheduledTasksError(
          'conflict',
          'task',
          `Scheduled Task "${task.id}" is ${task.status}`,
        );
      }
      const row = await this.#taskRow(database, task.id, task.ownerId, true);
      if (!row) throw new Error(`Scheduled Task "${task.id}" was not found`);
      if (row.next_wake_id) await this.#cancelJob(database, row.next_wake_id);
      const now = Date.now();
      const { rows } = await database.executeSql(
        `UPDATE zukhruf_scheduled_tasks
            SET status = 'paused', generation = generation + 1,
                next_run_at = NULL, next_wake_id = NULL, updated_at = $1
          WHERE id = $2 AND owner_id = $3
          RETURNING *`,
        [now, task.id, task.ownerId],
      );
      return toTask<ExecutionConfig>(requiredRow<TaskRow>(rows, 'pause'));
    });
  }

  async resume(
    ownerId: string,
    taskId: string,
  ): Promise<ScheduledTask<ExecutionConfig>> {
    return this.#transaction(async (database) => {
      const task = await this.#requiredTask(database, ownerId, taskId, true);
      if (task.status === 'active') return task;
      if (task.status === 'archived') {
        throw new ScheduledTasksError(
          'conflict',
          'task',
          `Scheduled Task "${task.id}" is archived`,
        );
      }
      const nextRunAt = nextOccurrence(
        task.recurrence,
        task.timezone,
        Date.now(),
      );
      if (nextRunAt === null) {
        throw new ScheduledTasksError(
          'conflict',
          'task',
          'Scheduled Task recurrence has no future occurrence',
        );
      }
      const generation = task.generation + 1;
      const wakeId = await this.#sendAt(
        database,
        {
          kind: 'occurrence',
          ownerId: task.ownerId,
          taskId: task.id,
          occurrenceAt: nextRunAt,
          generation,
        },
        nextRunAt,
      );
      const { rows } = await database.executeSql(
        `UPDATE zukhruf_scheduled_tasks
            SET status = 'active', generation = $1, next_run_at = $2,
                next_wake_id = $3, updated_at = $4
          WHERE id = $5 AND owner_id = $6
          RETURNING *`,
        [generation, nextRunAt, wakeId, Date.now(), task.id, task.ownerId],
      );
      return toTask<ExecutionConfig>(requiredRow<TaskRow>(rows, 'resume'));
    });
  }

  async update(
    ownerId: string,
    taskId: string,
    input: UpdateScheduledTaskInput<ExecutionConfig>,
  ): Promise<ScheduledTask<ExecutionConfig>> {
    if (Object.values(input).every((value) => value === undefined)) {
      throw new ScheduledTasksError(
        'invalid-input',
        'task',
        'Scheduled Task update cannot be empty',
      );
    }
    return this.#transaction(async (database) => {
      const task = await this.#requiredTask(database, ownerId, taskId, true);
      if (task.status === 'archived') {
        throw new ScheduledTasksError(
          'conflict',
          'task',
          `Scheduled Task "${task.id}" is archived`,
        );
      }
      const row = await this.#taskRow(database, task.id, task.ownerId, true);
      if (!row) throw new Error(`Scheduled Task "${task.id}" was not found`);
      const name =
        input.name === undefined
          ? task.name
          : required(input.name, 'Scheduled Task name');
      const prompt =
        input.prompt === undefined
          ? task.prompt
          : required(input.prompt, 'Scheduled Task prompt');
      const timezone =
        input.timezone === undefined
          ? task.timezone
          : validateTimezone(input.timezone);
      const recurrence =
        input.recurrence === undefined
          ? task.recurrence
          : required(input.recurrence, 'Scheduled Task recurrence');
      const executionConfig =
        input.executionConfig === undefined
          ? task.executionConfig
          : input.executionConfig;
      const executionConfigJson = serializeExecutionConfig(executionConfig);
      const generation = task.generation + 1;
      const candidate = nextOccurrence(recurrence, timezone, Date.now());
      let status = task.status;
      let nextRunAt: number | null = null;
      let wakeId: string | null = null;
      if (task.status === 'active') {
        status = candidate === null ? 'completed' : 'active';
        nextRunAt = candidate;
        if (candidate !== null) {
          wakeId = await this.#sendAt(
            database,
            {
              kind: 'occurrence',
              ownerId: task.ownerId,
              taskId: task.id,
              occurrenceAt: candidate,
              generation,
            },
            candidate,
          );
        }
      }
      if (row.next_wake_id) await this.#cancelJob(database, row.next_wake_id);
      const { rows } = await database.executeSql(
        `UPDATE zukhruf_scheduled_tasks
            SET name = $1, prompt = $2, recurrence = $3, timezone = $4,
                execution_config = $5::jsonb, status = $6, generation = $7,
                next_run_at = $8, next_wake_id = $9, updated_at = $10
          WHERE id = $11 AND owner_id = $12
          RETURNING *`,
        [
          name,
          prompt,
          recurrence,
          timezone,
          executionConfigJson,
          status,
          generation,
          nextRunAt,
          wakeId,
          Date.now(),
          task.id,
          task.ownerId,
        ],
      );
      return toTask<ExecutionConfig>(requiredRow<TaskRow>(rows, 'update'));
    });
  }

  async runNow(
    ownerId: string,
    taskId: string,
    idempotencyKey: string,
  ): Promise<ScheduledRun<ExecutionConfig>> {
    const key = required(idempotencyKey, 'Scheduled Run idempotency key');
    return this.#transaction(async (database) => {
      const task = await this.#requiredTask(database, ownerId, taskId, true);
      if (task.status === 'archived') {
        throw new ScheduledTasksError(
          'conflict',
          'task',
          `Scheduled Task "${task.id}" is archived`,
        );
      }
      const existing = await this.#manualRun(database, task.id, key);
      if (existing) return existing;
      const now = Date.now();
      const runId = randomUUID();
      const dispatchJobId = await this.#sendNow(database, {
        kind: 'dispatch',
        ownerId: task.ownerId,
        runId,
      });
      const { rows } = await database.executeSql(
        `INSERT INTO zukhruf_scheduled_runs (
           id, task_id, owner_id, trigger, idempotency_key, occurrence_at,
           prompt, execution_config, status, dispatch_job_id, created_at, updated_at
         ) VALUES (
           $1, $2, $3, 'manual', $4, $5, $6, $7::jsonb,
           'dispatching', $8, $5, $5
         )
         ON CONFLICT (task_id, idempotency_key) WHERE trigger = 'manual'
         DO NOTHING
         RETURNING *`,
        [
          runId,
          task.id,
          task.ownerId,
          key,
          now,
          task.prompt,
          serializeExecutionConfig(task.executionConfig),
          dispatchJobId,
        ],
      );
      const inserted = rows[0] as RunRow | undefined;
      if (inserted) return toRun<ExecutionConfig>(inserted);
      await this.#cancelJob(database, dispatchJobId);
      const concurrent = await this.#manualRun(database, task.id, key);
      if (!concurrent) throw new Error('Scheduled Run create lost its row');
      return concurrent;
    });
  }

  async archive(
    ownerId: string,
    taskId: string,
  ): Promise<ScheduledTask<ExecutionConfig>> {
    return this.#transaction(async (database) => {
      const task = await this.#requiredTask(database, ownerId, taskId, true);
      if (task.status === 'archived') return task;
      const row = await this.#taskRow(database, task.id, task.ownerId, true);
      if (!row) throw new Error(`Scheduled Task "${task.id}" was not found`);
      if (row.next_wake_id) await this.#cancelJob(database, row.next_wake_id);
      const now = Date.now();
      const { rows } = await database.executeSql(
        `UPDATE zukhruf_scheduled_tasks
            SET status = 'archived', generation = generation + 1,
                next_run_at = NULL, next_wake_id = NULL,
                archived_at = $1, updated_at = $1
          WHERE id = $2 AND owner_id = $3
          RETURNING *`,
        [now, task.id, task.ownerId],
      );
      return toTask<ExecutionConfig>(requiredRow<TaskRow>(rows, 'archive'));
    });
  }

  async purge(ownerId: string, taskId: string): Promise<void> {
    await this.#transaction(async (database) => {
      const task = await this.#requiredTask(database, ownerId, taskId, true);
      if (task.status !== 'archived') {
        throw new ScheduledTasksError(
          'conflict',
          'task',
          `Scheduled Task "${task.id}" must be archived before purge`,
        );
      }
      const { rows } = await database.executeSql(
        `SELECT dispatch_job_id, reconciliation_job_id, status
           FROM zukhruf_scheduled_runs
          WHERE task_id = $1 AND owner_id = $2`,
        [task.id, task.ownerId],
      );
      const runs = rows as Array<
        Pick<RunRow, 'dispatch_job_id' | 'reconciliation_job_id' | 'status'>
      >;
      if (
        runs.some(
          ({ status }) => status === 'dispatching' || status === 'running',
        )
      ) {
        throw new ScheduledTasksError(
          'conflict',
          'task',
          `Scheduled Task "${task.id}" has active runs`,
        );
      }
      const jobs = runs.flatMap(({ dispatch_job_id, reconciliation_job_id }) =>
        reconciliation_job_id
          ? [dispatch_job_id, reconciliation_job_id]
          : [dispatch_job_id],
      );
      if (jobs.length > 0)
        await this.#boss.cancel(this.#queue, jobs, { db: database });
      await database.executeSql(
        'DELETE FROM zukhruf_scheduled_tasks WHERE id = $1 AND owner_id = $2',
        [task.id, task.ownerId],
      );
    });
  }

  async cancelRun(
    ownerId: string,
    runId: string,
  ): Promise<ScheduledRun<ExecutionConfig>> {
    const run = await this.#requiredRun(this.#database, ownerId, runId, false);
    if (isTerminal(run.status)) return run;
    if (run.status === 'dispatching') {
      return this.#transaction(async (database) => {
        const current = await this.#requiredRun(database, ownerId, runId, true);
        if (current.status !== 'dispatching') return current;
        const row = await this.#runRow(
          database,
          current.id,
          current.ownerId,
          true,
        );
        if (!row)
          throw new Error(`Scheduled Run "${current.id}" was not found`);
        await this.#cancelJob(database, row.dispatch_job_id);
        return this.#finishCancelled(database, current);
      });
    }
    if (!run.externalExecutionId) {
      throw new ScheduledTasksError(
        'conflict',
        'run',
        `Scheduled Run "${run.id}" has no external execution`,
      );
    }
    await this.#executor.cancel({
      runId: run.id,
      ownerId: run.ownerId,
      executionId: run.externalExecutionId,
      executionConfig: run.executionConfig,
    });
    return this.#transaction(async (database) => {
      const current = await this.#requiredRun(database, ownerId, runId, true);
      if (current.status !== 'running') return current;
      const row = await this.#runRow(
        database,
        current.id,
        current.ownerId,
        true,
      );
      if (!row) throw new Error(`Scheduled Run "${current.id}" was not found`);
      if (row.reconciliation_job_id) {
        await this.#cancelJob(database, row.reconciliation_job_id);
      }
      return this.#finishCancelled(database, current);
    });
  }

  async markReviewed(
    ownerId: string,
    runId: string,
  ): Promise<ScheduledRun<ExecutionConfig>> {
    return this.#setReviewStatus(ownerId, runId, 'reviewed');
  }

  async archiveRun(
    ownerId: string,
    runId: string,
  ): Promise<ScheduledRun<ExecutionConfig>> {
    return this.#setReviewStatus(ownerId, runId, 'archived');
  }

  async work(options?: JobPollingOptions): Promise<AsyncDisposable> {
    const workOptions = { ...options, includeMetadata: true as const };
    const workerId = await this.#boss.work<
      ScheduledJob,
      void,
      { includeMetadata: true }
    >(
      this.#queue,
      workOptions,
      async (jobs: JobWithMetadata<ScheduledJob>[]) => {
        await Promise.all(jobs.map((job) => this.#handle(job)));
      },
    );
    return {
      [Symbol.asyncDispose]: () =>
        this.#boss.offWork(this.#queue, { id: workerId, wait: false }),
    };
  }

  async #handle(job: JobWithMetadata<ScheduledJob>): Promise<void> {
    const data = validateJob(job.data);
    if (data.kind === 'occurrence') {
      await this.#materialize(job.id, data);
    } else if (data.kind === 'dispatch') {
      await this.#dispatch(job.id, data);
    } else {
      await this.#reconcile(job, data);
    }
  }

  async #materialize(jobId: string, job: OccurrenceJob): Promise<void> {
    await this.#transaction(async (database) => {
      const row = await this.#taskRow(database, job.taskId, job.ownerId, true);
      if (
        !row ||
        row.status !== 'active' ||
        Number(row.generation) !== job.generation ||
        toMillis(row.next_run_at) !== job.occurrenceAt ||
        row.next_wake_id !== jobId
      ) {
        return;
      }
      const task = toTask<ExecutionConfig>(row);
      const now = Date.now();
      const runId = randomUUID();
      const dispatchJobId = await this.#sendNow(database, {
        kind: 'dispatch',
        ownerId: task.ownerId,
        runId,
      });
      const { rows } = await database.executeSql(
        `INSERT INTO zukhruf_scheduled_runs (
           id, task_id, owner_id, trigger, occurrence_at, prompt,
           execution_config, status, dispatch_job_id, created_at, updated_at
         ) VALUES (
           $1, $2, $3, 'scheduled', $4, $5, $6::jsonb,
           'dispatching', $7, $8, $8
         )
         ON CONFLICT (task_id, occurrence_at) WHERE trigger = 'scheduled'
         DO NOTHING
         RETURNING id`,
        [
          runId,
          task.id,
          task.ownerId,
          job.occurrenceAt,
          task.prompt,
          serializeExecutionConfig(task.executionConfig),
          dispatchJobId,
          now,
        ],
      );
      if (!rows[0]) await this.#cancelJob(database, dispatchJobId);

      const nextRunAt = nextOccurrence(
        task.recurrence,
        task.timezone,
        Math.max(job.occurrenceAt, now),
      );
      let nextWakeId: string | null = null;
      if (nextRunAt !== null) {
        nextWakeId = await this.#sendAt(
          database,
          {
            kind: 'occurrence',
            ownerId: task.ownerId,
            taskId: task.id,
            occurrenceAt: nextRunAt,
            generation: task.generation,
          },
          nextRunAt,
        );
      }
      await database.executeSql(
        `UPDATE zukhruf_scheduled_tasks
            SET status = $1, next_run_at = $2, next_wake_id = $3, updated_at = $4
          WHERE id = $5 AND owner_id = $6`,
        [
          nextRunAt === null ? 'completed' : 'active',
          nextRunAt,
          nextWakeId,
          now,
          task.id,
          task.ownerId,
        ],
      );
    });
  }

  async #dispatch(jobId: string, job: DispatchJob): Promise<void> {
    const row = await this.#runRow(
      this.#database,
      job.runId,
      job.ownerId,
      false,
    );
    if (!row || row.status !== 'dispatching' || row.dispatch_job_id !== jobId) {
      return;
    }
    const run = toRun<ExecutionConfig>(row);
    let executionId: string;
    try {
      const launched = await this.#executor.launch({
        runId: run.id,
        taskId: run.taskId,
        ownerId: run.ownerId,
        trigger: run.trigger,
        occurrenceAt: run.occurrenceAt,
        prompt: run.prompt,
        executionConfig: run.executionConfig,
      });
      executionId = required(
        launched.executionId,
        'Scheduled Run external execution id',
      );
    } catch (error) {
      await this.#transaction(async (database) => {
        const current = await this.#runRow(database, run.id, run.ownerId, true);
        if (
          !current ||
          current.status !== 'dispatching' ||
          current.dispatch_job_id !== jobId
        ) {
          return;
        }
        const now = Date.now();
        await database.executeSql(
          `UPDATE zukhruf_scheduled_runs
              SET status = 'failed', review_status = 'pending_review',
                  finished_at = $1, error = $2, updated_at = $1
            WHERE id = $3 AND owner_id = $4`,
          [now, errorMessage(error), run.id, run.ownerId],
        );
      });
      return;
    }

    const bound = await this.#transaction(async (database) => {
      const current = await this.#runRow(database, run.id, run.ownerId, true);
      if (
        !current ||
        current.status !== 'dispatching' ||
        current.dispatch_job_id !== jobId
      ) {
        return false;
      }
      const nextCheckAt = Date.now() + this.#reconciliationIntervalMs;
      const reconciliationJobId = await this.#sendAt(
        database,
        { kind: 'reconcile', ownerId: run.ownerId, runId: run.id },
        nextCheckAt,
      );
      await database.executeSql(
        `UPDATE zukhruf_scheduled_runs
            SET status = 'running', external_execution_id = $1,
                reconciliation_job_id = $2, next_check_at = $3,
                started_at = $4, updated_at = $4
          WHERE id = $5 AND owner_id = $6`,
        [
          executionId,
          reconciliationJobId,
          nextCheckAt,
          Date.now(),
          run.id,
          run.ownerId,
        ],
      );
      return true;
    });
    if (!bound) {
      await this.#executor.cancel({
        runId: run.id,
        ownerId: run.ownerId,
        executionId,
        executionConfig: run.executionConfig,
      });
    }
  }

  async #reconcile(
    job: JobWithMetadata<ScheduledJob>,
    data: ReconcileJob,
  ): Promise<void> {
    const row = await this.#runRow(
      this.#database,
      data.runId,
      data.ownerId,
      false,
    );
    if (
      !row ||
      row.status !== 'running' ||
      row.reconciliation_job_id !== job.id ||
      !row.external_execution_id
    ) {
      return;
    }
    const run = toRun<ExecutionConfig>(row);
    let observed: ScheduledExecutionObservation;
    try {
      observed = await this.#executor.inspect({
        runId: run.id,
        ownerId: run.ownerId,
        executionId: row.external_execution_id,
        executionConfig: run.executionConfig,
      });
    } catch (error) {
      if (job.retryCount < job.retryLimit) throw error;
      await this.#scheduleNextInspection(job.id, run);
      return;
    }

    if (observed.status === 'queued' || observed.status === 'running') {
      await this.#transaction(async (database) => {
        const current = await this.#runRow(database, run.id, run.ownerId, true);
        if (
          !current ||
          current.status !== 'running' ||
          current.reconciliation_job_id !== job.id
        ) {
          return;
        }
        const nextCheckAt = Date.now() + this.#reconciliationIntervalMs;
        const nextJobId = await this.#sendAt(
          database,
          { kind: 'reconcile', ownerId: run.ownerId, runId: run.id },
          nextCheckAt,
        );
        await database.executeSql(
          `UPDATE zukhruf_scheduled_runs
              SET reconciliation_job_id = $1, next_check_at = $2,
                  started_at = COALESCE(started_at, $3), updated_at = $4
            WHERE id = $5 AND owner_id = $6`,
          [
            nextJobId,
            nextCheckAt,
            observed.startedAt,
            Date.now(),
            run.id,
            run.ownerId,
          ],
        );
      });
      return;
    }

    const terminal = observed;
    await this.#transaction(async (database) => {
      const current = await this.#runRow(database, run.id, run.ownerId, true);
      if (
        !current ||
        current.status !== 'running' ||
        current.reconciliation_job_id !== job.id
      ) {
        return;
      }
      await database.executeSql(
        `UPDATE zukhruf_scheduled_runs
            SET status = $1, review_status = 'pending_review',
                reconciliation_job_id = NULL, next_check_at = NULL,
                started_at = COALESCE(started_at, $2), finished_at = $3,
                error = $4, title = $5, summary = $6, updated_at = $7
          WHERE id = $8 AND owner_id = $9`,
        [
          terminal.status,
          terminal.startedAt,
          terminal.finishedAt,
          terminal.error,
          terminal.title,
          terminal.summary,
          Date.now(),
          run.id,
          run.ownerId,
        ],
      );
    });
  }

  async #scheduleNextInspection(
    jobId: string,
    run: ScheduledRun<ExecutionConfig>,
  ): Promise<void> {
    await this.#transaction(async (database) => {
      const current = await this.#runRow(database, run.id, run.ownerId, true);
      if (
        !current ||
        current.status !== 'running' ||
        current.reconciliation_job_id !== jobId
      ) {
        return;
      }
      const nextCheckAt = Date.now() + this.#reconciliationIntervalMs;
      const nextJobId = await this.#sendAt(
        database,
        { kind: 'reconcile', ownerId: run.ownerId, runId: run.id },
        nextCheckAt,
      );
      await database.executeSql(
        `UPDATE zukhruf_scheduled_runs
            SET reconciliation_job_id = $1, next_check_at = $2, updated_at = $3
          WHERE id = $4 AND owner_id = $5`,
        [nextJobId, nextCheckAt, Date.now(), run.id, run.ownerId],
      );
    });
  }

  async #setReviewStatus(
    ownerId: string,
    runId: string,
    reviewStatus: 'reviewed' | 'archived',
  ): Promise<ScheduledRun<ExecutionConfig>> {
    return this.#transaction(async (database) => {
      const run = await this.#requiredRun(database, ownerId, runId, true);
      if (!isTerminal(run.status) || run.reviewStatus === null) {
        throw new ScheduledTasksError(
          'conflict',
          'run',
          `Scheduled Run "${run.id}" is not ready for review`,
        );
      }
      if (run.reviewStatus === 'archived') {
        if (reviewStatus === 'archived') return run;
        throw new ScheduledTasksError(
          'conflict',
          'run',
          `Scheduled Run "${run.id}" is archived`,
        );
      }
      const { rows } = await database.executeSql(
        `UPDATE zukhruf_scheduled_runs
            SET review_status = $1, updated_at = $2
          WHERE id = $3 AND owner_id = $4
          RETURNING *`,
        [reviewStatus, Date.now(), run.id, run.ownerId],
      );
      return toRun<ExecutionConfig>(requiredRow<RunRow>(rows, 'review'));
    });
  }

  async #finishCancelled(
    database: Db,
    run: ScheduledRun<ExecutionConfig>,
  ): Promise<ScheduledRun<ExecutionConfig>> {
    const now = Date.now();
    const { rows } = await database.executeSql(
      `UPDATE zukhruf_scheduled_runs
          SET status = 'cancelled', review_status = 'pending_review',
              reconciliation_job_id = NULL, next_check_at = NULL,
              finished_at = $1, updated_at = $1
        WHERE id = $2 AND owner_id = $3
        RETURNING *`,
      [now, run.id, run.ownerId],
    );
    return toRun<ExecutionConfig>(requiredRow<RunRow>(rows, 'cancel'));
  }

  async #sendNow(database: Db, data: ScheduledJob): Promise<string> {
    const id = await this.#boss.send(this.#queue, data, { db: database });
    if (!id) throw new Error('pg-boss did not persist Scheduled Tasks job');
    return id;
  }

  async #sendAt(
    database: Db,
    data: ScheduledJob,
    runAt: number,
  ): Promise<string> {
    const id = await this.#boss.sendAfter(
      this.#queue,
      data,
      { db: database },
      new Date(runAt),
    );
    if (!id) throw new Error('pg-boss did not persist Scheduled Tasks job');
    return id;
  }

  async #cancelJob(database: Db, id: string): Promise<void> {
    await this.#boss.cancel(this.#queue, id, { db: database });
  }

  async #requiredTask(
    database: Db,
    ownerId: string,
    taskId: string,
    forUpdate: boolean,
  ): Promise<ScheduledTask<ExecutionConfig>> {
    const row = await this.#taskRow(
      database,
      required(taskId, 'Scheduled Task id'),
      required(ownerId, 'Scheduled Task owner'),
      forUpdate,
    );
    if (!row) {
      throw new ScheduledTasksError(
        'not-found',
        'task',
        `Scheduled Task "${taskId}" was not found`,
      );
    }
    return toTask<ExecutionConfig>(row);
  }

  async #taskRow(
    database: Db,
    taskId: string,
    ownerId: string,
    forUpdate: boolean,
  ): Promise<TaskRow | undefined> {
    const { rows } = await database.executeSql(
      `SELECT * FROM zukhruf_scheduled_tasks
        WHERE id = $1 AND owner_id = $2${forUpdate ? ' FOR UPDATE' : ''}`,
      [taskId, ownerId],
    );
    return rows[0] as TaskRow | undefined;
  }

  async #taskByKey(
    database: Db,
    ownerId: string,
    idempotencyKey: string,
  ): Promise<ScheduledTask<ExecutionConfig> | undefined> {
    const { rows } = await database.executeSql(
      `SELECT * FROM zukhruf_scheduled_tasks
        WHERE owner_id = $1 AND idempotency_key = $2`,
      [ownerId, idempotencyKey],
    );
    const row = rows[0] as TaskRow | undefined;
    return row ? toTask<ExecutionConfig>(row) : undefined;
  }

  async #requiredRun(
    database: Db,
    ownerId: string,
    runId: string,
    forUpdate: boolean,
  ): Promise<ScheduledRun<ExecutionConfig>> {
    const row = await this.#runRow(
      database,
      required(runId, 'Scheduled Run id'),
      required(ownerId, 'Scheduled Task owner'),
      forUpdate,
    );
    if (!row) {
      throw new ScheduledTasksError(
        'not-found',
        'run',
        `Scheduled Run "${runId}" was not found`,
      );
    }
    return toRun<ExecutionConfig>(row);
  }

  async #runRow(
    database: Db,
    runId: string,
    ownerId: string,
    forUpdate: boolean,
  ): Promise<RunRow | undefined> {
    const { rows } = await database.executeSql(
      `SELECT * FROM zukhruf_scheduled_runs
        WHERE id = $1 AND owner_id = $2${forUpdate ? ' FOR UPDATE' : ''}`,
      [runId, ownerId],
    );
    return rows[0] as RunRow | undefined;
  }

  async #manualRun(
    database: Db,
    taskId: string,
    idempotencyKey: string,
  ): Promise<ScheduledRun<ExecutionConfig> | undefined> {
    const { rows } = await database.executeSql(
      `SELECT * FROM zukhruf_scheduled_runs
        WHERE task_id = $1 AND trigger = 'manual' AND idempotency_key = $2`,
      [taskId, idempotencyKey],
    );
    const row = rows[0] as RunRow | undefined;
    return row ? toRun<ExecutionConfig>(row) : undefined;
  }
}

function normalizeCreate<ExecutionConfig extends object>(
  input: CreateScheduledTaskInput<ExecutionConfig>,
) {
  const timezone = validateTimezone(input.timezone);
  const recurrence = required(input.recurrence, 'Scheduled Task recurrence');
  return {
    idempotencyKey: required(
      input.idempotencyKey,
      'Scheduled Task idempotency key',
    ),
    name: required(input.name, 'Scheduled Task name'),
    prompt: required(input.prompt, 'Scheduled Task prompt'),
    recurrence,
    timezone,
    executionConfig: input.executionConfig,
    executionConfigJson: serializeExecutionConfig(input.executionConfig),
  };
}

function serializeExecutionConfig(value: object): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ScheduledTasksError(
      'invalid-input',
      'task',
      'Scheduled Task execution config must be a JSON object',
    );
  }
  let json: string;
  try {
    json = JSON.stringify(value);
  } catch (error) {
    throw new ScheduledTasksError(
      'invalid-input',
      'task',
      'Scheduled Task execution config must be JSON',
      { cause: error },
    );
  }
  if (!json || !isDeepStrictEqual(JSON.parse(json), value)) {
    throw new ScheduledTasksError(
      'invalid-input',
      'task',
      'Scheduled Task execution config must be a JSON object',
    );
  }
  return json;
}

function assertSameTask<ExecutionConfig extends object>(
  task: ScheduledTask<ExecutionConfig>,
  input: ReturnType<typeof normalizeCreate<ExecutionConfig>>,
): void {
  if (
    task.name !== input.name ||
    task.prompt !== input.prompt ||
    task.recurrence !== input.recurrence ||
    task.timezone !== input.timezone ||
    !isDeepStrictEqual(task.executionConfig, input.executionConfig)
  ) {
    throw new ScheduledTasksError(
      'conflict',
      'task',
      'Scheduled Task idempotency key was reused',
    );
  }
}

function required(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} cannot be empty`);
  return normalized;
}

function validateTimezone(value: string): string {
  const timezone = required(value, 'Scheduled Task timezone');
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone }).format();
  } catch {
    throw new ScheduledTasksError(
      'invalid-input',
      'task',
      `Scheduled Task timezone "${timezone}" is invalid`,
    );
  }
  return timezone;
}

function nextOccurrence(
  source: string,
  timezone: string,
  after: number,
): number | null {
  const recurrence = required(source, 'Scheduled Task recurrence');
  const start = /^DTSTART(?:;TZID=([^:]+))?:(\S+)$/m.exec(recurrence);
  if (!start) {
    if (recurrence.split(/\s+/).length !== 5) {
      throw new ScheduledTasksError(
        'invalid-input',
        'task',
        'Scheduled Task recurrence must include DTSTART or contain exactly five cron fields',
      );
    }
    const endDate = new Date(after);
    endDate.setUTCFullYear(endDate.getUTCFullYear() + 1);
    try {
      return CronExpressionParser.parse(recurrence, {
        currentDate: new Date(after),
        endDate,
        tz: timezone,
      })
        .next()
        .getTime();
    } catch (cause) {
      throw new ScheduledTasksError(
        'invalid-input',
        'task',
        'Scheduled Task recurrence must be a valid five-field cron expression with a match in the next year',
        { cause },
      );
    }
  }
  const embeddedTimezone = start[1] ?? (start[2]?.endsWith('Z') ? 'UTC' : null);
  if (embeddedTimezone !== timezone) {
    throw new ScheduledTasksError(
      'invalid-input',
      'task',
      `Scheduled Task recurrence DTSTART timezone must be "${timezone}"`,
    );
  }
  let rule: ReturnType<typeof rrulestr>;
  try {
    rule = rrulestr(recurrence);
  } catch (error) {
    throw new ScheduledTasksError(
      'invalid-input',
      'task',
      'Scheduled Task recurrence is invalid',
      { cause: error },
    );
  }
  const cursor = new Date(after);
  const occurrence = rule.after(
    timezone === 'UTC' ? cursor : instantToLocalWallTime(cursor),
    false,
  );
  if (!occurrence) return null;
  return (
    timezone === 'UTC' ? occurrence : localWallTimeToInstant(occurrence)
  ).getTime();
}

/** `rrule` returns zoned wall time in the host timezone; persist true instants. */
function instantToLocalWallTime(instant: Date): Date {
  return new Date(
    Date.UTC(
      instant.getFullYear(),
      instant.getMonth(),
      instant.getDate(),
      instant.getHours(),
      instant.getMinutes(),
      instant.getSeconds(),
      instant.getMilliseconds(),
    ),
  );
}

function localWallTimeToInstant(wallTime: Date): Date {
  return new Date(
    wallTime.getUTCFullYear(),
    wallTime.getUTCMonth(),
    wallTime.getUTCDate(),
    wallTime.getUTCHours(),
    wallTime.getUTCMinutes(),
    wallTime.getUTCSeconds(),
    wallTime.getUTCMilliseconds(),
  );
}

function validateJob(value: unknown): ScheduledJob {
  if (!value || typeof value !== 'object') {
    throw new Error('Scheduled Tasks job payload must be an object');
  }
  const job = value as Partial<ScheduledJob>;
  if (
    (job.kind === 'dispatch' || job.kind === 'reconcile') &&
    typeof job.ownerId === 'string' &&
    typeof job.runId === 'string'
  ) {
    return job as DispatchJob | ReconcileJob;
  }
  if (
    job.kind === 'occurrence' &&
    typeof job.ownerId === 'string' &&
    typeof job.taskId === 'string' &&
    typeof job.occurrenceAt === 'number' &&
    typeof job.generation === 'number'
  ) {
    return job as OccurrenceJob;
  }
  throw new Error('Scheduled Tasks job payload is invalid');
}

type PersistedScheduledChange = {
  ownerId: string;
  change: Exclude<ScheduledChange, { type: 'reset' }>;
};

function parseScheduledChange(
  payload: string,
): PersistedScheduledChange | undefined {
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch {
    return undefined;
  }
  if (
    typeof value !== 'object' ||
    value === null ||
    !('resource' in value) ||
    !('ownerId' in value) ||
    !('id' in value) ||
    typeof value.ownerId !== 'string' ||
    typeof value.id !== 'string'
  ) {
    return undefined;
  }
  if (value.resource === 'schedule-task') {
    return {
      ownerId: value.ownerId,
      change: { type: 'change', resource: value.resource, id: value.id },
    };
  }
  if (
    value.resource === 'schedule-run' &&
    'taskId' in value &&
    typeof value.taskId === 'string'
  ) {
    return {
      ownerId: value.ownerId,
      change: {
        type: 'change',
        resource: value.resource,
        id: value.id,
        taskId: value.taskId,
      },
    };
  }
  return undefined;
}

function toTask<ExecutionConfig extends object>(
  row: TaskRow,
): ScheduledTask<ExecutionConfig> {
  return {
    id: row.id,
    ownerId: row.owner_id,
    idempotencyKey: row.idempotency_key,
    name: row.name,
    prompt: row.prompt,
    recurrence: row.recurrence,
    timezone: row.timezone,
    executionConfig: row.execution_config as ExecutionConfig,
    status: row.status,
    generation: Number(row.generation),
    nextRunAt: toMillis(row.next_run_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    archivedAt: toMillis(row.archived_at),
  };
}

function toRun<ExecutionConfig extends object>(
  row: RunRow,
): ScheduledRun<ExecutionConfig> {
  return {
    id: row.id,
    taskId: row.task_id,
    ownerId: row.owner_id,
    trigger: row.trigger,
    occurrenceAt: Number(row.occurrence_at),
    prompt: row.prompt,
    executionConfig: row.execution_config as ExecutionConfig,
    status: row.status,
    reviewStatus: row.review_status,
    externalExecutionId: row.external_execution_id,
    startedAt: toMillis(row.started_at),
    finishedAt: toMillis(row.finished_at),
    title: row.title,
    summary: row.summary,
    error: row.error,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function toMillis(value: number | string | bigint | null): number | null {
  return value === null ? null : Number(value);
}

function requiredRow<Row>(rows: unknown[], operation: string): Row {
  const row = rows[0] as Row | undefined;
  if (!row)
    throw new Error(`Scheduled Tasks ${operation} did not return a row`);
  return row;
}

function isTerminal(status: ScheduledRunStatus): boolean {
  return (
    status === 'completed' || status === 'failed' || status === 'cancelled'
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
