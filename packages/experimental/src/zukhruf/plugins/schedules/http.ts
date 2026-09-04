import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import { validate as validateUuid } from 'uuid';
import z from 'zod';

import type { AgentPluginDefinition } from '../../runtime/agent-runtime.ts';
import {
  type HttpEnv,
  type HttpProjection,
  projectHttp,
} from '../http/index.ts';
import { validate } from '../http/validator.ts';
import type {
  ScheduleExecutionConfig,
  ScheduleTarget,
  Schedules,
} from './index.ts';
import type {
  ScheduledRun,
  ScheduledRunReviewStatus,
  ScheduledRunStatus,
  ScheduledTask,
  ScheduledTaskStatus,
  ScheduledTasksError,
} from './scheduled-tasks.ts';

const SCHEDULES_PATH = '/schedules';
const TASKS_PATH = `${SCHEDULES_PATH}/tasks`;
const TASK_PATH = `${TASKS_PATH}/:taskId`;
const TASK_RUNS_PATH = `${TASK_PATH}/runs`;
const RUNS_PATH = `${SCHEDULES_PATH}/runs`;
const INBOX_PATH = `${RUNS_PATH}/inbox`;
const RUN_PATH = `${RUNS_PATH}/:runId`;

const MAX_BODY_BYTES = 10 * 1024;
const MAX_NAME_LENGTH = 200;
const MAX_PROMPT_LENGTH = 8_000;
const MAX_RECURRENCE_LENGTH = 1_000;
const MAX_TIMEZONE_LENGTH = 100;
const MAX_CHAT_ID_LENGTH = 200;
const MAX_IDEMPOTENCY_KEY_LENGTH = 200;
const NO_STORE = { 'cache-control': 'no-store' } as const;

/** Browser-safe Scheduled Task projection. Owner and scheduler bookkeeping stay server-side. */
export interface ScheduledTaskView {
  id: string;
  name: string;
  prompt: string;
  recurrence: string;
  timezone: string;
  target: ScheduleTarget;
  status: ScheduledTaskStatus;
  nextRunAt: number | null;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
}

/** Browser-safe Scheduled Run projection with its exact conversation reference. */
export interface ScheduledRunView {
  id: string;
  taskId: string;
  trigger: 'scheduled' | 'manual';
  occurrenceAt: number;
  prompt: string;
  target: ScheduleTarget;
  status: ScheduledRunStatus;
  reviewStatus: ScheduledRunReviewStatus | null;
  conversation: { chatId: string; turnId: string } | null;
  startedAt: number | null;
  finishedAt: number | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

const scheduleIdSchema = z.string().refine(validateUuid);
const idempotencyKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_IDEMPOTENCY_KEY_LENGTH);
const targetSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('new-conversation') }),
  z.strictObject({
    kind: z.literal('existing-conversation'),
    chatId: z.string().trim().min(1).max(MAX_CHAT_ID_LENGTH),
  }),
]);
const definitionSchema = {
  name: z.string().trim().min(1).max(MAX_NAME_LENGTH),
  prompt: z.string().trim().min(1).max(MAX_PROMPT_LENGTH),
  recurrence: z.string().trim().min(1).max(MAX_RECURRENCE_LENGTH),
  timezone: z.string().trim().min(1).max(MAX_TIMEZONE_LENGTH),
  target: targetSchema,
};
const createBodySchema = z.strictObject(definitionSchema);
const updateBodySchema = z
  .strictObject({
    name: definitionSchema.name.optional(),
    prompt: definitionSchema.prompt.optional(),
    recurrence: definitionSchema.recurrence.optional(),
    timezone: definitionSchema.timezone.optional(),
    target: targetSchema.optional(),
  })
  .refine((body) => Object.values(body).some((value) => value !== undefined), {
    message: 'At least one field must be provided',
  });

const limitBody = bodyLimit({
  maxSize: MAX_BODY_BYTES,
  onError: () => {
    throw new HTTPException(413, {
      message: 'Request body is too large',
      cause: {
        code: 'api/payload-too-large',
        detail: `Request body exceeds ${MAX_BODY_BYTES} bytes`,
      },
    });
  },
});

/**
 * Optional Scheduled Tasks capability bound to one `schedules()` definition.
 * Compose with `http(runtime, schedulesHttp(scheduled))`; omitting it removes
 * the capability from discovery so DevTool hides Scheduled navigation.
 */
export function schedulesHttp(
  definition: AgentPluginDefinition<Schedules>,
): HttpProjection {
  return projectHttp(definition, (plugin) => ({
    capabilities: { schedules: { path: SCHEDULES_PATH } },
    authenticatedRoutes: scheduleRoutes(plugin),
    events: (userId, signal) => plugin.subscribeChanges(userId, signal),
  }));
}

function scheduleRoutes(schedules: Schedules) {
  const app = new Hono<HttpEnv>();

  app.get(TASKS_PATH, async (context) =>
    context.json(
      (await domain(schedules.list(context.get('userId')))).map(toTaskView),
      200,
      NO_STORE,
    ),
  );
  app.post(
    TASKS_PATH,
    limitBody,
    validate('application/json', (payload) => ({
      body: { select: payload.body, against: createBodySchema },
      idempotencyKey: {
        select: payload.headers['idempotency-key'],
        against: idempotencyKeySchema,
      },
    })),
    async (context) => {
      const { body, idempotencyKey } = context.var.input;
      const task = await domain(
        schedules.create(context.get('userId'), {
          idempotencyKey,
          name: body.name,
          prompt: body.prompt,
          recurrence: body.recurrence,
          timezone: body.timezone,
          executionConfig: toExecutionConfig(body.target),
        }),
      );
      return context.json(toTaskView(task), 200, NO_STORE);
    },
  );
  app.all(TASKS_PATH, (context) => methodNotAllowed(context, 'GET, POST'));

  app.get(TASK_RUNS_PATH, taskIdInput, async (context) =>
    context.json(
      (
        await domain(
          schedules.listRuns(context.get('userId'), context.var.input.taskId),
        )
      ).map(toRunView),
      200,
      NO_STORE,
    ),
  );
  app.all(TASK_RUNS_PATH, (context) => methodNotAllowed(context, 'GET'));

  for (const [action, operation] of [
    ['pause', schedules.pause],
    ['resume', schedules.resume],
    ['archive', schedules.archive],
  ] as const) {
    const path = `${TASK_PATH}/${action}`;
    app.post(path, taskIdInput, async (context) =>
      context.json(
        toTaskView(
          await domain(
            operation.call(
              schedules,
              context.get('userId'),
              context.var.input.taskId,
            ),
          ),
        ),
        200,
        NO_STORE,
      ),
    );
    app.all(path, (context) => methodNotAllowed(context, 'POST'));
  }

  app.post(
    `${TASK_PATH}/run`,
    validate((payload) => ({
      taskId: { select: payload.params.taskId, against: scheduleIdSchema },
      idempotencyKey: {
        select: payload.headers['idempotency-key'],
        against: idempotencyKeySchema,
      },
    })),
    async (context) => {
      const { idempotencyKey, taskId } = context.var.input;
      const run = await domain(
        schedules.runNow(context.get('userId'), taskId, idempotencyKey),
      );
      return context.json(toRunView(run), 202, NO_STORE);
    },
  );
  app.all(`${TASK_PATH}/run`, (context) => methodNotAllowed(context, 'POST'));

  app.get(TASK_PATH, taskIdInput, async (context) =>
    context.json(
      toTaskView(
        await domain(
          schedules.get(context.get('userId'), context.var.input.taskId),
        ),
      ),
      200,
      NO_STORE,
    ),
  );
  app.patch(
    TASK_PATH,
    limitBody,
    validate('application/json', (payload) => ({
      body: { select: payload.body, against: updateBodySchema },
      taskId: { select: payload.params.taskId, against: scheduleIdSchema },
    })),
    async (context) => {
      const { body, taskId } = context.var.input;
      const task = await domain(
        schedules.update(context.get('userId'), taskId, {
          name: body.name,
          prompt: body.prompt,
          recurrence: body.recurrence,
          timezone: body.timezone,
          executionConfig: body.target && toExecutionConfig(body.target),
        }),
      );
      return context.json(toTaskView(task), 200, NO_STORE);
    },
  );
  app.delete(TASK_PATH, taskIdInput, async (context) => {
    await domain(
      schedules.purge(context.get('userId'), context.var.input.taskId),
    );
    return context.body(null, 204, NO_STORE);
  });
  app.all(TASK_PATH, (context) =>
    methodNotAllowed(context, 'GET, PATCH, DELETE'),
  );

  app.get(INBOX_PATH, async (context) =>
    context.json(
      (await domain(schedules.listPendingReview(context.get('userId')))).map(
        toRunView,
      ),
      200,
      NO_STORE,
    ),
  );
  app.all(INBOX_PATH, (context) => methodNotAllowed(context, 'GET'));

  for (const [action, operation] of [
    ['cancel', schedules.cancelRun],
    ['review', schedules.markReviewed],
  ] as const) {
    const path = `${RUN_PATH}/${action}`;
    app.post(path, runIdInput, async (context) =>
      context.json(
        toRunView(
          await domain(
            operation.call(
              schedules,
              context.get('userId'),
              context.var.input.runId,
            ),
          ),
        ),
        200,
        NO_STORE,
      ),
    );
    app.all(path, (context) => methodNotAllowed(context, 'POST'));
  }

  app.get(RUN_PATH, runIdInput, async (context) =>
    context.json(
      toRunView(
        await domain(
          schedules.getRun(context.get('userId'), context.var.input.runId),
        ),
      ),
      200,
      NO_STORE,
    ),
  );
  app.all(RUN_PATH, (context) => methodNotAllowed(context, 'GET'));

  return app;
}

const taskIdInput = validate((payload) => ({
  taskId: { select: payload.params.taskId, against: scheduleIdSchema },
}));

const runIdInput = validate((payload) => ({
  runId: { select: payload.params.runId, against: scheduleIdSchema },
}));

function toExecutionConfig(target: ScheduleTarget): ScheduleExecutionConfig {
  return target.kind === 'new-conversation' ? {} : { target };
}

function toTaskView(
  task: ScheduledTask<ScheduleExecutionConfig>,
): ScheduledTaskView {
  return {
    id: task.id,
    name: task.name,
    prompt: task.prompt,
    recurrence: task.recurrence,
    timezone: task.timezone,
    target: viewTarget(task.executionConfig),
    status: task.status,
    nextRunAt: task.nextRunAt,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    archivedAt: task.archivedAt,
  };
}

function toRunView(
  run: ScheduledRun<ScheduleExecutionConfig>,
): ScheduledRunView {
  const target = viewTarget(run.executionConfig);
  return {
    id: run.id,
    taskId: run.taskId,
    trigger: run.trigger,
    occurrenceAt: run.occurrenceAt,
    prompt: run.prompt,
    target,
    status: run.status,
    reviewStatus: run.reviewStatus,
    conversation: run.externalExecutionId
      ? {
          chatId:
            target.kind === 'existing-conversation' ? target.chatId : run.id,
          turnId: run.externalExecutionId,
        }
      : null,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    error: run.error,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  };
}

function viewTarget(config: ScheduleExecutionConfig): ScheduleTarget {
  return config.target ?? { kind: 'new-conversation' };
}

/** Hono resolves handler errors at the innermost dispatch frame, so every
 * domain call converts its own rejection instead of relying on middleware. */
function domain<T>(result: Promise<T>): Promise<T> {
  return result.catch(rethrowAsHttp);
}

/**
 * `name` rather than `instanceof`: this subpath is its own build entry point, so
 * a value import of the domain would bundle a second copy of the class and every
 * `instanceof` check against it would fail.
 */
function asScheduledTasksError(
  error: unknown,
): ScheduledTasksError | undefined {
  return error instanceof Error && error.name === 'ScheduledTasksError'
    ? (error as ScheduledTasksError)
    : undefined;
}

function rethrowAsHttp(cause: unknown): never {
  const error = asScheduledTasksError(cause);
  if (!error) throw cause;
  if (error.code === 'not-found') {
    throw new HTTPException(404, {
      message: 'Scheduled resource not found',
      cause: {
        code: 'schedules/not-found',
        detail: 'The requested scheduled resource does not exist',
      },
    });
  }
  throw new HTTPException(error.code === 'invalid-input' ? 400 : 409, {
    message: error.message,
    cause: {
      code: `schedules/${error.code}`,
      detail: error.message,
      resource: error.resource,
    },
  });
}

function methodNotAllowed(
  context: { header(name: string, value: string): void },
  allow: string,
): never {
  context.header('Allow', allow);
  throw new HTTPException(405, {
    message: 'Method not allowed',
    cause: {
      code: 'api/method-not-allowed',
      detail: `This endpoint only accepts ${allow} requests`,
    },
  });
}
